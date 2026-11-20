#!/usr/bin/env python3
"""Construit les encarts de toutes les communes listées dans pipeline/encarts.json.

Usage : python3 -I pipeline/build_encarts.py public/data
"""
import json, os, subprocess, sys

here = os.path.dirname(os.path.abspath(__file__))
datadir = sys.argv[1] if len(sys.argv) > 1 else "public/data"
with open(os.path.join(here, "encarts.json"), encoding="utf-8") as fh:
    encarts = json.load(fh)["encarts"]
for e in encarts:
    subprocess.run([sys.executable, "-I", os.path.join(here, "build_widget.py"), os.path.join(datadir, e["territoire"]),
                    "--slug", e["slug"], "--name", e["nom"], "--places", *e["poles"],
                    *(["--commune", e["commune_osm"]] if e.get("commune_osm") else [])], check=True)
print(f"{len(encarts)} encart(s) construit(s)")
