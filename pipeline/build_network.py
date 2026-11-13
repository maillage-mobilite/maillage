#!/usr/bin/env python3
"""
Pipeline de données Maillage (démonstrateur).

Lit la configuration d'un territoire (tenants/<id>.json), télécharge les GTFS
déclarés, les valide/corrige, réconcilie les arrêts entre flux et produit un
fichier compact `network.json` + `lines.geojson` consommés par l'application.

Aucune dépendance externe : bibliothèque standard Python uniquement.

Usage :
    python3 -I pipeline/build_network.py pipeline/tenants/coqueligo.json \
        --cache .cache --out public/data [--today 2026-11-13]
"""
import argparse, csv, datetime as dt, io, json, math, os, re, shutil, subprocess, sys, time, urllib.error, urllib.request, zipfile
from collections import Counter, defaultdict
from difflib import SequenceMatcher

# ---------------------------------------------------------------- utilitaires

def log(*a):
    print("[pipeline]", *a, file=sys.stderr, flush=True)

def haversine(lat1, lon1, lat2, lon2):
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = p2 - p1
    dl = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))

def parse_time(t):
    if not t:
        return None
    h, m, s = t.strip().split(":")
    return int(h) * 3600 + int(m) * 60 + int(s)

def parse_date(s):
    return dt.date(int(s[:4]), int(s[4:6]), int(s[6:8]))

SMALL = {"de", "du", "des", "la", "le", "les", "lès", "les", "et", "sur", "en", "d", "l", "à", "au", "aux"}

def nice_case(segment):
    """Met en casse lisible un segment entièrement en majuscules."""
    letters = [c for c in segment if c.isalpha()]
    if not letters or not all(c.isupper() for c in letters):
        return segment
    out = []
    for i, w in enumerate(re.split(r"(\s+|-|')", segment.lower())):
        if w and w.isalpha() and (i == 0 or w not in SMALL):
            w = w[0].upper() + w[1:]
        out.append(w)
    s = "".join(out)
    return s[0].upper() + s[1:] if s else s

def nice_name(name):
    name = re.sub(r"\s+", " ", name.replace("–", "-")).strip()
    name = re.sub(r"\s*-\s+|\s+-\s*", " - ", name)
    return " - ".join(nice_case(p) for p in name.split(" - "))

def norm_key(name):
    s = name.lower()
    for a, b in (("é", "e"), ("è", "e"), ("ê", "e"), ("à", "a"), ("â", "a"), ("ô", "o"), ("î", "i"), ("ç", "c"), ("û", "u"), ("ù", "u")):
        s = s.replace(a, b)
    s = re.sub(r"^(annonay|st|saint)[\w\s'-]*? - ", "", s)  # préfixe commune
    s = re.sub(r"[^a-z0-9 ]", " ", s)
    s = re.sub(r"\b(st)\b", "saint", s)
    return re.sub(r"\s+", " ", s).strip()

def luminance(hex6):
    def ch(v):
        v /= 255
        return v / 12.92 if v <= 0.03928 else ((v + 0.055) / 1.055) ** 2.4
    r, g, b = (int(hex6[i:i + 2], 16) for i in (0, 2, 4))
    return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b)

def contrast(a, b):
    la, lb = sorted((luminance(a), luminance(b)), reverse=True)
    return (la + 0.05) / (lb + 0.05)

def best_text(bg):
    return "FFFFFF" if contrast(bg, "FFFFFF") >= contrast(bg, "111111") else "111111"

def simplify(points, tol_m=8.0):
    """Douglas-Peucker en mètres (approximation équirectangulaire locale)."""
    if len(points) < 3:
        return points
    lat0 = math.radians(points[0][1])
    xy = [(p[0] * 111320 * math.cos(lat0), p[1] * 110540) for p in points]
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        i, j = stack.pop()
        (x1, y1), (x2, y2) = xy[i], xy[j]
        dx, dy = x2 - x1, y2 - y1
        L = math.hypot(dx, dy) or 1e-9
        best, idx = 0.0, -1
        for k in range(i + 1, j):
            x0, y0 = xy[k]
            d = abs(dy * x0 - dx * y0 + x2 * y1 - y2 * x1) / L
            if d > best:
                best, idx = d, k
        if best > tol_m and idx > 0:
            keep[idx] = True
            stack += [(i, idx), (idx, j)]
    return [p for p, k in zip(points, keep) if k]

# ---------------------------------------------------------------- lecture GTFS

class Gtfs:
    def __init__(self, path):
        self.z = zipfile.ZipFile(path)
        self.names = {os.path.basename(n): n for n in self.z.namelist()}

    def has(self, f):
        return f in self.names

    def rows(self, f):
        if f not in self.names:
            return
        with self.z.open(self.names[f]) as raw:
            yield from csv.DictReader(io.TextIOWrapper(raw, encoding="utf-8-sig", newline=""))

def download(url, dest, max_age_h=12):
    if os.path.exists(dest) and time.time() - os.path.getmtime(dest) < max_age_h * 3600:
        meta = json.load(open(dest + ".meta.json")) if os.path.exists(dest + ".meta.json") else {}
        return meta
    log("téléchargement", url)
    req = urllib.request.Request(url, headers={"User-Agent": "maillage-pipeline/0.1"})
    try:
        with urllib.request.urlopen(req, timeout=600) as r, open(dest + ".part", "wb") as fh:
            while True:
                chunk = r.read(1 << 20)
                if not chunk:
                    break
                fh.write(chunk)
            meta = {"last_modified": r.headers.get("Last-Modified"), "final_url": r.geturl()}
    except urllib.error.URLError as e:
        # Python installé depuis python.org sans certificats racine (macOS) : repli sur curl,
        # qui utilise le magasin de certificats du système.
        if "CERTIFICATE_VERIFY_FAILED" not in str(e) or not shutil.which("curl"):
            raise
        log("  certificats Python indisponibles, repli sur curl")
        out = subprocess.run(["curl", "-fsSL", "--retry", "4", "--retry-all-errors", "-A", "maillage-pipeline/0.1", "-D", "-", "-o", dest + ".part", url],
                             check=True, capture_output=True, text=True).stdout
        lm = [l.split(":", 1)[1].strip() for l in out.splitlines() if l.lower().startswith("last-modified:")]
        meta = {"last_modified": lm[-1] if lm else None, "final_url": url}
    os.replace(dest + ".part", dest)
    json.dump(meta, open(dest + ".meta.json", "w"))
    return meta


# ---------------------------------------------------------------- recalage des tracés sur la voirie

def fetch_json(url):
    """GET JSON, avec repli sur curl si Python n'a pas de certificats racine (macOS)."""
    req = urllib.request.Request(url, headers={"User-Agent": "maillage-pipeline/0.1"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.load(r)
    except urllib.error.URLError as e:
        if "CERTIFICATE_VERIFY_FAILED" not in str(e) or not shutil.which("curl"):
            raise
        out = subprocess.run(["curl", "-fsSL", "--retry", "3", "--retry-all-errors", "-A", "maillage-pipeline/0.1", url],
                             check=True, capture_output=True, text=True).stdout
        return json.loads(out)

def straight_share(coords, gap_m=600):
    """Part de la longueur d'un tracé faite de segments droits de plus de gap_m."""
    segs = [haversine(coords[i][1], coords[i][0], coords[i + 1][1], coords[i + 1][0]) for i in range(len(coords) - 1)]
    total = sum(segs) or 1
    return sum(x for x in segs if x > gap_m) / total

def snap_to_roads(feats, cache_path, osrm_url, min_gap_m=250, max_ratio=2.2, min_share=0.3):
    """
    Remplace les suites de segments droits (> min_gap_m) par l'itinéraire routier OSRM
    passant par les mêmes points. Les flux sans vrai tracé (TAD, certaines lignes scolaires
    et régionales) deviennent ainsi lisibles. Garde-fou : si la route fait plus de max_ratio
    fois la ligne droite, on garde la ligne droite. Résultats mis en cache.
    """
    cache = json.load(open(cache_path)) if os.path.exists(cache_path) else {}
    def d(a, b):
        return haversine(a[1], a[0], b[1], b[0])
    requests_done, snapped_feats, kept = 0, 0, 0
    for f in feats:
        if f["properties"].get("kind") == "train":
            continue  # une voie ferrée ne suit pas les routes
        c = [tuple(x) for x in f["geometry"]["coordinates"]]
        # seuls les tracés majoritairement « en ligne droite » (flux sans vrai tracé) sont recalés :
        # un tracé réel simplifié contient légitimement de longs segments sur route rectiligne
        length_km = sum(haversine(c[i][1], c[i][0], c[i + 1][1], c[i + 1][0]) for i in range(len(c) - 1)) / 1000
        sparse = len(c) / max(length_km, 0.1) < 4  # un vrai tracé compte au moins ~5 points/km
        if straight_share(c) < min_share and not sparse:
            continue
        out, i, changed = [c[0]], 0, False
        while i < len(c) - 1:
            if d(c[i], c[i + 1]) <= min_gap_m:
                out.append(c[i + 1]); i += 1; continue
            j = i
            while j < len(c) - 1 and d(c[j], c[j + 1]) > min_gap_m:
                j += 1
            run = c[i:j + 1]
            routed = []
            for k in range(0, len(run) - 1, 24):  # 25 points max par requête
                chunk = run[k:k + 25]
                key = ";".join(f"{x:.5f},{y:.5f}" for x, y in chunk)
                if key not in cache:
                    try:
                        res = fetch_json(f"{osrm_url}/route/v1/driving/{key}?overview=full&geometries=geojson&continue_straight=false")
                        rt = res["routes"][0] if res.get("code") == "Ok" else None
                        cache[key] = {"coords": rt["geometry"]["coordinates"], "dist": rt["distance"]} if rt else None
                    except Exception as e:  # service indisponible : on garde la ligne droite
                        log(f"  OSRM indisponible ({e}) : segment laissé droit")
                        cache[key] = None
                    requests_done += 1
                    time.sleep(1.05)  # politique d'usage du serveur de démonstration
                    if requests_done % 20 == 0:
                        log(f"  recalage : {requests_done} requêtes…")
                        json.dump(cache, open(cache_path, "w"))
                hit = cache[key]
                straight = sum(d(chunk[m], chunk[m + 1]) for m in range(len(chunk) - 1))
                if hit and hit["dist"] <= max_ratio * straight + 500:
                    routed += [tuple(x) for x in hit["coords"]]
                else:
                    routed += chunk
                    kept += 1
            out += routed[1:] if routed else run[1:]
            changed = changed or bool(routed)
            i = j
        if changed:
            f["geometry"]["coordinates"] = simplify([(round(x, 5), round(y, 5)) for x, y in out])
            f["properties"]["snapped"] = 1
            snapped_feats += 1
    json.dump(cache, open(cache_path, "w"))
    log(f"recalage voirie : {snapped_feats} tracés recalés, {requests_done} requêtes OSRM, {kept} portions laissées droites")
    return {"snapped_features": snapped_feats, "kept_straight": kept, "service": osrm_url}


# ---------------------------------------------------------------- portions à sens unique

def oneway_pieces(feats, tol_m=25.0, step_m=20.0, min_len_m=150.0):
    """
    Pour chaque tracé, garde les portions que la même ligne ne parcourt PAS en sens inverse
    (à tol_m près) : boucles, détours, rues différentes à l'aller et au retour.
    C'est là, et seulement là, qu'une flèche de sens apporte une information.
    """
    def xy(lon, lat, lat0):
        return (lon * 111320 * math.cos(math.radians(lat0)), lat * 110540)
    by_route = defaultdict(list)
    for f in feats:
        if f["properties"].get("kind") != "train":
            by_route[f["properties"]["route"]].append(f)
    pieces = []
    for route, fs in by_route.items():
        lat0 = fs[0]["geometry"]["coordinates"][0][1]
        segs = []  # (feature index, x1, y1, x2, y2, ux, uy)
        grid = defaultdict(list)
        cell = 40.0
        for fi, f in enumerate(fs):
            c = [xy(x, y, lat0) for x, y in f["geometry"]["coordinates"]]
            for (x1, y1), (x2, y2) in zip(c, c[1:]):
                L = math.hypot(x2 - x1, y2 - y1)
                if L < 1e-6:
                    continue
                k = len(segs)
                segs.append((fi, x1, y1, x2, y2, (x2 - x1) / L, (y2 - y1) / L))
                for gx in range(int(min(x1, x2) // cell) - 1, int(max(x1, x2) // cell) + 2):
                    for gy in range(int(min(y1, y2) // cell) - 1, int(max(y1, y2) // cell) + 2):
                        grid[(gx, gy)].append(k)
        for fi, f in enumerate(fs):
            coords = f["geometry"]["coordinates"]
            c = [xy(x, y, lat0) for x, y in coords]
            run, runs = [], []
            for i in range(len(c) - 1):
                (x1, y1), (x2, y2) = c[i], c[i + 1]
                L = math.hypot(x2 - x1, y2 - y1)
                if L < 1e-6:
                    continue
                ux, uy = (x2 - x1) / L, (y2 - y1) / L
                n = max(1, int(L // step_m))
                for j in range(n):
                    t = (j + 0.5) / n
                    px, py = x1 + ux * L * t, y1 + uy * L * t
                    shared = False
                    for k in grid.get((int(px // cell), int(py // cell)), ()):
                        gi, ax, ay, bx, by, vx, vy = segs[k]
                        if gi == fi or ux * vx + uy * vy > -0.5:
                            continue  # même tracé, ou même sens
                        sl = math.hypot(bx - ax, by - ay)
                        proj = max(0.0, min(sl, (px - ax) * vx + (py - ay) * vy))
                        if math.hypot(px - (ax + vx * proj), py - (ay + vy * proj)) <= tol_m:
                            shared = True
                            break
                    lon = coords[i][0] + (coords[i + 1][0] - coords[i][0]) * t
                    lat = coords[i][1] + (coords[i + 1][1] - coords[i][1]) * t
                    if shared:
                        if run:
                            runs.append(run)
                        run = []
                    else:
                        run.append((round(lon, 5), round(lat, 5)))
            if run:
                runs.append(run)
            for r in runs:
                length = sum(haversine(a[1], a[0], b[1], b[0]) for a, b in zip(r, r[1:]))
                if len(r) >= 2 and length >= min_len_m:
                    pieces.append({"type": "Feature", "properties": {"route": route, "kind": f["properties"]["kind"]},
                                   "geometry": {"type": "LineString", "coordinates": simplify(r, 4.0)}})
    return pieces

# ---------------------------------------------------------------- pipeline

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("tenant")
    ap.add_argument("--cache", default=".cache")
    ap.add_argument("--out", default="public/data")
    ap.add_argument("--today", default=None)
    ap.add_argument("--no-snap", action="store_true", help="ne pas recaler les tracés droits sur la voirie")
    args = ap.parse_args()

    cfg = json.load(open(args.tenant, encoding="utf-8"))
    os.makedirs(args.cache, exist_ok=True)
    os.makedirs(args.out, exist_ok=True)
    today = dt.date.fromisoformat(args.today) if args.today else dt.date.today()
    win_start = today - dt.timedelta(days=1)  # veille : courses après minuit
    win_days = int(cfg.get("window_days", 60)) + 1
    win_dates = [win_start + dt.timedelta(days=i) for i in range(win_days)]
    clat, clon = cfg["center"][1], cfg["center"][0]

    stops = {}        # gid -> dict(name, lat, lon, feed)
    routes = {}       # gid -> dict
    trips = []        # dicts
    services = {}     # gid -> set(dates)
    shapes_needed = defaultdict(set)  # feed -> shape ids
    shapes = {}       # gid -> [(lon,lat)]
    feeds_report = []

    for feed in cfg["feeds"]:
        fid, kind = feed["id"], feed["kind"]
        path = os.path.join(args.cache, f"{cfg['tenant']}-{fid}.zip")
        meta = download(feed["url"], path)
        g = Gtfs(path)
        rep = {"id": fid, "name": feed["name"], "kind": kind, "licence": feed["licence"],
               "page": feed["page"], "url": feed["url"], "last_modified": meta.get("last_modified"),
               "fixes": Counter(), "checks": {}}
        log(f"== flux {fid}")

        agencies = {a.get("agency_id", ""): a["agency_name"] for a in g.rows("agency.txt")}
        excl = [s.lower() for s in feed.get("filter", {}).get("exclude_agency_contains", [])]
        radius = feed.get("filter", {}).get("serving_radius_km")
        near_existing = feed.get("filter", {}).get("near_existing_stops_m")

        stop_pat = feed.get("filter", {}).get("stop_id_contains")
        raw_stops = {}
        for s in g.rows("stops.txt"):
            if s.get("location_type", "0") not in ("", "0"):
                continue
            if stop_pat and stop_pat not in s["stop_id"]:
                continue
            try:
                lat, lon = float(s["stop_lat"]), float(s["stop_lon"])
            except (TypeError, ValueError):
                rep["fixes"]["arret_sans_coordonnees_ignore"] += 1
                continue
            if lat == 0 and lon == 0:
                rep["fixes"]["arret_sans_coordonnees_ignore"] += 1
                continue
            raw_stops[s["stop_id"]] = (s["stop_name"], lat, lon)

        raw_routes = {}
        for r in g.rows("routes.txt"):
            ag = agencies.get(r.get("agency_id", ""), next(iter(agencies.values()), ""))
            if any(e in ag.lower() for e in excl):
                continue
            raw_routes[r["route_id"]] = (r, ag)

        raw_trips = {}
        for t in g.rows("trips.txt"):
            if t["route_id"] in raw_routes:
                raw_trips[t["trip_id"]] = t

        # filtre géographique (flux régional) : courses desservant le territoire
        if radius:
            near = {sid for sid, (_, la, lo) in raw_stops.items() if haversine(la, lo, clat, clon) <= radius * 1000}
            touching = set()
            for st in g.rows("stop_times.txt"):
                if st["stop_id"] in near and st["trip_id"] in raw_trips:
                    touching.add(st["trip_id"])
            raw_trips = {k: v for k, v in raw_trips.items() if k in touching}
            log(f"  {len(raw_trips)} courses régionales desservent le territoire")
        if near_existing:
            # arrêts de ce flux à distance de marche d'un arrêt des flux déjà chargés (ex. gares SNCF)
            existing = list(stops.values())
            near = set()
            for sid, (_, la, lo) in raw_stops.items():
                if any(abs(la - e["lat"]) < 0.01 and haversine(la, lo, e["lat"], e["lon"]) <= near_existing for e in existing):
                    near.add(sid)
            touching = set()
            for st in g.rows("stop_times.txt"):
                if st["stop_id"] in near and st["trip_id"] in raw_trips:
                    touching.add(st["trip_id"])
            raw_trips = {k: v for k, v in raw_trips.items() if k in touching}
            log(f"  {len(near)} gares en correspondance, {len(raw_trips)} trains les desservent")

        # horaires
        st_by_trip = defaultdict(list)
        for st in g.rows("stop_times.txt"):
            if st["trip_id"] in raw_trips and st["stop_id"] in raw_stops:
                st_by_trip[st["trip_id"]].append(st)

        # calendriers -> dates actives dans la fenêtre
        used_services = {t["service_id"] for t in raw_trips.values()}
        active = defaultdict(set)
        min_d, max_d = None, None
        for c in g.rows("calendar.txt"):
            if c["service_id"] not in used_services:
                continue
            a, b = parse_date(c["start_date"]), parse_date(c["end_date"])
            min_d = a if not min_d or a < min_d else min_d
            max_d = b if not max_d or b > max_d else max_d
            days = [c[d] == "1" for d in ("monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday")]
            for d in win_dates:
                if a <= d <= b and days[d.weekday()]:
                    active[c["service_id"]].add(d)
        for c in g.rows("calendar_dates.txt"):
            if c["service_id"] not in used_services:
                continue
            d = parse_date(c["date"])
            if c["exception_type"] == "1":
                min_d = d if not min_d or d < min_d else min_d
                max_d = d if not max_d or d > max_d else max_d
                if win_dates[0] <= d <= win_dates[-1]:
                    active[c["service_id"]].add(d)
            elif c["exception_type"] == "2":
                active[c["service_id"]].discard(d)
        for sid, ds in active.items():
            services[f"{fid}:{sid}"] = ds
        rep["start"] = min_d.isoformat() if min_d else None
        rep["end"] = max_d.isoformat() if max_d else None
        rep["days_left"] = (max_d - today).days if max_d else None

        # normalisation des courses + corrections de cohérence
        used_stops, used_routes = set(), set()
        for tid, t in raw_trips.items():
            sts = st_by_trip.get(tid)
            if not sts or len(sts) < 2:
                continue
            sts.sort(key=lambda x: int(x["stop_sequence"]))
            seq, seen = [], set()
            for x in sts:
                if x["stop_sequence"] in seen:
                    rep["fixes"]["sequence_dupliquee_supprimee"] += 1
                    continue
                seen.add(x["stop_sequence"])
                seq.append(x)
            arr, dep, sids = [], [], []
            prev = None
            pickup_flag = None
            for x in seq:
                a = parse_time(x["arrival_time"]) or parse_time(x["departure_time"])
                d = parse_time(x["departure_time"]) or a
                if a is None:
                    rep["fixes"]["horaire_vide_ignore"] += 1
                    continue
                if d < a:
                    d = a
                    rep["fixes"]["depart_avant_arrivee_corrige"] += 1
                if prev is not None and a < prev:
                    rep["fixes"]["temps_de_parcours_negatif_corrige"] += 1
                    a = prev
                    d = max(d, a)
                prev = d
                arr.append(a); dep.append(d); sids.append(f"{fid}:{x['stop_id']}")
                if x.get("pickup_type") == "2":
                    pickup_flag = "phone"
            if len(sids) < 2:
                continue
            svc = f"{fid}:{t['service_id']}"
            if svc not in services or not services[svc]:
                continue
            rid = f"{fid}:{t['route_id']}"
            shape = t.get("shape_id") or ""
            if shape:
                shapes_needed[fid].add(shape)
            trips.append({"route": rid, "service": svc, "headsign": nice_name(t.get("trip_headsign") or ""),
                          "dir": t.get("direction_id") or "0", "stops": sids, "arr": arr, "dep": dep,
                          "shape": f"{fid}:{shape}" if shape else None, "booking": pickup_flag})
            used_stops.update(sids)
            used_routes.add(rid)

        for sid in used_stops:
            name, lat, lon = raw_stops[sid.split(":", 1)[1]]
            stops[sid] = {"name": nice_name(name), "lat": lat, "lon": lon, "feed": fid}
        for rid in used_routes:
            r, ag = raw_routes[rid.split(":", 1)[1]]
            color = (r.get("route_color") or "").strip().upper()
            if not re.fullmatch(r"[0-9A-F]{6}", color):
                color = {"region": "3F5873", "tad": "6B4FA0", "train": "1E3A8A"}.get(kind, "4B5563")
            short = (r.get("route_short_name") or "").replace("Ligne ", "").strip()
            long_ = nice_name(r.get("route_long_name") or "")
            long_ = re.sub(r"^(Ligne\s+(0?" + re.escape(short) + r"|\d+)\b|" + re.escape(short) + r"\b)\s*(-\s*)?", "", long_).strip() if short else long_
            routes[rid] = {"short": short,
                           "long": long_ or nice_name(r.get("route_long_name") or ""), "color": color,
                           "text": best_text(color), "kind": kind, "agency": ag,
                           "declared_text": (r.get("route_text_color") or "").upper()}
            if routes[rid]["declared_text"] and routes[rid]["declared_text"] != routes[rid]["text"] \
                    and re.fullmatch(r"[0-9A-F]{6}", routes[rid]["declared_text"]) \
                    and contrast(color, routes[rid]["declared_text"]) < 4.5:
                rep["fixes"]["contraste_couleur_ligne_corrige"] += 1

        # tracés
        need = shapes_needed[fid]
        if need and g.has("shapes.txt"):
            pts = defaultdict(list)
            for s in g.rows("shapes.txt"):
                if s["shape_id"] in need:
                    pts[s["shape_id"]].append((int(s["shape_pt_sequence"]), float(s["shape_pt_lon"]), float(s["shape_pt_lat"])))
            for k, v in pts.items():
                v.sort()
                shapes[f"{fid}:{k}"] = simplify([(round(lo, 5), round(la, 5)) for _, lo, la in v])

        rep["checks"] = {
            "lignes": len(used_routes), "courses_dans_fenetre": sum(1 for t in trips if t["route"].startswith(fid + ":")),
            "arrets_utilises": len(used_stops),
            "arrets_inutilises_ecartes": max(0, len(raw_stops) - len(used_stops)) if not (radius or near_existing) else None,
        }
        rep["fixes"] = dict(rep["fixes"])
        feeds_report.append(rep)
        log(f"  {rep['checks']} corrections={rep['fixes']} validité={rep['start']}→{rep['end']}")

    # ------------------------------------------------ réconciliation des arrêts
    ids = sorted(stops)
    parent = {i: i for i in ids}

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    cell = defaultdict(list)
    for i in ids:
        s = stops[i]
        cell[(round(s["lat"] * 300), round(s["lon"] * 200))].append(i)
    cross_merges = 0
    for (cy, cx), members in list(cell.items()):
        neigh = [j for dy in (-1, 0, 1) for dx in (-1, 0, 1) for j in cell.get((cy + dy, cx + dx), [])]
        for i in members:
            a = stops[i]
            for j in neigh:
                if j <= i:
                    continue
                b = stops[j]
                d = haversine(a["lat"], a["lon"], b["lat"], b["lon"])
                if d > 150:
                    continue
                sim = SequenceMatcher(None, norm_key(a["name"]), norm_key(b["name"])).ratio()
                if d <= 35 or (d <= 150 and sim >= 0.82):
                    if find(i) != find(j):
                        if a["feed"] != b["feed"]:
                            cross_merges += 1
                        parent[find(i)] = find(j)

    groups = defaultdict(list)
    for i in ids:
        groups[find(i)].append(i)
    feed_rank = {"urbain": 0, "tad": 1, "scolaire": 2, "region": 3, "train": 4}
    places, place_of = [], {}
    for members in groups.values():
        names = Counter(stops[m]["name"] for m in members)
        best = sorted(members, key=lambda m: (feed_rank.get(stops[m]["feed"], 9), -names[stops[m]["name"]], len(stops[m]["name"])))[0]
        # même nom normalisé mais mieux orthographié (accents) ailleurs ? on le préfère
        twins = [m for m in members if norm_key(stops[m]["name"]) == norm_key(stops[best]["name"])
                 and len(stops[m]["name"]) <= len(stops[best]["name"]) + 2]
        best = max(twins, key=lambda m: sum(1 for c in stops[m]["name"] if ord(c) > 127)) if twins else best
        lat = sum(stops[m]["lat"] for m in members) / len(members)
        lon = sum(stops[m]["lon"] for m in members) / len(members)
        for m in members:
            place_of[m] = len(places)
        places.append({"name": stops[best]["name"], "lat": round(lat, 6), "lon": round(lon, 6),
                       "feeds": sorted({stops[m]["feed"] for m in members})})
    log(f"réconciliation : {len(ids)} arrêts → {len(places)} pôles ({cross_merges} rapprochements inter-flux)")


    # ------------------------------------------------ gares ferroviaires en correspondance
    stations_out = []
    rail = cfg.get("rail_stations")
    if rail:
        rpath = os.path.join(args.cache, f"{cfg['tenant']}-gares.json")
        if not os.path.exists(rpath) or time.time() - os.path.getmtime(rpath) > 7 * 86400:
            log("téléchargement des gares", rail["url"])
            json.dump(fetch_json(rail["url"]), open(rpath, "w"))
        # gares en correspondance avec le réseau de bus (on exclut les arrêts des flux ferroviaires eux-mêmes)
        served_stops = [sid for sid in ids if stops[sid]["feed"] != "train"]
        for st in json.load(open(rpath)):
            pg = st.get("position_geographique") or {}
            if not pg:
                continue
            links = {}
            for sid in served_stops:
                s = stops[sid]
                d = haversine(pg["lat"], pg["lon"], s["lat"], s["lon"])
                if d <= rail.get("max_walk_m", 500):
                    pl = place_of[sid]
                    links[pl] = min(links.get(pl, 1e9), d)
            if links:
                stations_out.append({"name": st["nom"], "lat": pg["lat"], "lon": pg["lon"], "uic": st.get("codes_uic"),
                                     "segment": st.get("segment_drg"),
                                     "links": sorted(([pl, int(round(d))] for pl, d in links.items()), key=lambda x: x[1])})
        log(f"gares : {len(stations_out)} en correspondance avec le réseau ({', '.join(x['name'] for x in stations_out)})")


    # ------------------------------------------------ horaires des trains dans les gares en correspondance
    trains_out, train_svcs, rail_tt = {}, [], cfg.get("rail_timetables")
    if rail_tt and stations_out:
        tpath = os.path.join(args.cache, f"{cfg['tenant']}-sncf.zip")
        download(rail_tt["url"], tpath)
        g = Gtfs(tpath)
        modes = set(rail_tt.get("modes", []))
        uic_to_station = {}
        for k, st in enumerate(stations_out):
            for u in str(st.get("uic") or "").split(";"):
                if u:
                    uic_to_station[u.strip()] = k
        # passe 1 : passages des trains (hors cars) dans nos gares
        hits, trip_ids = [], set()
        pat = re.compile(r"StopPoint:OCE(.+)-(\d{8})$")
        for st in g.rows("stop_times.txt"):
            m = pat.match(st["stop_id"])
            if m and m.group(2) in uic_to_station and m.group(1) in modes:
                hits.append((uic_to_station[m.group(2)], m.group(1), st))
                trip_ids.add(st["trip_id"])
        # passe 2 : origine et terminus de ces trains
        ends = {}
        for st in g.rows("stop_times.txt"):
            if st["trip_id"] in trip_ids:
                seq = int(st["stop_sequence"])
                lo, hi = ends.get(st["trip_id"], ((1e9, None), (-1, None)))
                ends[st["trip_id"]] = (min(lo, (seq, st["stop_id"])), max(hi, (seq, st["stop_id"])))
        names = {s["stop_id"]: s["stop_name"] for s in g.rows("stops.txt")}
        trips_r = {t["trip_id"]: t for t in g.rows("trips.txt") if t["trip_id"] in trip_ids}
        routes_r = {r["route_id"]: r for r in g.rows("routes.txt")}
        used = {trips_r[t]["service_id"] for t in trip_ids if t in trips_r}
        active = defaultdict(set)
        for c in g.rows("calendar_dates.txt"):
            if c["service_id"] in used and c["exception_type"] == "1":
                d = parse_date(c["date"])
                if win_dates[0] <= d <= win_dates[-1]:
                    active[c["service_id"]].add(d)
        svc_index_t = {}
        for k, mode, st in hits:
            t = trips_r.get(st["trip_id"])
            if not t or not active.get(t["service_id"]):
                continue
            sid = t["service_id"]
            if sid not in svc_index_t:
                svc_index_t[sid] = len(train_svcs)
                train_svcs.append("".join("1" if d in active[sid] else "0" for d in win_dates))
            (_, first), (_, last) = ends[st["trip_id"]]
            r = routes_r.get(t["route_id"], {})
            trains_out.setdefault(k, []).append([
                parse_time(st["departure_time"]), parse_time(st["arrival_time"]), svc_index_t[sid], mode,
                (r.get("route_short_name") or "").strip(), (t.get("trip_headsign") or "").strip(),
                nice_name(names.get(first, "")), nice_name(names.get(last, "")),
                1 if st.get("pickup_type") == "1" else 0, 1 if st.get("drop_off_type") == "1" else 0])
        for k in trains_out:
            trains_out[k].sort(key=lambda x: x[0])
        log(f"trains : {sum(len(v) for v in trains_out.values())} passages dans {len(trains_out)} gares, {len(train_svcs)} calendriers")

    # ------------------------------------------------ correspondances à pied
    stop_index = {sid: k for k, sid in enumerate(ids)}
    foot = []
    for (cy, cx), members in cell.items():
        neigh = [j for dy in (-1, 0, 1) for dx in (-1, 0, 1) for j in cell.get((cy + dy, cx + dx), [])]
        for i in members:
            for j in neigh:
                if i == j:
                    continue
                a, b = stops[i], stops[j]
                d = haversine(a["lat"], a["lon"], b["lat"], b["lon"])
                if d <= 400:
                    foot.append([stop_index[i], stop_index[j], int(60 + d * 1.25 / 1.2)])

    # ------------------------------------------------ sérialisation compacte
    route_ids = sorted(routes, key=lambda r: (feed_rank.get(routes[r]["kind"], 9), len(routes[r]["short"]), routes[r]["short"]))
    route_index = {r: k for k, r in enumerate(route_ids)}
    svc_ids = sorted({t["service"] for t in trips})
    svc_index = {s: k for k, s in enumerate(svc_ids)}

    trips.sort(key=lambda t: (route_index[t["route"]], t["dep"][0]))
    out = {
        "version": 1,
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "tenant": {k: cfg[k] for k in ("tenant", "name", "territory", "center", "bbox", "links")},
        "booking": {f["id"]: f["booking"] for f in cfg["feeds"] if f.get("booking")},
        "window_start": win_start.isoformat(),
        "window_days": win_days,
        "feeds": feeds_report,
        "reconciliation": {"stops": len(ids), "places": len(places), "cross_feed_merges": cross_merges},
        "routes": [[routes[r]["short"], routes[r]["long"], routes[r]["color"], routes[r]["text"], routes[r]["kind"], routes[r]["agency"]] for r in route_ids],
        "stops": [[stops[s]["name"], round(stops[s]["lat"], 6), round(stops[s]["lon"], 6), place_of[s], stops[s]["feed"]] for s in ids],
        "places": [[p["name"], p["lat"], p["lon"], p["feeds"]] for p in places],
        "services": ["".join("1" if d in services[s] else "0" for d in win_dates) for s in svc_ids],
        "trips": [[route_index[t["route"]], svc_index[t["service"]], t["headsign"], int(t["dir"]) if str(t["dir"]).isdigit() else 0,
                   [stop_index[s] for s in t["stops"]], t["arr"], t["dep"], 1 if t["booking"] else 0] for t in trips],
        "footpaths": foot,
        "stations": [[x["name"], round(x["lat"], 6), round(x["lon"], 6), x["uic"], x["segment"], x["links"]] for x in stations_out],
        "trains": {str(k): v for k, v in trains_out.items()},
        "train_services": train_svcs,
        "trains_source": ({"name": rail_tt.get("name"), "licence": rail_tt.get("licence"), "page": rail_tt.get("page")} if rail_tt else None),
        "stations_source": ({"name": rail.get("name"), "licence": rail.get("licence"), "page": rail.get("page")} if rail else None),
    }
    # tracés par ligne (dédupliqués)
    feats, seen, reversed_shapes = [], set(), 0
    for t in trips:
        ri = route_index[t["route"]]
        if t["shape"] and t["shape"] in shapes:
            key = (ri, t["shape"])
            coords = shapes[t["shape"]]
        else:
            key = (ri, tuple(t["stops"]))
            coords = [(round(stops[s]["lon"], 5), round(stops[s]["lat"], 5)) for s in t["stops"]]
        if key in seen or len(coords) < 2:
            continue
        seen.add(key)
        # orientation : le tracé doit partir du premier arrêt de la course (sens de circulation,
        # utilisé par les flèches). Certains flux réutilisent une même forme pour les deux sens.
        s0, s1 = stops[t["stops"][0]], stops[t["stops"][-1]]
        if t["stops"][0] != t["stops"][-1] and \
                haversine(coords[0][1], coords[0][0], s0["lat"], s0["lon"]) > haversine(coords[0][1], coords[0][0], s1["lat"], s1["lon"]):
            coords = list(reversed(coords))
            reversed_shapes += 1
        r = routes[t["route"]]
        # provenance / destination du tracé (pôles de la première et de la dernière desserte)
        origin = places[place_of[t["stops"][0]]]["name"]
        dest = places[place_of[t["stops"][-1]]]["name"]
        feats.append({"type": "Feature", "properties": {"route": ri, "color": "#" + r["color"], "kind": r["kind"],
                                                        "from": origin, "to": dest},
                      "geometry": {"type": "LineString", "coordinates": coords}})

    if reversed_shapes:
        log(f"tracés : {reversed_shapes} formes retournées pour suivre le sens de circulation")
    snap_cfg = cfg.get("snap_to_roads")
    if snap_cfg and snap_cfg.get("enabled") and not args.no_snap:
        out["shapes"] = snap_to_roads(feats, os.path.join(args.cache, "osrm-cache.json"), snap_cfg["osrm_url"].rstrip("/"))
    with open(os.path.join(args.out, "network.json"), "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False, separators=(",", ":"))
    # portions à sens unique (flèches de sens uniquement là où l'aller et le retour diffèrent)
    arrows = oneway_pieces(feats)
    with open(os.path.join(args.out, "oneway.geojson"), "w", encoding="utf-8") as fh:
        json.dump({"type": "FeatureCollection", "features": arrows}, fh, separators=(",", ":"))
    log(f"sens unique : {len(arrows)} portions où l'aller et le retour ne suivent pas le même chemin")
    with open(os.path.join(args.out, "lines.geojson"), "w", encoding="utf-8") as fh:
        json.dump({"type": "FeatureCollection", "features": feats}, fh, separators=(",", ":"))

    # tarifs (fichier relevé à part, en attendant un flux GTFS-Fares publié par le réseau)
    if cfg.get("fares_file"):
        src = os.path.join(os.path.dirname(args.tenant), cfg["fares_file"])
        shutil.copyfile(src, os.path.join(args.out, "fares.json"))
        log(f"tarifs : {len(json.load(open(src))['fares'])} titres copiés depuis {cfg['fares_file']}")

    size = os.path.getsize(os.path.join(args.out, "network.json")) / 1024
    size2 = os.path.getsize(os.path.join(args.out, "lines.geojson")) / 1024
    log(f"OK : {len(route_ids)} lignes, {len(trips)} courses, {len(ids)} arrêts, {len(foot)} correspondances à pied "
        f"→ network.json {size:.0f} Ko, lines.geojson {size2:.0f} Ko")

if __name__ == "__main__":
    main()
