#!/usr/bin/env python3
"""Contrôle des tracés : part des points (tous les 40 m) à plus de 15 et 30 m de la route la plus proche,
ligne par ligne, avec les pires endroits. Nécessite le moteur OSRM du territoire.

Usage : python3 -I pipeline/controle_traces.py public/data/paysdegex/lines.geojson http://localhost:5057 urbain
"""
import json, math, sys, urllib.request, concurrent.futures as cf
geo, osrm, kinds = sys.argv[1], sys.argv[2], set(sys.argv[3].split(','))
g = json.load(open(geo))
def hav(a, b):
    p1, p2 = math.radians(a[1]), math.radians(b[1]); dp = p2 - p1; dl = math.radians(b[0] - a[0])
    return 12742000 * math.asin(math.sqrt(math.sin(dp/2)**2 + math.cos(p1)*math.cos(p2)*math.sin(dl/2)**2))
def sample(c, step=40):
    out, acc = [tuple(c[0])], 0
    for a, b in zip(c, c[1:]):
        L = hav(a, b); t = step - acc
        while t <= L:
            out.append((a[0] + (b[0]-a[0])*t/L, a[1] + (b[1]-a[1])*t/L)); t += step
        acc = (acc + L) % step if L else acc
    return out
def near(p):
    try:
        r = json.load(urllib.request.urlopen(f"{osrm}/nearest/v1/driving/{p[0]:.6f},{p[1]:.6f}", timeout=10))
        return r["waypoints"][0]["distance"]
    except Exception: return None
pts = []
for fi, f in enumerate(g["features"]):
    if f["properties"].get("kind") in kinds:
        for p in sample(f["geometry"]["coordinates"]): pts.append((fi, p))
with cf.ThreadPoolExecutor(16) as ex: dists = list(ex.map(lambda x: near(x[1]), pts))
by = {}
for (fi, p), d in zip(pts, dists):
    if d is None: continue
    r = g["features"][fi]["properties"]["route"]; s = by.setdefault(r, {"n": 0, "off15": 0, "off30": 0, "hot": []})
    s["n"] += 1
    if d > 15: s["off15"] += 1
    if d > 30: s["off30"] += 1; s["hot"].append((round(d), round(p[1], 5), round(p[0], 5)))
net = json.load(open(geo.replace('lines.geojson', 'network.json')))
tot = [0, 0, 0]
for r, s in sorted(by.items(), key=lambda kv: -kv[1]["off30"] / max(1, kv[1]["n"])):
    tot[0] += s["n"]; tot[1] += s["off15"]; tot[2] += s["off30"]
    print(f"{net['routes'][r][0]:8} points {s['n']:5}  >15 m {100*s['off15']/s['n']:5.1f} %  >30 m {100*s['off30']/s['n']:5.1f} %  pires: {sorted(s['hot'], reverse=True)[:3]}")
print(f"TOTAL points {tot[0]}  >15 m {100*tot[1]/tot[0]:.1f} %  >30 m {100*tot[2]/tot[0]:.1f} %")
