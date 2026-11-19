#!/usr/bin/env bash
# Installe (ou met à jour) la publication automatique de Maillage sur le VPS. À lancer depuis le Mac :
#   demonstrateur/deploy/vps/installer.sh <adresse e-mail des alertes>
# Idempotent. Copie les graphes OSRM et les caches du pipeline (préparés sur le Mac : la préparation du graphe
# Rhône-Alpes demande plus de mémoire que n'en a le VPS), crée le dépôt nu et la copie de travail,
# installe les unités systemd. N'active PAS le minuteur : à faire après une première publication réussie
# (sudo systemctl enable --now maillage-donnees.timer).
set -euo pipefail
CONF="$(cd "$(dirname "$0")" && pwd)/../config.sh"
[[ -f "$CONF" ]] || { echo "Configuration absente : copier deploy/config.exemple.sh en deploy/config.sh" >&2; exit 1; }
. "$CONF"
HOST="$VPS_HOST"
KEY="$VPS_KEY"
BASE=/srv/sites/maillage
APP="$(cd "$(dirname "$0")/../.." && pwd)"
SSH=(ssh -i "$KEY" -o BatchMode=yes "$HOST")
RSYNC=(rsync -az -e "ssh -i $KEY -o BatchMode=yes")
DEST="${1:-}"

"${SSH[@]}" "set -e; cd $BASE
  [ -d depot.git ] || git init -q --bare -b main depot.git
  mkdir -p cache/osrm"
# code : poussé dans le dépôt nu du VPS (le VPS n'a pas besoin d'accès à GitLab)
# (état de travail, même non commité, comme deploy-vps.sh)
( cd "$(git -C "$APP" rev-parse --show-toplevel)"
  idx=$(mktemp); cp "$(git rev-parse --git-path index)" "$idx"
  GIT_INDEX_FILE="$idx" git add -A; tree=$(GIT_INDEX_FILE="$idx" git write-tree); rm -f "$idx"
  rev=$(git rev-parse HEAD); [[ "$tree" == "$(git rev-parse 'HEAD^{tree}')" ]] || rev=$(git commit-tree "$tree" -p HEAD -m "Installation depuis le Mac (état de travail)")
  GIT_SSH_COMMAND="ssh -i $KEY -o BatchMode=yes" git push -q --force "ssh://$HOST$BASE/depot.git" "$rev:refs/heads/main" )
"${SSH[@]}" "set -e; cd $BASE
  [ -d depot ] || git clone -q depot.git depot
  git -C depot fetch -q origin && git -C depot reset -q --hard origin/main
  ln -sfn $BASE/cache depot/demonstrateur/.cache"
# graphes OSRM (sans les extraits .pbf) et caches du pipeline (tracés recalés, lieux OSM…) ; les flux GTFS sont retéléchargés
"${RSYNC[@]}" --include='*.osrm*' --exclude='*' "$APP/.cache/osrm/" "$HOST:$BASE/cache/osrm/"
"${RSYNC[@]}" --include='*.json' --include='*.geojson' --exclude='*.meta.json' --exclude='*' "$APP/.cache/" "$HOST:$BASE/cache/"
if [ -n "$DEST" ]; then
  "${SSH[@]}" "sudo mkdir -p $BASE/private && echo '$DEST' | sudo tee $BASE/private/alerte.conf >/dev/null && sudo chmod 600 $BASE/private/alerte.conf"
fi
"${SSH[@]}" "set -e; sudo test -s $BASE/private/alerte.conf || { echo 'adresse des alertes absente : relancer avec l adresse en argument' >&2; exit 1; }
  sudo cp $BASE/depot/demonstrateur/deploy/vps/maillage-*.service $BASE/depot/demonstrateur/deploy/vps/maillage-*.timer /etc/systemd/system/
  sudo systemctl daemon-reload
  echo 'Unités installées :'; ls /etc/systemd/system/maillage-*"
echo "Première publication : ssh … 'sudo systemctl start maillage-maj-donnees' (puis activer le minuteur)"
