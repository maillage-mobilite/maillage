#!/usr/bin/env python3
"""Résumé de la mesure d'usage (journal usage.log écrit par nginx, sans IP ni cookie).

Lit le journal sur l'entrée standard (voir stats.sh) :
  <date ISO> <encart|appli> <compte|-> <site d'origine|-> <reseau>- <commune>- <src>- <appareil>
Compte des affichages et des ouvertures, pas des personnes : sans IP ni cookie, on ne distingue
pas un habitant qui revient de deux habitants différents.

Usage : python3 -I stats.py [--days 30] < usage.log
"""
import argparse
import collections
import datetime as dt
import sys
from zoneinfo import ZoneInfo

PARIS = ZoneInfo("Europe/Paris")
JOURS = ["lun.", "mar.", "mer.", "jeu.", "ven.", "sam.", "dim."]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=30, help="période analysée, en jours (défaut 30)")
    args = ap.parse_args()
    today = dt.datetime.now(PARIS).date()
    since = today - dt.timedelta(days=args.days - 1)

    rows = []
    for line in sys.stdin:
        p = line.split()
        if len(p) != 8:
            continue
        day = dt.datetime.fromisoformat(p[0]).astimezone(PARIS).date()
        if day < since:
            continue
        strip = lambda v: v[:-1] if v.endswith("-") else v
        rows.append({"day": day, "evt": p[1], "user": None if p[2] == "-" else p[2],
                     "ref": None if p[3] == "-" else p[3].removeprefix("www."),
                     "reseau": strip(p[4]), "commune": strip(p[5]), "src": strip(p[6]), "device": p[7]})

    enc = [r for r in rows if r["evt"] == "encart"]
    app = [r for r in rows if r["evt"] == "appli"]
    clicks = [r for r in app if r["src"] == "encart"]
    print(f"Mesure d'usage Maillage — du {since:%d/%m/%Y} au {today:%d/%m/%Y} ({args.days} jours)")
    print("(affichages et ouvertures, pas des personnes : ni IP ni cookie)\n")

    print(f"Encart « prochains départs » : {len(enc)} affichage(s)")
    by_site = collections.Counter((r["commune"] or "?", r["ref"] or "lien direct") for r in enc)
    for (commune, ref), n in by_site.most_common():
        print(f"  {commune:<12} sur {ref:<28} {n:>6}")
    dev = collections.Counter(r["device"] for r in enc)
    if dev:
        print("  appareils : " + ", ".join(f"{k} {v * 100 // len(enc)} %" for k, v in dev.most_common()))
    print(f"  clics « Calculer un itinéraire » : {len(clicks)}"
          + (f" ({len(clicks) * 100 / len(enc):.1f} % des affichages)" if enc else ""))

    print(f"\nApplication (comptes privés) : {len(app)} ouverture(s)")
    users = collections.defaultdict(list)
    for r in app:
        users[r["user"] or "?"].append(r["day"])
    for u, days in sorted(users.items(), key=lambda kv: -len(kv[1])):
        print(f"  {u:<16} {len(days):>4} ouverture(s) sur {len(set(days))} jour(s), dernière le {max(days):%d/%m}")

    n = min(14, args.days)
    print(f"\nPar jour ({n} derniers jours)".ljust(36) + "encart  appli")
    per = collections.Counter((r["day"], r["evt"]) for r in rows)
    for i in range(n - 1, -1, -1):
        d = today - dt.timedelta(days=i)
        print(f"  {JOURS[d.weekday()]} {d:%d/%m}".ljust(36) + f"{per[(d, 'encart')]:>6} {per[(d, 'appli')]:>6}")


if __name__ == "__main__":
    main()
