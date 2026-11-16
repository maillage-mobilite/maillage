#!/usr/bin/env bash
# Publie le démonstrateur sur le VPS OVH (maillage.tuatam.fr, accès privé) : build Vite → /srv/sites/maillage/site/
# Usage : ./deploy/deploy-vps.sh            (build + publication du site)
#         ./deploy/deploy-vps.sh --config   (met aussi à jour compose.yml / compose.domain.yml / nginx.conf et relance le conteneur)
# Les données (public/data) sont publiées telles quelles : lancer « npm run data » avant pour les rafraîchir.
set -euo pipefail
HOST="ubuntu@vps-4075b317.vps.ovh.net"
KEY="$HOME/.ssh/id_ed25519_ovh_almanach"
DIR="/srv/sites/maillage"
SRC="$(cd "$(dirname "$0")/.." && pwd)"
SSH=(ssh -i "$KEY" -o BatchMode=yes "$HOST")

( cd "$SRC" && npm run build )

"${SSH[@]}" "sudo mkdir -p $DIR/site $DIR/private && sudo chown ubuntu:ubuntu $DIR $DIR/site"
rsync -az --delete -e "ssh -i $KEY -o BatchMode=yes" "$SRC/dist/" "$HOST:$DIR/site/"

if [[ "${1:-}" == "--config" ]]; then
  rsync -az -e "ssh -i $KEY -o BatchMode=yes" "$SRC/deploy/compose.yml" "$SRC/deploy/compose.domain.yml" "$SRC/deploy/nginx.conf" "$HOST:$DIR/"
  # sans fichier de comptes, le montage Docker échouerait : on crée un fichier vide (nginx refuse alors tout accès)
  "${SSH[@]}" "[ -f $DIR/private/htpasswd ] || { sudo touch $DIR/private/htpasswd; sudo chown root:101 $DIR/private/htpasswd; sudo chmod 640 $DIR/private/htpasswd; }"
  if [[ "$(dig +short maillage.tuatam.fr A | tail -1)" == "57.129.163.124" ]]; then
    "${SSH[@]}" "cd $DIR && sudo docker compose -f compose.yml -f compose.domain.yml up -d"
  else
    echo "DNS pas encore pointé : conteneur lancé sans domaine"
    "${SSH[@]}" "cd $DIR && sudo docker compose -f compose.yml up -d"
  fi
fi
echo "Publié : https://maillage.tuatam.fr/ (accès privé)"
