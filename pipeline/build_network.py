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

def snap_to_roads(feats, cache_path, osrm_url, min_gap_m=250, max_ratio=2.2, min_share=0.3, skip_kinds=()):
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
        if f["properties"].get("kind") in skip_kinds:
            continue  # confié directement à l'appariement fin (moteur local couvrant tout le réseau)
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



# ---------------------------------------------------------------- appariement cartographique (map matching)

def resample(coords, step_m):
    """Points régulièrement espacés de step_m le long d'une polyligne (lon, lat)."""
    out = [tuple(coords[0])]
    acc = 0.0
    for a, b in zip(coords, coords[1:]):
        L = haversine(a[1], a[0], b[1], b[0])
        t = step_m - acc
        while t <= L:
            out.append((a[0] + (b[0] - a[0]) * t / L, a[1] + (b[1] - a[1]) * t / L))
            t += step_m
        acc = (acc + L) % step_m if L else acc
    if out[-1] != tuple(coords[-1]):
        out.append(tuple(coords[-1]))
    return out

def deviations(points, line, cell=60.0):
    """Distance (m) de chaque point à la polyligne `line` (index spatial en grille)."""
    lat0 = line[0][1]
    kx, ky = 111320 * math.cos(math.radians(lat0)), 110540
    segs, grid = [], defaultdict(list)
    for (x1, y1), (x2, y2) in zip(line, line[1:]):
        a, b = (x1 * kx, y1 * ky), (x2 * kx, y2 * ky)
        k = len(segs)
        segs.append((a, b))
        for gx in range(int(min(a[0], b[0]) // cell) - 1, int(max(a[0], b[0]) // cell) + 2):
            for gy in range(int(min(a[1], b[1]) // cell) - 1, int(max(a[1], b[1]) // cell) + 2):
                grid[(gx, gy)].append(k)
    out = []
    for lon, lat in points:
        px, py = lon * kx, lat * ky
        best = 1e9
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for k in grid.get((int(px // cell) + dx, int(py // cell) + dy), ()):
                    (ax, ay), (bx, by) = segs[k]
                    vx, vy = bx - ax, by - ay
                    L2 = vx * vx + vy * vy or 1e-9
                    t = max(0.0, min(1.0, ((px - ax) * vx + (py - ay) * vy) / L2))
                    best = min(best, math.hypot(px - ax - t * vx, py - ay - t * vy))
        out.append(best if best < 1e9 else cell * 2)
    return out

def drop_short_spurs(coords, stops=(), max_leg_m=120.0, back_m=25.0, stop_m=35.0):
    """Retire les éperons : la ligne part, fait demi-tour et revient à moins de back_m de son point de départ
    en moins de max_leg_m (artefact de calcul). Un aller-retour qui passe à moins de stop_m d'un arrêt
    desservi est réel (bus qui entre dans un village ou une impasse pour desservir l'arrêt) : il est gardé."""
    c = [tuple(x) for x in coords]
    stops = [tuple(x) for x in stops]

    def serves_stop(pts):
        return any(haversine(q[1], q[0], p[1], p[0]) <= stop_m for p in pts for q in stops
                   if abs(q[1] - p[1]) < 0.001)
    changed = True
    while changed and len(c) > 3:
        changed = False
        for i in range(1, len(c) - 1):
            a, b = c[i - 1], c[i]
            # plus loin point j (≤ max_leg_m de parcours depuis b) qui revient près de a
            run, j = haversine(a[1], a[0], b[1], b[0]), i + 1
            if run > max_leg_m:
                continue
            while j < len(c) and run <= 2 * max_leg_m:
                run += haversine(c[j - 1][1], c[j - 1][0], c[j][1], c[j][0])
                if haversine(a[1], a[0], c[j][1], c[j][0]) <= back_m and haversine(a[1], a[0], b[1], b[0]) > back_m \
                        and not serves_stop(c[i:j]):
                    # on reprend après le point de retour (voisin de a) : pas de micro-segment de raccord
                    c = c[:i] + c[j + 1:] if j + 1 < len(c) else c[:i] + [c[j]]
                    changed = True
                    break
                j += 1
            if changed:
                break
    # crochets : demi-tour net sur un sommet dont un bras fait moins de hook_m (le calcul rejoint un point
    # d'une rue voisine puis repart en arrière) ; sommet retiré s'il ne dessert aucun arrêt
    hook_m = 35.0
    changed = True
    while changed and len(c) > 3:
        changed = False
        for i in range(1, len(c) - 1):
            a, b, d = c[i - 1], c[i], c[i + 1]
            kx = 111320 * math.cos(math.radians(b[1]))
            v1 = ((b[0] - a[0]) * kx, (b[1] - a[1]) * 110540)
            v2 = ((d[0] - b[0]) * kx, (d[1] - b[1]) * 110540)
            l1, l2 = math.hypot(*v1), math.hypot(*v2)
            if l1 < 1 or l2 < 1 or min(l1, l2) > hook_m:
                continue
            if (v1[0] * v2[0] + v1[1] * v2[1]) / (l1 * l2) < -0.9 and not serves_stop([b]):
                c = c[:i] + c[i + 1:]
                changed = True
                break
    return c


def match_to_roads(feats, osrm_url, kinds, cache_path, step_m=35.0, chunk=200, radius=25,
                   min_ratio=0.8, max_ratio=1.25, min_matched=0.9, drop_spurs=False):
    """
    Appariement cartographique (OSRM /match, profil bus) des tracés des types `kinds` :
    la géométrie renvoyée suit exactement la chaussée OSM. Par bloc de points :
    on ne remplace que si ≥ min_matched des points sont appariés et si la longueur reste
    dans [min_ratio ; max_ratio] × l'original, sinon on garde le bloc d'origine.
    Renvoie des statistiques par ligne (écart corrigé médian / p95 / max).
    """
    import hashlib
    try:
        fetch_json(f"{osrm_url}/nearest/v1/driving/4.67,45.24")
    except Exception as e:
        log(f"appariement : moteur OSRM injoignable à {osrm_url} ({e}) — étape ignorée")
        return None
    cache = json.load(open(cache_path)) if os.path.exists(cache_path) else {}
    per_route = defaultdict(lambda: {"dev": [], "blocks": 0, "kept": 0})
    done = 0
    for f in feats:
        if f["properties"].get("kind") not in kinds:
            continue
        orig = [tuple(x) for x in f["geometry"]["coordinates"]]
        cum = [0.0]
        for a_, b_ in zip(orig, orig[1:]):
            cum.append(cum[-1] + haversine(a_[1], a_[0], b_[1], b_[0]))
        # tracé d'origine fait de cordes d'arrêt en arrêt (flux sans tracé, ex. TPG) : la vraie route est
        # nettement plus longue que la corde, le plafond de longueur doit le permettre
        sparse = len(orig) / max(cum[-1] / 1000, 0.1) < 6
        hi_ratio = 1.6 if sparse else max_ratio
        pts = resample(orig, step_m)
        new = []
        st = per_route[f["properties"]["route"]]
        for k in range(0, max(1, len(pts) - 1), chunk - 1):
            ch = pts[k:k + chunk]
            if len(ch) < 2:
                break
            key = hashlib.md5(";".join(f"{x:.5f},{y:.5f}" for x, y in ch).encode()).hexdigest()
            if key not in cache:
                url = (f"{osrm_url}/match/v1/driving/" + ";".join(f"{x:.6f},{y:.6f}" for x, y in ch) +
                       "?overview=full&geometries=geojson&gaps=ignore&tidy=false&radiuses=" + ";".join([str(radius)] * len(ch)))
                try:
                    r = fetch_json(url)
                except Exception:
                    r = {"code": "Error"}
                if r.get("code") == "Ok" and r.get("matchings"):
                    # plusieurs « matchings » = trous dans l'appariement : on les relie par un itinéraire
                    # routier, et non par une ligne droite (qui traverserait le bâti)
                    geom = []
                    for mm in r["matchings"]:
                        part = mm["geometry"]["coordinates"]
                        if geom and part:
                            a_, b_ = geom[-1], part[0]
                            if haversine(a_[1], a_[0], b_[1], b_[0]) > 40:
                                try:
                                    g = fetch_json(f"{osrm_url}/route/v1/driving/{a_[0]:.6f},{a_[1]:.6f};{b_[0]:.6f},{b_[1]:.6f}"
                                                   "?overview=full&geometries=geojson")
                                    if g.get("code") == "Ok":
                                        geom += g["routes"][0]["geometry"]["coordinates"][1:-1]
                                except Exception:
                                    pass
                        geom += part
                    matched = sum(1 for tp in r.get("tracepoints", []) if tp) / len(ch)
                    cache[key] = {"geom": geom, "matched": matched}
                else:
                    cache[key] = None
            hit = cache[key]
            L0 = sum(haversine(a[1], a[0], b[1], b[0]) for a, b in zip(ch, ch[1:]))
            ok = False
            if hit and hit["matched"] >= min_matched and len(hit["geom"]) >= 2:
                L1 = sum(haversine(a[1], a[0], b[1], b[0]) for a, b in zip(hit["geom"], hit["geom"][1:]))
                ok = min_ratio * L0 <= L1 <= hi_ratio * L0 + 80
            if not ok:
                # plan B : itinéraire routier par les sommets d'origine du bloc (arrêts, points de tracé),
                # utile quand le tracé publié est une ligne droite à travers le bâti (appariement impossible)
                lo, hi = k * step_m, (k + len(ch) - 1) * step_m
                via = [ch[0]] + [orig[i] for i in range(len(orig)) if lo < cum[i] < hi] + [ch[-1]]
                key2 = "route2:" + hashlib.md5(";".join(f"{x:.5f},{y:.5f}" for x, y in via).encode()).hexdigest()
                if key2 not in cache:
                    try:
                        # début et fin du bloc : points ré-échantillonnés, parfois au milieu d'une corde loin de toute route
                        rad = ["250"] + ["60"] * (len(via) - 2) + ["250"]
                        r2 = fetch_json(f"{osrm_url}/route/v1/driving/" + ";".join(f"{x:.6f},{y:.6f}" for x, y in via) +
                                        "?overview=full&geometries=geojson&continue_straight=true&radiuses=" + ";".join(rad))
                        rt = r2["routes"][0] if r2.get("code") == "Ok" else None
                        cache[key2] = {"geom": rt["geometry"]["coordinates"], "dist": rt["distance"]} if rt else None
                    except Exception:
                        cache[key2] = None
                h2 = cache[key2]
                if h2 and min_ratio * L0 <= h2["dist"] <= 3.0 * L0 + 150:  # le tracé publié coupait à travers le bâti
                    hit, ok = {"geom": h2["geom"]}, True
            seg = [tuple(c) for c in hit["geom"]] if ok else ch
            st["blocks"] += 1
            st["kept"] += 0 if ok else 1
            new += seg if not new else seg[1:]
        # réparation finale : un segment droit > 400 m restant (bloc non apparié, trou) devient l'itinéraire routier
        if len(new) >= 2:
            fixed = [new[0]]
            for a_, b_ in zip(new, new[1:]):
                L = haversine(a_[1], a_[0], b_[1], b_[0])
                if L > 400:
                    k3 = f"fix:{a_[0]:.5f},{a_[1]:.5f};{b_[0]:.5f},{b_[1]:.5f}"
                    if k3 not in cache:
                        try:
                            g = fetch_json(f"{osrm_url}/route/v1/driving/{a_[0]:.6f},{a_[1]:.6f};{b_[0]:.6f},{b_[1]:.6f}"
                                           "?overview=full&geometries=geojson&radiuses=40;40")
                            rt = g["routes"][0] if g.get("code") == "Ok" else None
                            cache[k3] = {"geom": rt["geometry"]["coordinates"], "dist": rt["distance"]} if rt else None
                        except Exception:
                            cache[k3] = None
                    h3 = cache[k3]
                    if h3 and h3["dist"] <= min(3.0 * L, L + 2500):
                        fixed += [tuple(c) for c in h3["geom"]][1:-1]
                        st["repaired"] = st.get("repaired", 0) + 1
                fixed.append(b_)
            new = fixed
        if len(new) >= 2:
            if drop_spurs:
                new = drop_short_spurs(new, f.get("_stops", ()))
            st["dev"] += deviations(resample(orig, 30.0), new)
            f["geometry"]["coordinates"] = simplify([(round(x, 5), round(y, 5)) for x, y in new], 3.5)
            f["properties"]["matched"] = 1
        done += 1
        if done % 25 == 0:
            log(f"  appariement : {done} tracés…")
            json.dump(cache, open(cache_path, "w"))
    json.dump(cache, open(cache_path, "w"))
    report = {}
    for route, st in per_route.items():
        d = sorted(st["dev"]) or [0.0]
        report[route] = {"median_m": round(d[len(d) // 2], 1), "p95_m": round(d[int(len(d) * 0.95)], 1),
                         "max_m": round(d[-1], 1), "blocks": st["blocks"], "kept_original": st["kept"]}
    repaired = sum(st.get("repaired", 0) for st in per_route.values())
    log(f"appariement : {done} tracés appariés, {sum(v['kept_original'] for v in report.values())} blocs conservés tels quels, {repaired} segments droits réparés")
    return report


def _project_all(line, cum, p, max_off):
    """Projections d'un point sur les segments proches d'une polyligne : [(abscisse, écart, segment, t)],
    une seule par passage (minimum local), pour gérer les lignes qui repassent au même endroit."""
    kx = 111320 * math.cos(math.radians(p[1]))
    hits = []
    for i in range(len(line) - 1):
        ax, ay = (line[i][0] - p[0]) * kx, (line[i][1] - p[1]) * 111320
        bx, by = (line[i + 1][0] - p[0]) * kx, (line[i + 1][1] - p[1]) * 111320
        dx, dy = bx - ax, by - ay
        L2 = dx * dx + dy * dy
        t = max(0.0, min(1.0, -(ax * dx + ay * dy) / L2)) if L2 else 0.0
        off = math.hypot(ax + t * dx, ay + t * dy)
        if off <= max_off:
            hits.append((cum[i] + t * (cum[i + 1] - cum[i]), off, i, t))
    out = []
    for h in hits:  # minima locaux : on ne garde qu'un point par « passage » (abscisses espacées de > 300 m)
        if out and h[0] - out[-1][0] < 300:
            if h[1] < out[-1][1]:
                out[-1] = h
        else:
            out.append(h)
    return out


def remove_spurs(coords, stop_pts, min_len=40.0, stop_tol=80.0):
    """Supprime les éperons (aller-retour sur la même chaussée) dont la pointe ne dessert aucun arrêt :
    artefacts d'appariement. Un demi-tour qui va chercher un arrêt est conservé."""
    c = list(coords)
    removed, i = 0, 1
    while i < len(c) - 1:
        a, b, e = c[i - 1], c[i], c[i + 1]
        v1, v2 = (b[0] - a[0], b[1] - a[1]), (e[0] - b[0], e[1] - b[1])
        n1, n2 = math.hypot(*v1), math.hypot(*v2)
        if n1 * n2 and (v1[0] * v2[0] + v1[1] * v2[1]) / (n1 * n2) < -0.9:
            k, L = 1, 0.0
            while i - k >= 0 and i + k < len(c) and haversine(c[i - k][1], c[i - k][0], c[i + k][1], c[i + k][0]) < 30:
                L = haversine(c[i - k][1], c[i - k][0], b[1], b[0])
                k += 1
            near = min((haversine(b[1], b[0], s_[1], s_[0]) for s_ in stop_pts), default=1e9)
            if L >= min_len and near > stop_tol and k > 1:
                c = c[:i - k + 1] + c[i + k - 1:]  # on recolle les deux brins à la base de l'éperon
                removed += 1
                i = max(1, i - k)
                continue
        i += 1
    return c, removed


def check_against_stops(feats, osrm_url, kinds, cache_path, max_off=120, ratio=1.5, slack_m=1000):
    """
    Contrôle des tracés : la portion entre deux arrêts consécutifs ne doit pas dépasser
    max(ratio × plus court chemin routier, chemin + slack_m) ; un arrêt doit être à moins de
    max_off du tracé. Sinon la portion est remplacée par l'itinéraire routier OSRM entre les arrêts.
    Corrige les détours aberrants (appariement parti sur une mauvaise route, tracé publié erroné).
    """
    try:
        fetch_json(f"{osrm_url}/nearest/v1/driving/4.67,45.24")
    except Exception as e:
        log(f"contrôle des tracés : moteur OSRM injoignable ({e}) — étape ignorée")
        return None
    cache = json.load(open(cache_path)) if os.path.exists(cache_path) else {}

    def route(a, b):
        k = f"{a[0]:.5f},{a[1]:.5f};{b[0]:.5f},{b[1]:.5f}"
        if k not in cache:
            try:
                g = fetch_json(f"{osrm_url}/route/v1/driving/{k}?overview=full&geometries=geojson&radiuses=60;60")
                rt = g["routes"][0] if g.get("code") == "Ok" else None
                cache[k] = {"geom": rt["geometry"]["coordinates"], "dist": rt["distance"]} if rt else None
            except Exception:
                cache[k] = None
        return cache[k]

    report = {"checked": 0, "fixed_features": 0, "fixed_portions": 0, "worst": [], "portions": []}
    for f in feats:
        if f["properties"].get("kind") not in kinds or not f.get("_stops"):
            continue
        line = [tuple(c) for c in f["geometry"]["coordinates"]]
        sts = f["_stops"]
        if len(line) < 2 or len(sts) < 2:
            continue
        report["checked"] += 1
        cum = [0.0]
        for a_, b_ in zip(line, line[1:]):
            cum.append(cum[-1] + haversine(a_[1], a_[0], b_[1], b_[0]))
        # ancrage des arrêts sur le tracé : abscisses croissantes, programmation dynamique
        cands = [_project_all(line, cum, p, max_off) for p in sts]
        INF = float("inf")
        best = [[INF] * len(c) for c in cands]
        prev = [[-1] * len(c) for c in cands]
        last_ok = None  # (indice d'arrêt, indice de candidat) le plus récent atteignable
        anchors = [None] * len(sts)
        # DP sur les arrêts ancrables ; un arrêt sans candidat est « sauté » (portion à refaire)
        seq = [i for i, c in enumerate(cands) if c]
        for n, i in enumerate(seq):
            for a, ca in enumerate(cands[i]):
                if n == 0:
                    best[i][a] = ca[1] * 3
                    continue
                j = seq[n - 1]
                for b, cb in enumerate(cands[j]):
                    if best[j][b] < INF and cb[0] <= ca[0] + 1:
                        v = best[j][b] + (ca[0] - cb[0]) + ca[1] * 3
                        if v < best[i][a]:
                            best[i][a], prev[i][a] = v, b
            if all(v == INF for v in best[i]):  # rupture d'ordre : on repart de cet arrêt
                for a, ca in enumerate(cands[i]):
                    best[i][a] = ca[1] * 3
        if seq:
            i = seq[-1]
            a = min(range(len(cands[i])), key=lambda x: best[i][x])
            for n in range(len(seq) - 1, -1, -1):
                i = seq[n]
                anchors[i] = cands[i][a]
                a = prev[i][a] if n else -1
                if a < 0 and n:
                    j = seq[n - 1]
                    a = min(range(len(cands[j])), key=lambda x: best[j][x])
        # portions à refaire : entre arrêts ancrés consécutifs (en sautant les arrêts non ancrés)
        def point_at(an):
            _, _, i, t = an
            a_, b_ = line[i], line[i + 1]
            return (a_[0] + (b_[0] - a_[0]) * t, a_[1] + (b_[1] - a_[1]) * t)

        new, fixed, k = [], 0, 0
        idx = [i for i in range(len(sts)) if anchors[i]]
        if not idx:
            continue
        first = anchors[idx[0]]
        new = line[:first[2] + 1] + [point_at(first)]
        for u, v in zip(idx, idx[1:]):
            A, B = anchors[u], anchors[v]
            seg_len = B[0] - A[0]
            skipped = v - u > 1  # arrêts intermédiaires que le tracé ne dessert pas
            ref_parts = [route(sts[w], sts[w + 1]) for w in range(u, v)]
            ref = sum(p["dist"] for p in ref_parts) if all(ref_parts) else None
            # une abscisse décroissante (arrêts mal ordonnés sur le tracé) n'est pas corrigée : cas ambigu
            bad = ref is not None and seg_len > 0 and (skipped or seg_len > max(ratio * ref, ref + slack_m))
            if bad:
                fixed += 1
                for p in ref_parts:
                    new += [tuple(c) for c in p["geom"]]
                new.append(point_at(B))
                report["worst"].append((f["properties"]["route"], round(seg_len), round(ref), skipped))
                old = line[A[2] + 1:B[2] + 1]
                props = {"route": f["properties"]["route"], "from": f["properties"]["from"], "to": f["properties"]["to"],
                         "len": round(seg_len), "ref": round(ref)}
                report["portions"].append({"type": "Feature", "properties": {**props, "v": "avant"},
                                           "geometry": {"type": "LineString", "coordinates": [point_at(A)] + old + [point_at(B)]}})
                report["portions"].append({"type": "Feature", "properties": {**props, "v": "après"},
                                           "geometry": {"type": "LineString", "coordinates": [c for p in ref_parts for c in p["geom"]]}})
            else:
                new += line[A[2] + 1:B[2] + 1] + [point_at(B)]
        last = anchors[idx[-1]]
        new += line[last[2] + 1:]
        new, spurs = remove_spurs(new, sts)
        report["spurs_removed"] = report.get("spurs_removed", 0) + spurs
        if fixed or spurs:
            report["fixed_features"] += 1
            report["fixed_portions"] += fixed
            f["geometry"]["coordinates"] = simplify([(round(x, 5), round(y, 5)) for x, y in new], 3.5)
    json.dump(cache, open(cache_path, "w"))
    log(f"contrôle des tracés : {report['checked']} tracés, {report['fixed_portions']} portions refaites sur {report['fixed_features']} tracés, "
        f"{report.get('spurs_removed', 0)} éperons supprimés")
    return report


# ---------------------------------------------------------------- tracés ferroviaires

def rail_route(feats, osrm_url, cache_path, radius=500, max_ratio=1.6, chunk=100):
    """
    Trace chaque ligne de train de gare en gare sur les voies ferrées OSM (moteur OSRM au profil
    « rail »). Garde-fou : si la route fait plus de max_ratio × la ligne droite, on garde l'original.
    """
    import hashlib
    try:
        fetch_json(f"{osrm_url}/nearest/v1/driving/4.79,45.37")
    except Exception as e:
        log(f"tracés ferroviaires : moteur OSRM rail injoignable à {osrm_url} ({e}) — étape ignorée")
        return None
    cache = json.load(open(cache_path)) if os.path.exists(cache_path) else {}
    done = kept = 0
    for f in feats:
        if f["properties"].get("kind") != "train":
            continue
        stations = [tuple(x) for x in f["geometry"]["coordinates"]]
        out = []
        for k in range(0, max(1, len(stations) - 1), chunk - 1):
            ch = stations[k:k + chunk]
            if len(ch) < 2:
                break
            key = hashlib.md5(("rail:" + ";".join(f"{x:.5f},{y:.5f}" for x, y in ch)).encode()).hexdigest()
            if key not in cache:
                url = (f"{osrm_url}/route/v1/driving/" + ";".join(f"{x:.6f},{y:.6f}" for x, y in ch) +
                       "?overview=full&geometries=geojson&continue_straight=true&radiuses=" + ";".join([str(radius)] * len(ch)))
                try:
                    r = fetch_json(url)
                    rt = r["routes"][0] if r.get("code") == "Ok" else None
                    cache[key] = {"geom": rt["geometry"]["coordinates"], "dist": rt["distance"]} if rt else None
                except Exception:
                    cache[key] = None
            hit = cache[key]
            straight = sum(haversine(a[1], a[0], b[1], b[0]) for a, b in zip(ch, ch[1:]))
            if hit and hit["dist"] <= max_ratio * straight + 3000:
                seg = [tuple(c) for c in hit["geom"]]
            else:
                # échec global (gare hors de l'extrait OSM, par ex.) : on route gare par gare,
                # les tronçons impossibles restent droits
                seg = [ch[0]]
                for a_, b_ in zip(ch, ch[1:]):
                    k2 = hashlib.md5((f"rail2:{a_[0]:.5f},{a_[1]:.5f};{b_[0]:.5f},{b_[1]:.5f}").encode()).hexdigest()
                    if k2 not in cache:
                        try:
                            r = fetch_json(f"{osrm_url}/route/v1/driving/{a_[0]:.6f},{a_[1]:.6f};{b_[0]:.6f},{b_[1]:.6f}"
                                           f"?overview=full&geometries=geojson&radiuses={radius};{radius}")
                            rt = r["routes"][0] if r.get("code") == "Ok" else None
                            cache[k2] = {"geom": rt["geometry"]["coordinates"], "dist": rt["distance"]} if rt else None
                        except Exception:
                            cache[k2] = None
                    h2 = cache[k2]
                    if h2 and h2["dist"] <= max_ratio * haversine(a_[1], a_[0], b_[1], b_[0]) + 3000:
                        seg += [tuple(c) for c in h2["geom"]][1:]
                    else:
                        seg.append(b_)
                        kept += 1
            out += seg if not out else seg[1:]
        if len(out) >= 2:
            f["geometry"]["coordinates"] = simplify([(round(x, 5), round(y, 5)) for x, y in out], 12.0)
            f["properties"]["railed"] = 1
        done += 1
    json.dump(cache, open(cache_path, "w"))
    log(f"tracés ferroviaires : {done} lignes TER tracées sur les voies, {kept} tronçons entre gares laissés droits (hors de l'extrait OSM)")
    return {"routed_features": done, "kept_straight": kept}

# ---------------------------------------------------------------- corrections manuelles (éditeur de tracés)

def load_corrections(path):
    """Corrections saisies dans l'éditeur (editeur.html) : pipeline/tenants/<territoire>-corrections.json."""
    if not os.path.exists(path):
        return []
    with open(path, encoding="utf-8") as fh:
        return json.load(fh).get("corrections", [])


def _along(line, p, min_along=0.0, max_off=60.0):
    """Projection de p sur la polyligne (lon, lat) à partir de l'abscisse min_along : (abscisse, segment, point)
    de l'écart le plus faible sous max_off, en privilégiant la première occurrence (lignes qui repassent)."""
    lat0 = p[1]
    kx, ky = 111320 * math.cos(math.radians(lat0)), 110540
    best, acc = None, 0.0
    for i in range(len(line) - 1):
        ax, ay = (line[i][0] - p[0]) * kx, (line[i][1] - p[1]) * ky
        bx, by = (line[i + 1][0] - p[0]) * kx, (line[i + 1][1] - p[1]) * ky
        vx, vy = bx - ax, by - ay
        L = math.hypot(vx, vy)
        t = 0.0 if L < 1e-9 else max(0.0, min(1.0, -(ax * vx + ay * vy) / (L * L)))
        off = math.hypot(ax + t * vx, ay + t * vy)
        s = acc + t * L
        if s >= min_along - 1e-6 and off <= max_off and (best is None or off < best[3] - 5):
            q = (line[i][0] + t * (line[i + 1][0] - line[i][0]), line[i][1] + t * (line[i + 1][1] - line[i][1]))
            best = (s, i, q, off)
            if off < 5:
                break  # première occurrence nette : on s'arrête (un tracé peut repasser par le même arrêt)
        acc += L
    return best


def apply_corrections(feats, corrections, key_of, near_m=60.0):
    """
    Remplace, dans chaque tracé, la portion entre deux arrêts consécutifs par le tronçon corrigé à la main
    (clé : ligne, type, arrêts de départ et d'arrivée par leur position). Une correction vaut pour toutes
    les variantes et tous les tracés qui enchaînent ces deux arrêts ; elle survit au renouvellement des
    horaires (pas d'identifiant d'arrêt). Renvoie (tracés modifiés, corrections jamais appliquées).
    """
    if not corrections:
        return 0, []
    used, changed = set(), 0
    for f in feats:
        stops = f.get("_stops")
        if not stops:
            continue
        mine = [c for c in corrections if (c["route"], c.get("kind", "urbain")) == key_of(f["properties"]["route"])]
        if not mine:
            continue
        line = [tuple(x) for x in f["geometry"]["coordinates"]]
        modified = False
        for c in mine:
            fa, fb = c["from"], c["to"]
            for i in range(len(stops) - 1):
                a, b = stops[i], stops[i + 1]
                if haversine(a[1], a[0], fa["lat"], fa["lon"]) > near_m or haversine(b[1], b[0], fb["lat"], fb["lon"]) > near_m:
                    continue
                pa = _along(line, a)
                pb = _along(line, b, pa[0] if pa else 0.0) if pa else None
                if not pa or not pb or pb[0] <= pa[0]:
                    continue
                corr = [tuple(x) for x in c["coords"]]
                line = line[:pa[1] + 1] + [pa[2]] + corr + [pb[2]] + line[pb[1] + 1:]
                used.add(c["id"])
                modified = True
        if modified:
            f["geometry"]["coordinates"] = [[round(x, 6), round(y, 6)] for x, y in line]
            f["properties"]["corrected"] = 1
            changed += 1
    return changed, [c for c in corrections if c["id"] not in used]


# ---------------------------------------------------------------- tracé d'affichage : un seul trait par rue

def display_lines(feats, tol_m=25.0, step_m=10.0, min_run_m=40.0):
    """
    Tracé dessiné sur la carte : pour chaque ligne, chaque rue n'est tracée qu'une fois, quel que soit le
    nombre de sens et de variantes qui l'empruntent (à tol_m près, la tolérance des flèches de sens unique).
    Les tracés sont pris du plus long au plus court ; d'un tracé, on ne garde que les portions qu'aucun
    tracé déjà retenu ne couvre (plus longues que min_run_m), raccordées à leurs voisins.
    lines.geojson reste inchangé : il sert aux info-bulles et au découpage des itinéraires.
    """
    def xy(lon, lat, lat0):
        return (lon * 111320 * math.cos(math.radians(lat0)), lat * 110540)

    def length(c):
        return sum(haversine(a[1], a[0], b[1], b[0]) for a, b in zip(c, c[1:]))

    by_route = defaultdict(list)
    for f in feats:
        by_route[f["properties"]["route"]].append(f)
    out = []
    cell = 40.0
    for route, fs in by_route.items():
        lat0 = fs[0]["geometry"]["coordinates"][0][1]
        segs, grid = [], defaultdict(list)

        def add(coords):
            c = [xy(x, y, lat0) for x, y in coords]
            for (x1, y1), (x2, y2) in zip(c, c[1:]):
                k = len(segs)
                segs.append((x1, y1, x2, y2))
                for gx in range(int(min(x1, x2) // cell) - 1, int(max(x1, x2) // cell) + 2):
                    for gy in range(int(min(y1, y2) // cell) - 1, int(max(y1, y2) // cell) + 2):
                        grid[(gx, gy)].append(k)

        def covered(px, py):
            for k in grid.get((int(px // cell), int(py // cell)), ()):
                ax, ay, bx, by = segs[k]
                vx, vy = bx - ax, by - ay
                L2 = vx * vx + vy * vy
                t = 0.0 if L2 < 1e-9 else max(0.0, min(1.0, ((px - ax) * vx + (py - ay) * vy) / L2))
                if math.hypot(px - ax - t * vx, py - ay - t * vy) <= tol_m:
                    return True
            return False

        props = fs[0]["properties"]
        for f in sorted(fs, key=lambda f: -length(f["geometry"]["coordinates"])):
            coords = f["geometry"]["coordinates"]
            # polyligne densifiée (sommets d'origine + points tous les step_m), chaque point marqué couvert ou non
            dense = []
            for a, b in zip(coords, coords[1:]):
                n = max(1, int(haversine(a[1], a[0], b[1], b[0]) // step_m))
                for j in range(n):
                    dense.append((a[0] + (b[0] - a[0]) * j / n, a[1] + (b[1] - a[1]) * j / n))
            dense.append(tuple(coords[-1]))
            flags = [covered(*xy(x, y, lat0)) for x, y in dense]
            pieces, i = [], 0
            while i < len(dense):
                if flags[i]:
                    i += 1
                    continue
                j = i
                while j + 1 < len(dense) and not flags[j + 1]:
                    j += 1
                piece = dense[max(0, i - 1): j + 2]  # raccord avec la portion déjà tracée
                if len(piece) >= 2 and length(piece) >= min_run_m:
                    pieces.append(simplify([(round(x, 5), round(y, 5)) for x, y in piece], 2.0))
                i = j + 1
            for p in pieces:  # ajoutées après coup : un tracé ne se couvre pas lui-même en cours de route
                add(p)
                out.append({"type": "Feature", "properties": {"route": route, "color": props.get("color"), "kind": props.get("kind")},
                            "geometry": {"type": "LineString", "coordinates": p}})
    return out


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
        if feed.get("extract"):
            # très gros flux (horaire national suisse) : on n'en garde que les courses du mode voulu
            # qui desservent la zone, dans un petit GTFS (pipeline/extract_gtfs.py)
            ex = feed["extract"]
            srcs = []
            for k, u in enumerate(ex["sources"]):
                sp = os.path.join(args.cache, f"{fid}-source{k}.zip")
                download(u, sp, max_age_h=ex.get("max_age_h", 72))
                srcs.append(sp)
            if not os.path.exists(path) or any(os.path.getmtime(sp) > os.path.getmtime(path) for sp in srcs):
                import importlib.util
                spec = importlib.util.spec_from_file_location("extract_gtfs", os.path.join(os.path.dirname(os.path.abspath(__file__)), "extract_gtfs.py"))
                mod = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(mod)
                mod.extract(srcs, path, ex["lat"], ex["lon"], ex["radius_km"])
            meta = {"last_modified": None}
        else:
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
        # lignes déjà fournies par un autre flux (ex. Léman Express et TER, présents dans le flux SNCF)
        excl_short = feed.get("filter", {}).get("exclude_route_short_regex")
        for r in g.rows("routes.txt"):
            ag = agencies.get(r.get("agency_id", ""), next(iter(agencies.values()), ""))
            if any(e in ag.lower() for e in excl):
                continue
            if excl_short and re.fullmatch(excl_short, (r.get("route_short_name") or "").strip()):
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
            short0 = (r.get("route_short_name") or "").replace("Ligne ", "").strip()
            if not re.fullmatch(r"[0-9A-F]{6}", color) and short0 in feed.get("route_colors", {}):
                color = feed["route_colors"][short0].lstrip("#").upper()  # couleur absente du flux : fixée dans la configuration
                rep["fixes"]["couleur_ligne_ajoutee"] += 1
            if not re.fullmatch(r"[0-9A-F]{6}", color):
                color = {"region": "3F5873", "tad": "6B4FA0", "train": "1E3A8A"}.get(kind, "4B5563")
            short = (r.get("route_short_name") or "").replace("Ligne ", "").strip()
            long_ = nice_name(r.get("route_long_name") or "")
            long_ = re.sub(r"^(Ligne\s+(0?" + re.escape(short) + r"|\d+)\b|" + re.escape(short) + r"\b)\s*(-\s*)?", "", long_).strip() if short else long_
            if kind == "train" and feed.get("route_color"):
                color = feed["route_color"].lstrip("#").upper()
            routes[rid] = {"short": short, "pill": short if feed.get("train_pill") == "short" else None,
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


    # ------------------------------------------------ noms de lignes absents du flux : « origine – terminus » le plus fréquent
    ends_by_route = defaultdict(Counter)
    for t in trips:
        ends_by_route[t["route"]][(places[place_of[t["stops"][0]]]["name"], places[place_of[t["stops"][-1]]]["name"])] += 1
    for rid, r in routes.items():
        if r["long"] or not ends_by_route[rid]:
            continue
        pairs = ends_by_route[rid]
        a, b = pairs.most_common(1)[0][0]
        r["long"] = f"{a} – {b}" if a != b else f"Boucle {a}"
        rep_f = next((f for f in feeds_report if rid.startswith(f["id"] + ":")), None)
        if rep_f is not None:
            rep_f["fixes"]["nom_de_ligne_ajoute"] = rep_f["fixes"].get("nom_de_ligne_ajoute", 0) + 1

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
        "tenant": {k: cfg[k] for k in ("tenant", "name", "territory", "center", "bbox", "links", "default_place", "data_gaps", "credits", "fares_note") if k in cfg},
        "booking": {f["id"]: f["booking"] for f in cfg["feeds"] if f.get("booking")},
        "window_start": win_start.isoformat(),
        "window_days": win_days,
        "feeds": feeds_report,
        "reconciliation": {"stops": len(ids), "places": len(places), "cross_feed_merges": cross_merges},
        "routes": [[routes[r]["short"], routes[r]["long"], routes[r]["color"], routes[r]["text"], routes[r]["kind"], routes[r]["agency"]]
                   + ([routes[r]["pill"]] if routes[r].get("pill") else []) for r in route_ids],
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
                      "geometry": {"type": "LineString", "coordinates": coords},
                      # arrêts desservis, dans l'ordre (contrôle des tracés ; retiré avant écriture)
                      "_stops": [(stops[s]["lon"], stops[s]["lat"]) for s in t["stops"]]})

    if reversed_shapes:
        log(f"tracés : {reversed_shapes} formes retournées pour suivre le sens de circulation")
    snap_cfg = cfg.get("snap_to_roads")
    if snap_cfg and snap_cfg.get("enabled") and not args.no_snap:
        out["shapes"] = snap_to_roads(feats, os.path.join(args.cache, "osrm-cache.json"), snap_cfg["osrm_url"].rstrip("/"),
                                      skip_kinds=set(snap_cfg.get("skip_kinds", [])))
    # trains : tracés de gare en gare sur les voies ferrées (moteur OSRM local, profil rail)
    rail_cfg = cfg.get("rail_route")
    if rail_cfg and rail_cfg.get("enabled") and not args.no_snap:
        rr = rail_route(feats, rail_cfg["osrm_url"].rstrip("/"), os.path.join(args.cache, "osrm-rail-cache.json"))
        if rr:
            out["rail_shapes"] = rr
    # appariement fin sur la chaussée (moteur OSRM local, profil bus), prioritaire pour le réseau du territoire
    match_cfg = cfg.get("match_to_roads")
    if match_cfg and match_cfg.get("enabled") and not args.no_snap:
        rep = match_to_roads(feats, match_cfg["osrm_url"].rstrip("/"), set(match_cfg["kinds"]),
                             os.path.join(args.cache, "osrm-match-cache.json"), drop_spurs=bool(match_cfg.get("drop_spurs")))
        if rep:
            out["shapes_quality"] = {route_ids_idx: v for route_ids_idx, v in rep.items()}
            for ri, v in sorted(rep.items(), key=lambda x: -x[1]["p95_m"]):
                log(f"    {routes[route_ids[ri]]['short']:7} écart corrigé médian {v['median_m']:5.1f} m · p95 {v['p95_m']:5.1f} m · max {v['max_m']:6.1f} m"
                    f" · blocs gardés {v['kept_original']}/{v['blocks']}")
    # contrôle final : chaque portion entre deux arrêts comparée au plus court chemin routier
    if match_cfg and match_cfg.get("enabled") and not args.no_snap:
        chk = check_against_stops(feats, match_cfg["osrm_url"].rstrip("/"), set(match_cfg.get("check_kinds", ["region"])),
                                  os.path.join(args.cache, "osrm-check-cache.json"))
        if chk:
            # portions refaites (avant / après) : fichier de contrôle visuel, hors application
            with open(os.path.join(args.cache, "shapes-check.geojson"), "w") as fh:
                json.dump({"type": "FeatureCollection", "features": chk.pop("portions")}, fh)
            chk.pop("worst", None)
            out["shapes_check"] = chk
        # dernière passe : éperons réintroduits par les portions refaites (option « drop_spurs »)
        n_sp = 0
        for f in feats:
            if match_cfg.get("drop_spurs") and f["properties"].get("kind") in set(match_cfg["kinds"]):
                c0 = f["geometry"]["coordinates"]
                c1 = drop_short_spurs(c0, f.get("_stops", ()))
                if len(c1) != len(c0):
                    f["geometry"]["coordinates"] = [list(x) for x in c1]
                    n_sp += 1
        if match_cfg.get("drop_spurs"):
            log(f"éperons : {n_sp} tracés nettoyés")
    # tracés calculés, avant corrections manuelles (base de pipeline/apply_corrections.py, réversible)
    with open(os.path.join(args.cache, f"{cfg['tenant']}-lines-auto.json"), "w", encoding="utf-8") as fh:
        json.dump({"type": "FeatureCollection", "features": feats}, fh, separators=(",", ":"))
    # corrections manuelles de l'éditeur de tracés (editeur.html), en dernier : elles priment
    corr_path = os.path.join(os.path.dirname(os.path.abspath(args.tenant)), f"{cfg['tenant']}-corrections.json")
    corrections = load_corrections(corr_path)
    if corrections:
        n_corr, unused = apply_corrections(feats, corrections, lambda ri: (routes[route_ids[ri]]["short"], routes[route_ids[ri]]["kind"]))
        log(f"corrections manuelles : {len(corrections) - len(unused)}/{len(corrections)} appliquées, {n_corr} tracés modifiés")
        for c in unused:
            log(f"  ⚠ correction sans effet (arrêts introuvables sur la ligne {c['route']}) : {c['from']['name']} → {c['to']['name']}")
    for f in feats:
        f.pop("_stops", None)
    with open(os.path.join(args.out, "network.json"), "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False, separators=(",", ":"))
    # portions à sens unique (flèches de sens uniquement là où l'aller et le retour diffèrent)
    arrows = oneway_pieces(feats)
    with open(os.path.join(args.out, "oneway.geojson"), "w", encoding="utf-8") as fh:
        json.dump({"type": "FeatureCollection", "features": arrows}, fh, separators=(",", ":"))
    log(f"sens unique : {len(arrows)} portions où l'aller et le retour ne suivent pas le même chemin")
    with open(os.path.join(args.out, "lines.geojson"), "w", encoding="utf-8") as fh:
        json.dump({"type": "FeatureCollection", "features": feats}, fh, separators=(",", ":"))
    # tracé d'affichage : un seul trait par rue et par ligne (aller, retour et variantes confondus)
    shown = display_lines(feats)
    with open(os.path.join(args.out, "lines-display.geojson"), "w", encoding="utf-8") as fh:
        json.dump({"type": "FeatureCollection", "features": shown}, fh, separators=(",", ":"))
    log(f"tracé d'affichage : {len(feats)} tracés → {len(shown)} portions, "
        f"{os.path.getsize(os.path.join(args.out, 'lines-display.geojson')) // 1024} Ko")

    # tarifs (fichier relevé à part, en attendant un flux GTFS-Fares publié par le réseau)
    if cfg.get("fares_file"):
        src = os.path.join(os.path.dirname(args.tenant), cfg["fares_file"])
        shutil.copyfile(src, os.path.join(args.out, "fares.json"))
        log(f"tarifs : {len(json.load(open(src))['fares'])} titres copiés depuis {cfg['fares_file']}")

    # registre des territoires (page d'accueil « choisir un territoire »), à côté des dossiers de données
    reg_path = os.path.join(os.path.dirname(os.path.abspath(args.out)), "tenants.json")
    reg = json.load(open(reg_path, encoding="utf-8")) if os.path.exists(reg_path) else []
    entry = {"id": cfg["tenant"], "name": cfg["name"], "territory": cfg["territory"], "tagline": cfg.get("tagline", ""),
             "lines": len(route_ids), "stops": len(places), "updated": today.isoformat()}
    reg = [x for x in reg if x.get("id") != cfg["tenant"]] + [entry]
    reg.sort(key=lambda x: x["name"])
    with open(reg_path, "w", encoding="utf-8") as fh:
        json.dump(reg, fh, ensure_ascii=False, indent=1)

    size = os.path.getsize(os.path.join(args.out, "network.json")) / 1024
    size2 = os.path.getsize(os.path.join(args.out, "lines.geojson")) / 1024
    log(f"OK : {len(route_ids)} lignes, {len(trips)} courses, {len(ids)} arrêts, {len(foot)} correspondances à pied "
        f"→ network.json {size:.0f} Ko, lines.geojson {size2:.0f} Ko")

if __name__ == "__main__":
    main()
