#!/usr/bin/env bash
# Moteur OSRM local pour le recalage des tracés (profil « bus »).
#
#   pipeline/osrm/osrm.sh prepare   # télécharge l'extrait OSM et prépare le graphe (une fois, ~10-20 min)
#   pipeline/osrm/osrm.sh start     # lance le serveur sur http://localhost:5055 (5000 est pris par AirPlay sur macOS)
#   pipeline/osrm/osrm.sh prepare-rail   # graphe des voies ferrées (tracés des TER)
#   pipeline/osrm/osrm.sh start-rail     # serveur rail sur http://localhost:5056
#   pipeline/osrm/osrm.sh prepare-genf   # graphe bus de la région genevoise (Pays de Gex + Genève, extrait BBBike)
#   pipeline/osrm/osrm.sh start-genf     # serveur sur http://localhost:5057
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
    docker rm -f "$NAME" "$NAME-rail" "$NAME-genf" 2>/dev/null || true
    ;;
  prepare-rail)
    # même extrait OSM, profil « rail » (voies ferrées) ; lien physique pour un graphe nommé à part
    [ -f "$DATA/rhone-alpes.osm.pbf" ] || curl -L --retry 3 -o "$DATA/rhone-alpes.osm.pbf" "$PBF_URL"
    ln -f "$DATA/rhone-alpes.osm.pbf" "$DATA/rhone-alpes-rail.osm.pbf"
    cp pipeline/osrm/rail.lua "$DATA/rail.lua"
    docker run --rm -t -v "$DATA:/data" "$IMAGE" osrm-extract -p /data/rail.lua /data/rhone-alpes-rail.osm.pbf
    docker run --rm -t -v "$DATA:/data" "$IMAGE" osrm-partition /data/rhone-alpes-rail.osrm
    docker run --rm -t -v "$DATA:/data" "$IMAGE" osrm-customize /data/rhone-alpes-rail.osrm
    ;;
  start-rail)
    docker rm -f "$NAME-rail" >/dev/null 2>&1 || true
    docker run -d --name "$NAME-rail" -p 5056:5000 -v "$DATA:/data" "$IMAGE" \
      osrm-routed --algorithm mld --max-viaroute-size 2000 /data/rhone-alpes-rail.osrm
    echo "OSRM rail : http://localhost:5056"
    ;;
  prepare-genf)
    # l'extrait Rhône-Alpes s'arrête à la frontière : les lignes TPG du Pays de Gex finissent à Genève
    # (aéroport, Cornavin, Meyrin). Extrait BBBike « Genf » : 5,92–6,52 E × 46,02–46,48 N (~65 Mo).
    [ -f "$DATA/genf.osm.pbf" ] || curl -L --retry 3 -A "maillage-pipeline/0.1" -o "$DATA/genf.osm.pbf" https://download.bbbike.org/osm/bbbike/Genf/Genf.osm.pbf
    cp pipeline/osrm/bus.lua "$DATA/bus.lua"
    docker run --rm -t -v "$DATA:/data" "$IMAGE" osrm-extract -p /data/bus.lua /data/genf.osm.pbf
    docker run --rm -t -v "$DATA:/data" "$IMAGE" osrm-partition /data/genf.osrm
    docker run --rm -t -v "$DATA:/data" "$IMAGE" osrm-customize /data/genf.osrm
    ;;
  start-genf)
    docker rm -f "$NAME-genf" >/dev/null 2>&1 || true
    docker run -d --name "$NAME-genf" -p 5057:5000 -v "$DATA:/data" "$IMAGE" \
      osrm-routed --algorithm mld --max-matching-size 2000 --max-viaroute-size 2000 /data/genf.osrm
    echo "OSRM Genève : http://localhost:5057"
    ;;
  *)
    echo "usage : $0 prepare|start|prepare-rail|start-rail|prepare-genf|start-genf|stop" >&2; exit 1 ;;
esac
