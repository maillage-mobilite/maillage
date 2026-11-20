#!/usr/bin/env python3
"""Lieux utiles du territoire (mairies, écoles, santé, équipements, commerces…) depuis OpenStreetMap.

Lit <datadir>/network.json (emprise du réseau, arrêts), interroge l'API Overpass et écrit <datadir>/pois.json :
  {"version": 1, "generated_at", "source", "categories": [{id, label, color}],
   "pois": [[nom, catégorie, type, commune, lat, lon, {horaires, tel, web, fauteuil}], …]}
Ne garde que les lieux à moins de RADIUS_M d'un arrêt du réseau : ce sont des destinations atteignables.

Usage : python3 -I pipeline/build_pois.py public/data/paysdegex --cache .cache
Données © contributeurs OpenStreetMap, ODbL.
"""
import argparse
import datetime as dt
import json
import math
import os
import shutil
import subprocess
import sys
import time
import urllib.parse
import urllib.request

OVERPASS = "https://overpass-api.de/api/interpreter"
RADIUS_M = 1000
CACHE_DAYS = 7

# catégorie → (libellé, couleur sur la carte)
CATEGORIES = {
    "services": ("Mairie et services publics", "#7c3aed"),
    "education": ("Écoles et formation", "#d97706"),
    "sante": ("Santé", "#dc2626"),
    "loisirs": ("Culture, sport et loisirs", "#059669"),
    "commerces": ("Commerces et marchés", "#0284c7"),
    "dechets": ("Déchetteries", "#6b7280"),
    "transport": ("Aéroports", "#1e3a8a"),
}

# (clé, valeur) OSM → (catégorie, type affiché, nom par défaut si le lieu n'en a pas ; None = nom obligatoire)
TYPES = {
    ("amenity", "townhall"): ("services", "Mairie", "Mairie"),
    ("amenity", "post_office"): ("services", "Bureau de poste", "Bureau de poste"),
    ("amenity", "police"): ("services", "Police, gendarmerie", None),
    ("amenity", "courthouse"): ("services", "Tribunal", None),
    ("amenity", "school"): ("education", "École, collège, lycée", None),
    ("amenity", "kindergarten"): ("education", "Crèche, maternelle", None),
    ("amenity", "college"): ("education", "Formation", None),
    ("amenity", "university"): ("education", "Université", None),
    ("amenity", "hospital"): ("sante", "Hôpital", None),
    ("amenity", "clinic"): ("sante", "Clinique, centre de santé", None),
    ("healthcare", "centre"): ("sante", "Centre de santé", None),
    ("amenity", "pharmacy"): ("sante", "Pharmacie", "Pharmacie"),
    ("amenity", "library"): ("loisirs", "Médiathèque, bibliothèque", "Bibliothèque"),
    ("amenity", "theatre"): ("loisirs", "Théâtre", None),
    ("amenity", "cinema"): ("loisirs", "Cinéma", None),
    ("amenity", "arts_centre"): ("loisirs", "Centre culturel", None),
    ("amenity", "community_centre"): ("loisirs", "Salle, maison de quartier", None),
    ("leisure", "sports_centre"): ("loisirs", "Équipement sportif", None),
    ("leisure", "swimming_pool"): ("loisirs", "Piscine", None),
    ("leisure", "stadium"): ("loisirs", "Stade", None),
    ("shop", "supermarket"): ("commerces", "Supermarché", None),
    ("shop", "mall"): ("commerces", "Centre commercial", None),
    ("amenity", "marketplace"): ("commerces", "Marché", "Marché"),
    ("amenity", "recycling"): ("dechets", "Déchetterie", "Déchetterie"),
    ("aeroway", "aerodrome"): ("transport", "Aéroport", None),
}


def log(msg):
    print(f"[lieux] {msg}", file=sys.stderr)


def haversine(a_lat, a_lon, b_lat, b_lon):
    r = 6371000
    p1, p2 = math.radians(a_lat), math.radians(b_lat)
    dp, dl = p2 - p1, math.radians(b_lon - a_lon)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


def overpass(query, cache_path):
    if os.path.exists(cache_path) and time.time() - os.path.getmtime(cache_path) < CACHE_DAYS * 86400:
        log(f"cache {cache_path}")
        with open(cache_path, encoding="utf-8") as fh:
            return json.load(fh)
    body = urllib.parse.urlencode({"data": query}).encode()
    try:
        req = urllib.request.Request(OVERPASS, data=body, headers={"User-Agent": "maillage-pipeline/0.1"})  # sans client nommé : 406
        with urllib.request.urlopen(req, timeout=300) as r:
            raw = r.read()
    except Exception as e:
        # Python installé depuis python.org sans certificats racine (macOS) : repli sur curl
        if "CERTIFICATE_VERIFY_FAILED" not in str(e) or not shutil.which("curl"):
            raise
        raw = subprocess.run(["curl", "-fsS", "--retry", "3", "--retry-all-errors", "-A", "maillage-pipeline/0.1",
                              "--data-urlencode", f"data={query}", OVERPASS], capture_output=True, check=True, timeout=400).stdout
    data = json.loads(raw)
    os.makedirs(os.path.dirname(cache_path), exist_ok=True)
    with open(cache_path, "w", encoding="utf-8") as fh:
        json.dump(data, fh)
    return data


def osm_communes(points, bbox, cache_dir, tenant):
    """Commune (limite administrative OSM de niveau 8, France comme Suisse) de chaque point.
    Une requête pour les contours des communes de l'emprise, puis test « point dans polygone » local
    (règle pair-impair sur l'ensemble des segments du contour : pas besoin de reconstituer les anneaux).
    Renvoie une liste alignée sur points (None si hors de toute commune connue)."""
    data = overpass(f"[out:json][timeout:240];rel[boundary=administrative][admin_level=8]({bbox});out geom;",
                    os.path.join(cache_dir, f"osm-communes-{tenant}.json"))
    shapes = []
    for rel in data["elements"]:
        segs = []
        for mem in rel.get("members", []):
            if mem.get("type") == "way" and mem.get("role") in ("outer", "inner", "") and mem.get("geometry"):
                g = mem["geometry"]
                segs.extend((g[i]["lat"], g[i]["lon"], g[i + 1]["lat"], g[i + 1]["lon"]) for i in range(len(g) - 1))
        if segs:
            name = rel.get("tags", {}).get("name:fr") or rel.get("tags", {}).get("name")
            la = [s[0] for s in segs] + [s[2] for s in segs]
            lo = [s[1] for s in segs] + [s[3] for s in segs]
            shapes.append((name, min(la), max(la), min(lo), max(lo), segs))
    log(f"{len(shapes)} communes dans l'emprise")

    def inside(la, lo, segs):
        c = False
        for a_la, a_lo, b_la, b_lo in segs:
            if (a_la > la) != (b_la > la) and lo < a_lo + (la - a_la) * (b_lo - a_lo) / (b_la - a_la):
                c = not c
        return c

    out = []
    for la, lo in points:
        out.append(next((n for n, la0, la1, lo0, lo1, segs in shapes
                         if la0 <= la <= la1 and lo0 <= lo <= lo1 and inside(la, lo, segs)), None))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("datadir")
    ap.add_argument("--cache", default=".cache")
    args = ap.parse_args()

    with open(os.path.join(args.datadir, "network.json"), encoding="utf-8") as fh:
        net = json.load(fh)
    tenant = net["tenant"]["tenant"]
    # pôles d'arrêt du réseau local ([nom, lat, lon, flux]) : les arrêts des seuls cars Région ou trains,
    # parfois à 50 km (Annecy, Bellegarde), élargiraient l'emprise sans apporter de destinations de proximité
    LOCAL = {"urbain", "tad", "scolaire"}
    kind_of = {f["id"]: f["kind"] for f in net.get("feeds", [])}  # identifiant de flux → type de ligne
    places = [(p[0], p[1], p[2]) for p in net["places"] if LOCAL & {kind_of.get(f, f) for f in p[3]}]
    lats, lons = [p[1] for p in places], [p[2] for p in places]
    m = 0.012
    bbox = f"{min(lats) - m},{min(lons) - m},{max(lats) + m},{max(lons) + m}"

    keys = sorted({k for k, _ in TYPES})
    parts = []
    for k in keys:
        vals = "|".join(sorted(v for kk, v in TYPES if kk == k))
        parts.append(f'nwr["{k}"~"^({vals})$"]({bbox});')
    query = f"[out:json][timeout:240];({''.join(parts)});out center tags;"
    data = overpass(query, os.path.join(args.cache, f"osm-pois-{tenant}.json"))
    log(f"{len(data['elements'])} objets OSM dans l'emprise {bbox}")

    # grille simple pour la distance au plus proche arrêt
    cell = 0.01
    grid = {}
    for i, (_, la, lo) in enumerate(places):
        grid.setdefault((int(la / cell), int(lo / cell)), []).append(i)

    def nearest(la, lo):
        best, bd = None, 1e18
        gi, gj = int(la / cell), int(lo / cell)
        for di in (-1, 0, 1):
            for dj in (-1, 0, 1):
                for i in grid.get((gi + di, gj + dj), ()):
                    d = haversine(la, lo, places[i][1], places[i][2])
                    if d < bd:
                        best, bd = i, d
        return best, bd

    out, seen = [], []
    skipped = {"sans nom": 0, "loin du réseau": 0, "privé": 0, "doublon": 0}
    for el in data["elements"]:
        tags = el.get("tags", {})
        la = el.get("lat", el.get("center", {}).get("lat"))
        lo = el.get("lon", el.get("center", {}).get("lon"))
        if la is None:
            continue
        typ = next((TYPES[(k, tags[k])] for k in keys if (k, tags.get(k)) in TYPES), None)
        if not typ:
            continue
        cat, label, default = typ
        if tags.get("access") in ("private", "no") or "disused" in tags.get("lifecycle", ""):
            skipped["privé"] += 1
            continue
        if cat == "dechets" and tags.get("recycling_type") != "centre":
            continue
        if cat == "transport" and not tags.get("iata"):
            continue
        name = tags.get("name:fr") or tags.get("name") or default
        if not name:
            skipped["sans nom"] += 1
            continue
        if name == default and cat == "services" and tags.get("addr:city"):
            name = f"{default} de {tags['addr:city']}"
        pi, d = nearest(la, lo)
        if pi is None or d > RADIUS_M:
            skipped["loin du réseau"] += 1
            continue
        # même nom, même catégorie, à moins de 150 m : un seul lieu (point et bâtiment saisis tous les deux)
        if any(s[0] == name and s[1] == cat and haversine(la, lo, s[2], s[3]) < 150 for s in seen):
            skipped["doublon"] += 1
            continue
        seen.append((name, cat, la, lo))
        stop_name = places[pi][0]
        commune = stop_name.split(",")[0].strip() if "," in stop_name else (tags.get("addr:city") or "")
        extra = {}
        if tags.get("opening_hours"):
            extra["h"] = tags["opening_hours"][:200]
        if tags.get("phone") or tags.get("contact:phone"):
            extra["t"] = (tags.get("phone") or tags.get("contact:phone"))[:40]
        web = tags.get("website") or tags.get("contact:website")
        if web and web.startswith(("http://", "https://")):
            extra["w"] = web[:200]
        if tags.get("wheelchair") in ("yes", "limited", "no"):
            extra["a"] = tags["wheelchair"]
        out.append([name, cat, label, commune, round(la, 6), round(lo, 6), extra])

    # commune : limites administratives OSM (l'arrêt le plus proche porte parfois le nom d'un hameau
    # plutôt que celui de la commune) ; à défaut, nom de l'arrêt le plus proche
    try:
        communes = osm_communes([(p[4], p[5]) for p in out], bbox, args.cache, tenant)
        for p, c in zip(out, communes):
            if c:
                p[3] = c
        log(f"communes OSM : {sum(1 for c in communes if c)} / {len(out)}")
    except Exception as e:
        log(f"limites communales indisponibles ({e}) : communes déduites des arrêts")

    out.sort(key=lambda p: (p[1], p[3], p[0]))
    used = {p[1] for p in out}
    doc = {
        "version": 1,
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "source": "© contributeurs OpenStreetMap (ODbL)",
        "categories": [{"id": k, "label": v[0], "color": v[1]} for k, v in CATEGORIES.items() if k in used],
        "pois": out,
    }
    path = os.path.join(args.datadir, "pois.json")
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, ensure_ascii=False, separators=(",", ":"))
    by = {}
    for p in out:
        by[p[1]] = by.get(p[1], 0) + 1
    print(f"[lieux] {tenant} : {len(out)} lieux ({', '.join(f'{k} {v}' for k, v in sorted(by.items()))}) ; "
          f"écartés : {', '.join(f'{k} {v}' for k, v in skipped.items())} → {path} ({os.path.getsize(path) // 1024} Ko)")


if __name__ == "__main__":
    main()
