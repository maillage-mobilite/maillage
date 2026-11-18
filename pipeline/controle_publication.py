#!/usr/bin/env python3
"""Contrôle des données AVANT publication (deploy/vps/publier.sh).

Compare les données fraîchement construites à celles en ligne et refuse la publication si
quelque chose cloche : fichier manquant ou illisible, horaires qui ne couvrent pas les jours à venir,
réseau qui perd brutalement des lignes, des arrêts ou des courses (flux tronqué, mauvais fichier publié…),
encart de commune absent. Les données en ligne restent alors inchangées.

Usage : python3 -I pipeline/controle_publication.py <nouvelles données> [<données en ligne>] [--changements fichier.txt]
Code de sortie 1 en cas de refus. Avec --changements, écrit un résumé lisible des différences
(nouvelles versions de flux, nombre de lignes, d'arrêts, de courses), vide s'il n'y en a pas.
"""
import argparse
import datetime as dt
import json
import os
import sys
from zoneinfo import ZoneInfo

# baisse tolérée par rapport à la version en ligne (au-delà : refus)
MAX_BAISSE = 0.2
# les horaires doivent couvrir au moins ces jours à partir d'aujourd'hui
JOURS_MIN = 7
FICHIERS = ["network.json", "lines.geojson", "lines-display.geojson", "oneway.geojson", "pois.json"]


def lire(path):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def chiffres(net):
    return {"lignes": len(net["routes"]), "arrêts": len(net["stops"]), "courses": len(net["trips"])}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("nouveau")
    ap.add_argument("en_ligne", nargs="?")
    ap.add_argument("--changements")
    args = ap.parse_args()

    today = dt.datetime.now(ZoneInfo("Europe/Paris")).date()
    refus, changements = [], []
    try:
        tenants = lire(os.path.join(args.nouveau, "tenants.json"))
    except Exception as e:
        sys.exit(f"REFUS : registre des territoires illisible ({e})")
    old_ids = set()
    if args.en_ligne and os.path.exists(os.path.join(args.en_ligne, "tenants.json")):
        old_ids = {t["id"] for t in lire(os.path.join(args.en_ligne, "tenants.json"))}
    if old_ids - {t["id"] for t in tenants}:
        refus.append(f"territoire(s) disparu(s) : {', '.join(sorted(old_ids - {t['id'] for t in tenants}))}")

    for t in tenants:
        tid, name = t["id"], t["name"]
        d = os.path.join(args.nouveau, tid)
        try:
            docs = {f: lire(os.path.join(d, f)) for f in FICHIERS}
        except Exception as e:
            refus.append(f"{name} : fichier manquant ou illisible ({e})")
            continue
        net = docs["network.json"]
        start = dt.date.fromisoformat(net["window_start"])
        end = start + dt.timedelta(days=net["window_days"] - 1)
        if start > today:
            refus.append(f"{name} : les horaires commencent le {start:%d/%m/%Y}, après aujourd'hui")
        if (end - today).days < JOURS_MIN:
            refus.append(f"{name} : horaires seulement jusqu'au {end:%d/%m/%Y} (moins de {JOURS_MIN} jours)")
        if not docs["lines-display.geojson"].get("features"):
            refus.append(f"{name} : aucun tracé de ligne")
        new = chiffres(net)
        print(f"{name} : {new['lignes']} lignes, {new['arrêts']} arrêts, {new['courses']} courses, horaires du {start:%d/%m} au {end:%d/%m/%Y}")

        old_path = os.path.join(args.en_ligne, tid, "network.json") if args.en_ligne else None
        if old_path and os.path.exists(old_path):
            old_net = lire(old_path)
            old = chiffres(old_net)
            for k in new:
                if old[k] and new[k] < old[k] * (1 - MAX_BAISSE):
                    refus.append(f"{name} : {k} en forte baisse ({old[k]} → {new[k]})")
                elif new[k] != old[k]:
                    changements.append(f"{name} : {k} {old[k]} → {new[k]}")
            old_feeds = {f["id"]: f for f in old_net.get("feeds", [])}
            for f in net.get("feeds", []):
                o = old_feeds.get(f["id"])
                if o and (o.get("last_modified"), o.get("end")) != (f.get("last_modified"), f.get("end")):
                    fin = f" (valable jusqu'au {dt.date.fromisoformat(f['end']):%d/%m/%Y})" if f.get("end") else ""
                    changements.append(f"{name} : nouvelle version du flux « {f.get('name', f['id'])} »{fin}")

    # encarts des communes : chaque encart déclaré doit avoir été construit
    reg = os.path.join(os.path.dirname(os.path.abspath(__file__)), "encarts.json")
    for e in lire(reg)["encarts"]:
        p = os.path.join(args.nouveau, e["territoire"], f"widget-{e['slug']}.json")
        if not os.path.exists(p):
            refus.append(f"encart {e['nom']} absent ({p})")

    if args.changements:
        with open(args.changements, "w", encoding="utf-8") as fh:
            fh.write("".join(c + "\n" for c in changements))
    if changements:
        print("Changements par rapport à la version en ligne :")
        for c in changements:
            print("  -", c)
    if refus:
        print(f"\nREFUS de publication ({len(refus)} problème(s)) — les données en ligne ne changent pas :")
        for r in refus:
            print("  -", r)
        sys.exit(1)
    print("Contrôle avant publication : ok")


if __name__ == "__main__":
    main()
