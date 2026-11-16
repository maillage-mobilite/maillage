#!/usr/bin/env python3
"""Extrait d'un très gros GTFS (horaire national suisse : 3,7 Go de stop_times) un petit GTFS limité
aux courses d'un mode (le rail) qui desservent une zone (cercle autour d'un point).

Lecture en flux, en un passage sur stop_times (les lignes d'une même course y sont contiguës ;
sinon, second passage). Plusieurs sources (horaires 2026 et 2027 : le changement de service de
décembre tombe dans la fenêtre du pipeline) sont fusionnées : les service_id sont préfixés par
la source pour éviter les collisions de calendriers.

Utilisé par build_network.py (clé « extract » d'un flux) ; utilisable seul :
  python3 -I pipeline/extract_gtfs.py out.zip src1.zip [src2.zip] --lat 46.21 --lon 6.14 --radius-km 14
"""
import argparse
import csv
import io
import math
import os
import sys
import zipfile

RAIL_TYPES = {"2"} | {str(t) for t in range(100, 118)}


def log(msg):
    print(f"[extrait] {msg}", file=sys.stderr, flush=True)


def haversine(a_lat, a_lon, b_lat, b_lon):
    p1, p2 = math.radians(a_lat), math.radians(b_lat)
    h = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(b_lon - a_lon) / 2) ** 2
    return 12742000 * math.asin(math.sqrt(h))


def reader(z, name):
    """Lignes d'un fichier du zip en dictionnaires (BOM retiré)."""
    if name not in z.namelist():
        return iter(())
    return csv.DictReader(io.TextIOWrapper(z.open(name), encoding="utf-8-sig", newline=""))


def fast_rows(z, name):
    """Lignes brutes (listes) : tous les champs du GTFS suisse sont entre guillemets, sans virgule
    ni guillemet interne dans stop_times ; découpage direct, bien plus rapide que le module csv."""
    with z.open(name) as fh:
        text = io.TextIOWrapper(fh, encoding="utf-8-sig", newline="")
        header = next(csv.reader([text.readline()]))
        yield header
        for line in text:
            line = line.rstrip("\r\n")
            if line.startswith('"') and line.endswith('"') and line.count('"') == 2 * (line.count('","') + 1):
                yield line[1:-1].split('","')
            else:
                yield next(csv.reader([line]))


def extract(sources, out_path, lat, lon, radius_km, route_types=RAIL_TYPES):
    keep = {"agency": {}, "routes": {}, "trips": [], "stops": {}, "stop_times": [], "calendar": [], "calendar_dates": []}
    headers = {}
    for si, src in enumerate(sources):
        tag = f"s{si}"
        z = zipfile.ZipFile(src)
        log(f"{os.path.basename(src)}")
        routes = {}
        for r in reader(z, "routes.txt"):
            headers.setdefault("routes", list(r.keys()))
            if r["route_type"] in route_types:
                routes[r["route_id"]] = r
        trips = {}
        for t in reader(z, "trips.txt"):
            headers.setdefault("trips", list(t.keys()))
            if t["route_id"] in routes:
                trips[t["trip_id"]] = t
        stops_all, near = {}, set()
        for s in reader(z, "stops.txt"):
            headers.setdefault("stops", list(s.keys()))
            stops_all[s["stop_id"]] = s
            try:
                if haversine(lat, lon, float(s["stop_lat"]), float(s["stop_lon"])) <= radius_km * 1000:
                    near.add(s["stop_id"])
            except ValueError:
                pass
        log(f"  {len(routes)} lignes ferroviaires, {len(trips)} courses, {len(near)} arrêts dans la zone")

        rows = fast_rows(z, "stop_times.txt")
        h = next(rows)
        headers.setdefault("stop_times", h)
        it, isd = h.index("trip_id"), h.index("stop_id")
        kept_trips, done, cur, buf, hit, n, broken = set(), set(), None, [], False, 0, False
        out_st = []

        def flush():
            if cur is not None and hit:
                kept_trips.add(cur)
                out_st.extend(buf)

        for row in rows:
            n += 1
            tid = row[it]
            if tid != cur:
                flush()
                if cur is not None:
                    done.add(cur)
                if tid in done:
                    broken = True
                cur, buf, hit = tid, [], False
            if tid in trips:
                buf.append(row)
                if row[isd] in near:
                    hit = True
            if n % 5_000_000 == 0:
                log(f"  {n // 1_000_000} M horaires lus, {len(kept_trips)} courses retenues")
        flush()
        if broken:
            # lignes d'une course non contiguës : second passage, sur les seules courses retenues ou touchant la zone
            log("  stop_times non groupé par course : second passage")
            touch = set()
            rows = fast_rows(z, "stop_times.txt"); next(rows)
            for row in rows:
                if row[it] in trips and row[isd] in near:
                    touch.add(row[it])
            out_st = []
            rows = fast_rows(z, "stop_times.txt"); next(rows)
            for row in rows:
                if row[it] in touch:
                    out_st.append(row)
            kept_trips = touch
        log(f"  {n} horaires lus : {len(kept_trips)} courses ferroviaires desservent la zone, {len(out_st)} passages")

        used_stops = {row[isd] for row in out_st}
        services = set()
        for tid in kept_trips:
            t = dict(trips[tid])
            services.add(t["service_id"])
            t["service_id"] = f"{tag}:{t['service_id']}"
            keep["trips"].append(t)
            r = routes[t["route_id"]]
            keep["routes"][r["route_id"]] = r
        keep["stop_times"].extend(out_st)
        for sid in used_stops:
            s = stops_all.get(sid)
            if s:
                keep["stops"][sid] = s
                par = s.get("parent_station")
                if par and par in stops_all:
                    keep["stops"][par] = stops_all[par]
        for a in reader(z, "agency.txt"):
            headers.setdefault("agency", list(a.keys()))
            if any(r["agency_id"] == a["agency_id"] for r in keep["routes"].values()):
                keep["agency"][a["agency_id"]] = a
        for c in reader(z, "calendar.txt"):
            headers.setdefault("calendar", list(c.keys()))
            if c["service_id"] in services:
                c["service_id"] = f"{tag}:{c['service_id']}"
                keep["calendar"].append(c)
        rows = fast_rows(z, "calendar_dates.txt")
        h = next(rows)
        headers.setdefault("calendar_dates", h)
        isv = h.index("service_id")
        for row in rows:
            if row[isv] in services:
                row[isv] = f"{tag}:{row[isv]}"
                keep["calendar_dates"].append(row)

    tmp = out_path + ".part"
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as zo:
        for name, data in keep.items():
            if name not in headers:
                continue
            buf = io.StringIO()
            w = csv.writer(buf, lineterminator="\n")
            h = headers[name]
            w.writerow(h)
            items = data.values() if isinstance(data, dict) else data
            for x in items:
                w.writerow([x.get(k, "") for k in h] if isinstance(x, dict) else x)
            zo.writestr(f"{name}.txt", buf.getvalue())
    os.replace(tmp, out_path)
    log(f"→ {out_path} : {len(keep['routes'])} lignes, {len(keep['trips'])} courses, {len(keep['stops'])} arrêts "
        f"({os.path.getsize(out_path) // 1024} Ko)")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("out")
    ap.add_argument("sources", nargs="+")
    ap.add_argument("--lat", type=float, required=True)
    ap.add_argument("--lon", type=float, required=True)
    ap.add_argument("--radius-km", type=float, default=14)
    a = ap.parse_args()
    extract(a.sources, a.out, a.lat, a.lon, a.radius_km)
