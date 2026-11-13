#!/usr/bin/env bash
# Moteur OSRM local pour le recalage des tracés (profil « bus »).
#
#   pipeline/osrm/osrm.sh prepare   # télécharge l'extrait OSM et prépare le graphe (une fois, ~10-20 min)
#   pipeline/osrm/osrm.sh start     # lance le serveur sur http://localhost:5055 (5000 est pris par AirPlay sur macOS)
#   pipeline/osrm/osrm.sh stop
#
# Nécessite Docker. Données dans .cache/osrm (non versionné).
set -euo pipefail
cd "$(dirname "$0")/../.."
IMAGE=ghcr.io/project-osrm/osrm-backend:latest
DATA="$PWD/.cache/osrm"
PBF_URL="${PBF_URL:-https://download.geofabrik.de/europe/france/rhone-alpes-latest.osm.pbf}"
NAME=maillage-osrm
mkdir -p "$DATA"

case "${1:-}" in
  prepare)
    [ -f "$DATA/rhone-alpes.osm.pbf" ] || curl -L --retry 3 -o "$DATA/rhone-alpes.osm.pbf" "$PBF_URL"
    cp pipeline/osrm/bus.lua "$DATA/bus.lua"
    docker run --rm -t -v "$DATA:/data" "$IMAGE" osrm-extract -p /data/bus.lua /data/rhone-alpes.osm.pbf
    docker run --rm -t -v "$DATA:/data" "$IMAGE" osrm-partition /data/rhone-alpes.osrm
    docker run --rm -t -v "$DATA:/data" "$IMAGE" osrm-customize /data/rhone-alpes.osrm
    ;;
  start)
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    docker run -d --name "$NAME" -p 5055:5000 -v "$DATA:/data" "$IMAGE" \
      osrm-routed --algorithm mld --max-matching-size 2000 --max-viaroute-size 2000 /data/rhone-alpes.osrm
    echo "OSRM : http://localhost:5055"
    ;;
  stop)
    docker rm -f "$NAME"
    ;;
  *)
    echo "usage : $0 prepare|start|stop" >&2; exit 1 ;;
esac
