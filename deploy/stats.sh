#!/usr/bin/env bash
# Mesure d'usage de maillage.tuatam.fr : affichages de l'encart (par commune et site d'origine),
# clics vers l'itinéraire, ouvertures de l'application par compte.
# Usage : ./deploy/stats.sh [jours]   (défaut : 30 derniers jours)
set -euo pipefail
CONF="$(cd "$(dirname "$0")" && pwd)/config.sh"
[[ -f "$CONF" ]] || { echo "Configuration absente : copier deploy/config.exemple.sh en deploy/config.sh" >&2; exit 1; }
. "$CONF"
HOST="$VPS_HOST"
KEY="$VPS_KEY"
ssh -i "$KEY" -o BatchMode=yes "$HOST" "cat /srv/sites/maillage/logs/usage.log 2>/dev/null || true" \
  | python3 -I "$(dirname "$0")/stats.py" --days "${1:-30}"
