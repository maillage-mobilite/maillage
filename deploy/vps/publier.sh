#!/bin/sh
# Publication de Maillage sur le VPS : le VPS est le SEUL à construire et publier le site.
#
#   publier.sh              code seul : reconstruit le site avec les données déjà en ligne
#                           (bascule d'elle-même en mise à jour des données si le pipeline a changé)
#   publier.sh --donnees    met à jour les horaires (téléchargement des flux, tracés, lieux, encarts)
#   publier.sh --quotidien  tâche du matin : met à jour les données si un flux a publié une nouvelle
#                           version, si la dernière mise à jour date de 7 jours ou si le pipeline a changé ;
#                           puis vérifie qu'aucun flux n'expire bientôt (échec → e-mail)
#   publier.sh --retour     revient aux données de la publication précédente
#
# Lancé par systemd (deploy/vps/*.service ; journal : journalctl -u maillage-publication -u maillage-donnees)
# ou depuis le Mac par deploy/deploy-vps.sh. Chaque étape est contrôlée AVANT de toucher au site en ligne :
# contrôle des données (pipeline/controle_publication.py), tests du calculateur, build. En cas d'échec,
# le site et les données en ligne restent tels quels et systemd envoie un e-mail (maillage-alerte@).
#
# Arborescence (BASE=/srv/sites/maillage) :
#   depot.git/  dépôt nu, alimenté par « git push vps » depuis le Mac
#   depot/      copie de travail (jamais modifiée à la main) ; depot/demonstrateur/.cache → ../../cache
#   cache/      graphes OSRM (préparés sur le Mac) et caches du pipeline
#   donnees/    données en ligne · donnees.prec/ : publication précédente (--retour)
#   donnees.pipeline  version du pipeline des données en ligne (sa date = dernière mise à jour)
#   a-signaler.txt    changements de la dernière mise à jour, envoyés par e-mail puis effacés (alerte.sh)
#   site/       servi par nginx (conteneur maillage-web)
set -eu
BASE="${BASE:-/srv/sites/maillage}"
DEPOT="$BASE/depot"
APP="$DEPOT/demonstrateur"
NODE_IMAGE="${NODE_IMAGE:-node:22-bookworm}"
# même image que celle qui a préparé les graphes sur le Mac (format des fichiers .osrm)
OSRM_IMAGE="${OSRM_IMAGE:-ghcr.io/project-osrm/osrm-backend@sha256:e1929ae2818226284d7ef007329098a30851c11528ab3712bc9c8d68da78278b}"
MODE="${1:-code}"
h() { date "+%Y-%m-%d %H:%M:%S"; }
log() { echo "[$(h)] $*"; }

# Le pull peut modifier ce script pendant qu'il s'exécute : on se relance une fois sur la version à jour
if [ -z "${MAILLAGE_A_JOUR:-}" ]; then
  exec 9>"$BASE/.publication.lock"
  flock -w 3600 9 || { echo "une autre publication est en cours" >&2; exit 1; }
  log "Début ($MODE)"
  cd "$DEPOT"
  git fetch -q origin
  git reset -q --hard origin/main
  MAILLAGE_A_JOUR=1 exec "$APP/deploy/vps/publier.sh" "$@"
fi

cd "$APP"
commit=$(git rev-parse --short HEAD)
# empreinte du CONTENU du pipeline (code, configuration des territoires, corrections de tracés, encarts) :
# ne change pas d'un envoi à l'autre tant que ces fichiers ne changent pas
pipeline=$(git rev-parse --short HEAD:demonstrateur/pipeline)
TRAVAIL="$BASE/travail"
rm -rf "$TRAVAIL"; mkdir -p "$TRAVAIL"

if [ "$MODE" = "--quotidien" ]; then
  raison=""
  if [ ! -f "$BASE/donnees.pipeline" ]; then raison="première mise à jour"
  elif [ "$(cat "$BASE/donnees.pipeline")" != "$pipeline" ]; then raison="pipeline modifié"
  elif [ -n "$(find "$BASE/donnees.pipeline" -mtime +6)" ]; then raison="dernière mise à jour il y a 7 jours"
  else
    rc=0; python3 -I pipeline/check_data.py "$BASE/donnees" --nouveautes > "$TRAVAIL/nouveautes.txt" || rc=$?
    cat "$TRAVAIL/nouveautes.txt"
    [ "$rc" = 3 ] && raison="nouvelle version publiée"
  fi
  if [ -n "$raison" ]; then
    log "Mise à jour des données : $raison"
    MODE=--donnees
  else
    log "Données à jour, rien à publier"
    MODE=aucun
  fi
elif [ "$MODE" = "code" ] && [ "$(cat "$BASE/donnees.pipeline" 2>/dev/null)" != "$pipeline" ]; then
  log "Le pipeline a changé depuis la dernière mise à jour des données : mise à jour complète"
  MODE=--donnees
fi

if [ "$MODE" != "aucun" ]; then
  # point de départ : données en ligne (ou précédentes pour --retour ; ou celles du dépôt la première fois)
  SRC="$BASE/donnees"
  [ "$MODE" = "--retour" ] && SRC="$BASE/donnees.prec"
  [ -d "$SRC" ] || { [ "$MODE" = "--retour" ] && { echo "aucune publication précédente" >&2; exit 1; }; SRC="$APP/public/data"; }
  cp -a "$SRC" "$TRAVAIL/data"

  if [ "$MODE" = "--donnees" ]; then
    arreter_osrm() { docker rm -f maillage-osrm-bus maillage-osrm-rail maillage-osrm-genf >/dev/null 2>&1 || true; }
    trap arreter_osrm EXIT
    arreter_osrm
    # moteurs de calcul d'itinéraires, le temps de la mise à jour seulement (≈ 1,2 Go de mémoire)
    for m in bus:5055:rhone-alpes rail:5056:rhone-alpes-rail genf:5057:genf; do
      n=${m%%:*}; r=${m#*:}; port=${r%%:*}; graphe=${r#*:}
      docker run -d --rm --name "maillage-osrm-$n" -p "127.0.0.1:$port:5000" -v "$BASE/cache/osrm:/data:ro" "$OSRM_IMAGE" \
        osrm-routed --algorithm mld --max-matching-size 2000 --max-viaroute-size 2000 "/data/$graphe.osrm" >/dev/null
    done
    for port in 5055 5056 5057; do
      k=0; until curl -fs "http://127.0.0.1:$port/nearest/v1/driving/6.1,46.2" >/dev/null; do
        k=$((k + 1)); [ $k -gt 90 ] && { echo "moteur OSRM $port injoignable" >&2; exit 1; }; sleep 2
      done
    done
    log "Moteurs OSRM prêts"
    for cfg in pipeline/tenants/*.json; do
      case "$cfg" in *-corrections.json|*.fares.json) continue ;; esac
      t=$(basename "$cfg" .json)
      log "Territoire $t"
      python3 -I pipeline/build_network.py "$cfg" --cache .cache --out "$TRAVAIL/data/$t"
      python3 -I pipeline/build_pois.py "$TRAVAIL/data/$t" --cache .cache
    done
    python3 -I pipeline/build_encarts.py "$TRAVAIL/data"
    arreter_osrm
  fi

  log "Contrôle des données"
  ONLINE="$BASE/donnees"; [ -d "$ONLINE" ] || ONLINE=""
  python3 -I pipeline/controle_publication.py "$TRAVAIL/data" $ONLINE --changements "$TRAVAIL/changements.txt"

  log "Tests du calculateur et construction du site ($commit)"
  # les données à publier remplacent public/data dans le conteneur (le dépôt n'est pas modifié)
  docker run --rm -u "$(id -u):$(id -g)" \
    -v "$DEPOT:/app" -v "$TRAVAIL/data:/app/demonstrateur/public/data:ro" -w /app/demonstrateur \
    -e HOME=/tmp -e npm_config_cache=/app/demonstrateur/.npm "$NODE_IMAGE" sh -ec '
      npm ci --no-audit --no-fund --loglevel=error
      npm run -s test:router > /tmp/test-router.log || { tail -40 /tmp/test-router.log; exit 1; }
      tail -1 /tmp/test-router.log
      npm run -s build > /tmp/build.log 2>&1 || { tail -40 /tmp/build.log; exit 1; }
    '
  [ -s dist/index.html ] && [ -s dist/widget.html ] && [ -s dist/data/tenants.json ] || { echo "site construit incomplet" >&2; exit 1; }

  # --delay-updates : les fichiers changés n'apparaissent qu'en fin de copie (jamais de site à moitié publié)
  rsync -rl --delete --delay-updates --checksum dist/ "$BASE/site/"
  log "Site publié ($commit)"

  case "$MODE" in
    --donnees)
      rm -rf "$BASE/donnees.prec"
      [ -d "$BASE/donnees" ] && mv "$BASE/donnees" "$BASE/donnees.prec"
      mv "$TRAVAIL/data" "$BASE/donnees"
      printf '%s\n' "$pipeline" > "$BASE/donnees.pipeline"
      if [ -s "$TRAVAIL/changements.txt" ]; then cp "$TRAVAIL/changements.txt" "$BASE/a-signaler.txt"; fi
      log "Nouvelles données en ligne (précédentes gardées pour « publier.sh --retour »)" ;;
    --retour)
      mv "$BASE/donnees" "$BASE/donnees.annulees" && mv "$BASE/donnees.prec" "$BASE/donnees" && mv "$BASE/donnees.annulees" "$BASE/donnees.prec"
      log "Données précédentes remises en ligne" ;;
    *)
      [ -d "$BASE/donnees" ] || mv "$TRAVAIL/data" "$BASE/donnees" ;;
  esac
  printf '{"date": "%s", "mode": "%s", "commit": "%s", "pipeline": "%s"}\n' "$(h)" "$MODE" "$commit" "$pipeline" > "$BASE/etat.json"
fi

# espace mairie : le code est monté depuis le dépôt, on relance le service quand il a changé
mairie=$(git rev-parse --short HEAD:demonstrateur/mairie 2>/dev/null || true)
if [ -n "$mairie" ] && [ "$(cat "$BASE/mairie.version" 2>/dev/null)" != "$mairie" ] && [ -n "$(docker ps -q -f name=^maillage-mairie$)" ]; then
  log "Espace mairie modifié : redémarrage du service"
  (cd "$BASE" && docker compose -f compose.yml -f compose.domain.yml up -d --build --quiet-pull mairie)
  printf '%s\n' "$mairie" > "$BASE/mairie.version"
fi

if [ "${1:-}" = "--quotidien" ]; then
  # flux qui expirent sans nouvelle version, fenêtre d'horaires trop courte : échec → e-mail
  log "Contrôle des échéances"
  python3 -I pipeline/check_data.py "$BASE/donnees" --days 21 --offline
fi
log "Terminé"
