#!/usr/bin/env python3
"""Applique les corrections manuelles de l'éditeur de tracés sans relancer tout le pipeline.

Part des tracés calculés avant corrections (.cache/<territoire>-lines-auto.json, écrit par build_network.py),
applique pipeline/tenants/<territoire>-corrections.json, puis réécrit lines.geojson et, pour les seules lignes
dont le tracé a changé, les flèches de sens unique et le tracé d'affichage. Retirer une correction et relancer
ce script rend le tracé calculé : l'opération est réversible.

Usage : python3 -I pipeline/apply_corrections.py pipeline/tenants/paysdegex.json --cache .cache --out public/data/paysdegex
"""
import argparse
import importlib.util
import json
import os
import sys

here = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("build_network", os.path.join(here, "build_network.py"))
bn = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bn)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("tenant")
    ap.add_argument("--cache", default=".cache")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    cfg = json.load(open(args.tenant, encoding="utf-8"))
    tid = cfg["tenant"]
    auto_path = os.path.join(args.cache, f"{tid}-lines-auto.json")
    if not os.path.exists(auto_path):
        sys.exit(f"{auto_path} absent : lancer une fois « npm run data:{tid} »")
    feats = json.load(open(auto_path, encoding="utf-8"))["features"]
    routes = json.load(open(os.path.join(args.out, "network.json"), encoding="utf-8"))["routes"]
    corr_path = os.path.join(os.path.dirname(os.path.abspath(args.tenant)), f"{tid}-corrections.json")
    corrections = bn.load_corrections(corr_path)

    n, unused = bn.apply_corrections(feats, corrections, lambda ri: (routes[ri][0], routes[ri][4]))
    for f in feats:
        f.pop("_stops", None)

    def by_route(path):
        if not os.path.exists(path):
            return {}
        out = {}
        for f in json.load(open(path, encoding="utf-8"))["features"]:
            out.setdefault(f["properties"]["route"], []).append(f)
        return out

    old = by_route(os.path.join(args.out, "lines.geojson"))
    new = {}
    for f in feats:
        new.setdefault(f["properties"]["route"], []).append(f)
    geom = lambda fs: [f["geometry"]["coordinates"] for f in fs]
    touched = {r for r in new if geom(new[r]) != geom(old.get(r, []))}

    with open(os.path.join(args.out, "lines.geojson"), "w", encoding="utf-8") as fh:
        json.dump({"type": "FeatureCollection", "features": feats}, fh, separators=(",", ":"))
    if touched:
        sub = [f for f in feats if f["properties"]["route"] in touched]
        for name, fn in (("oneway.geojson", bn.oneway_pieces), ("lines-display.geojson", bn.display_lines)):
            path = os.path.join(args.out, name)
            keep = [f for fs in by_route(path).values() for f in fs if f["properties"]["route"] not in touched]
            with open(path, "w", encoding="utf-8") as fh:
                json.dump({"type": "FeatureCollection", "features": keep + fn(sub)}, fh, separators=(",", ":"))

    print(json.dumps({
        "corrections": len(corrections),
        "appliquees": len(corrections) - len(unused),
        "traces_modifies": n,
        "lignes_redessinees": sorted(routes[r][0] for r in touched),
        "sans_effet": [f"{c['route']} : {c['from']['name']} → {c['to']['name']}" for c in unused],
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
