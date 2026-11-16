#!/usr/bin/env bash
# Mesure d'usage de maillage.tuatam.fr : affichages de l'encart (par commune et site d'origine),
# clics vers l'itinéraire, ouvertures de l'application par compte.
# Usage : ./deploy/stats.sh [jours]   (défaut : 30 derniers jours)
set -euo pipefail
HOST="ubuntu@vps-4075b317.vps.ovh.net"
KEY="$HOME/.ssh/id_ed25519_ovh_almanach"
ssh -i "$KEY" -o BatchMode=yes "$HOST" "cat /srv/sites/maillage/logs/usage.log 2>/dev/null || true" \
  | python3 -I "$(dirname "$0")/stats.py" --days "${1:-30}"
