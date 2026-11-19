#!/usr/bin/env bash
# Publie Maillage sur le VPS OVH (maillage.tuatam.fr). Le VPS construit et publie lui-même le site
# (deploy/vps/publier.sh) : ce script lui envoie le code puis lance la publication et affiche le journal.
#
#   ./deploy/deploy-vps.sh            code : envoie l'état de travail (même non commité) et republie le site
#                                     avec les données en ligne ; si le pipeline a changé, met aussi à jour les données
#   ./deploy/deploy-vps.sh --donnees  idem + mise à jour forcée des horaires (≈ 10-30 min)
#   ./deploy/deploy-vps.sh --retour   remet en ligne les données de la publication précédente
#   ./deploy/deploy-vps.sh --config   met aussi à jour compose.yml / compose.domain.yml / nginx.conf et relance le conteneur
#
# L'état de travail est envoyé comme un commit temporaire (« git commit-tree ») : ni la branche locale
# ni GitLab ne changent. Les données ne partent plus du Mac : public/data n'est que la copie de développement.
# Première installation sur le VPS : deploy/vps/installer.sh
set -euo pipefail
HOST="ubuntu@vps-4075b317.vps.ovh.net"
KEY="$HOME/.ssh/id_ed25519_ovh_almanach"
DIR="/srv/sites/maillage"
SRC="$(cd "$(dirname "$0")/.." && pwd)"
SSH=(ssh -i "$KEY" -o BatchMode=yes "$HOST")
MODE="${1:-}"

CONFIG=0; [[ "$MODE" == "--config" ]] && { CONFIG=1; MODE=""; }
case "$MODE" in
  "") UNIT=maillage-publication ;;
  --donnees) UNIT=maillage-maj-donnees ;;
  --retour) UNIT=maillage-retour ;;
  *) echo "usage : $0 [--donnees|--retour|--config]" >&2; exit 1 ;;
esac

if [[ "$UNIT" != maillage-retour ]]; then
  # instantané de l'état de travail (fichiers suivis et nouveaux, hors .gitignore) sans toucher à l'index ni à la branche
  cd "$(git -C "$SRC" rev-parse --show-toplevel)"
  idx=$(mktemp); cp "$(git rev-parse --git-path index)" "$idx"
  GIT_INDEX_FILE="$idx" git add -A
  tree=$(GIT_INDEX_FILE="$idx" git write-tree); rm -f "$idx"
  if [[ "$tree" == "$(git rev-parse 'HEAD^{tree}')" ]]; then rev=$(git rev-parse HEAD); etat="commit $(git rev-parse --short HEAD)"
  else rev=$(git commit-tree "$tree" -p HEAD -m "Publication depuis le Mac (état de travail non commité)"); etat="état de travail non commité (sur $(git rev-parse --short HEAD))"
  fi
  GIT_SSH_COMMAND="ssh -i $KEY -o BatchMode=yes" git push -q --force "ssh://$HOST$DIR/depot.git" "$rev:refs/heads/main"
  echo "Code envoyé au VPS : $etat"
fi

if [[ $CONFIG == 1 ]]; then
  # --inplace : nginx.conf est monté seul dans le conteneur, qui suit l'inode du fichier (un remplacement ne serait pas vu)
  rsync -az --inplace -e "ssh -i $KEY -o BatchMode=yes" "$SRC/deploy/compose.yml" "$SRC/deploy/compose.domain.yml" "$SRC/deploy/nginx.conf" "$HOST:$DIR/"
  # sans fichier de comptes, le montage Docker échouerait : on crée un fichier vide (nginx refuse alors tout accès)
  # copie de travail à jour avant la construction des conteneurs (le service « mairie » est construit depuis le dépôt)
  "${SSH[@]}" "cd $DIR/depot && git fetch -q origin && git reset -q --hard origin/main"
  "${SSH[@]}" "mkdir -p $DIR/espace $DIR/contenus && { [ -f $DIR/espace/comptes.json ] || echo '{\"comptes\": []}' > $DIR/espace/comptes.json; }"
  "${SSH[@]}" "[ -f $DIR/private/htpasswd ] || { sudo touch $DIR/private/htpasswd; sudo chown root:101 $DIR/private/htpasswd; sudo chmod 640 $DIR/private/htpasswd; }"
  if [[ "$(dig +short maillage.tuatam.fr A | tail -1)" == "57.129.163.124" ]]; then
    "${SSH[@]}" "cd $DIR && sudo docker compose -f compose.yml -f compose.domain.yml up -d --build"
  else
    echo "DNS pas encore pointé : conteneur lancé sans domaine"
    "${SSH[@]}" "cd $DIR && sudo docker compose -f compose.yml up -d --build"
  fi
  "${SSH[@]}" "sudo docker exec maillage-web nginx -t && sudo docker exec maillage-web nginx -s reload"
fi

debut=$(date +%s)
echo "Publication sur le VPS ($UNIT)…"
if "${SSH[@]}" "sudo systemctl start $UNIT"; then ok=1; else ok=0; fi
"${SSH[@]}" "journalctl -u $UNIT --since @$debut -o cat --no-pager | grep -v '^\$' | tail -40"
if [[ $ok == 1 ]]; then echo "Publié : https://maillage.tuatam.fr/ (accès privé)"; else echo "ÉCHEC : le site en ligne n'a pas changé (journal ci-dessus)" >&2; exit 1; fi
