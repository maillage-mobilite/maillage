#!/usr/bin/env python3
"""Alerte d'expiration des données publiées (public/data/<territoire>/network.json).

Pour chaque territoire du registre tenants.json, signale :
  - un flux GTFS dont la validité se termine bientôt (après cette date, plus aucun horaire) ;
  - la fin de la fenêtre d'horaires précalculée par le pipeline (window_start + window_days) ;
  - une nouvelle version d'un flux publiée sur data.gouv.fr depuis la dernière construction.

Code de sortie 1 s'il y a au moins une alerte : utilisé par la tâche planifiée GitLab
(.gitlab-ci.yml à la racine du dépôt), dont l'échec déclenche un e-mail de GitLab.

Usage : python3 -I pipeline/check_data.py public/data [--days 21] [--offline]
"""
import argparse
import datetime as dt
import email.utils
import json
import os
import shutil
import subprocess
import sys
import urllib.request
from zoneinfo import ZoneInfo


def head_last_modified(url):
    try:
        req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": "maillage-check/1.0"})
        with urllib.request.urlopen(req, timeout=30) as res:  # suit les redirections de data.gouv.fr
            lm = res.headers.get("Last-Modified")
    except Exception as e:
        # Python installé depuis python.org sans certificats racine (macOS) : repli sur curl
        if "CERTIFICATE_VERIFY_FAILED" not in str(e) or not shutil.which("curl"):
            raise
        out = subprocess.run(["curl", "-fsSIL", "-A", "maillage-check/1.0", url], capture_output=True, text=True, timeout=60, check=True).stdout
        lm = next((l.split(":", 1)[1].strip() for l in reversed(out.splitlines()) if l.lower().startswith("last-modified:")), None)
    return email.utils.parsedate_to_datetime(lm) if lm else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("datadir")
    ap.add_argument("--days", type=int, default=21, help="seuil d'alerte en jours (défaut 21)")
    ap.add_argument("--offline", action="store_true", help="ne pas interroger data.gouv.fr")
    args = ap.parse_args()

    today = dt.datetime.now(ZoneInfo("Europe/Paris")).date()
    with open(os.path.join(args.datadir, "tenants.json"), encoding="utf-8") as fh:
        tenants = json.load(fh)

    alerts, lines = [], []
    for t in tenants:
        with open(os.path.join(args.datadir, t["id"], "network.json"), encoding="utf-8") as fh:
            net = json.load(fh)
        name = t["name"]
        built = net["generated_at"][:10]
        win_end = dt.date.fromisoformat(net["window_start"]) + dt.timedelta(days=net["window_days"] - 1)
        left = (win_end - today).days
        lines.append(f"\n{name} (données construites le {built})")
        mark = "ALERTE" if left <= args.days else "ok"
        lines.append(f"  [{mark}] horaires précalculés jusqu'au {win_end:%d/%m/%Y} ({left} j)")
        if left <= args.days:
            alerts.append(f"{name} : fenêtre d'horaires finie le {win_end:%d/%m/%Y}, relancer « npm run data » et déployer")
        for f in net["feeds"]:
            end = dt.date.fromisoformat(f["end"]) if f.get("end") else None
            fleft = (end - today).days if end else None
            newer = None
            if not args.offline and f.get("last_modified"):
                try:
                    remote = head_last_modified(f["url"])
                    known = email.utils.parsedate_to_datetime(f["last_modified"])
                    if remote and remote > known:
                        newer = remote
                except Exception as e:  # réseau indisponible : ne bloque pas le reste du contrôle
                    lines.append(f"    (source {f['id']} injoignable : {e})")
            state = "ALERTE" if (fleft is not None and fleft <= args.days) or newer else "ok"
            txt = f"  [{state}] {f['id']} : valable jusqu'au {end:%d/%m/%Y} ({fleft} j)" if end else f"  [{state}] {f['id']}"
            if newer:
                txt += f" · nouvelle version publiée le {newer:%d/%m/%Y}"
            lines.append(txt)
            if fleft is not None and fleft <= args.days:
                if newer:
                    alerts.append(f"{name} / {f['id']} : expire le {end:%d/%m/%Y}, une nouvelle version est publiée : relancer « npm run data » et déployer")
                else:
                    alerts.append(f"{name} / {f['id']} : expire le {end:%d/%m/%Y}, pas encore de nouvelle version publiée")
            elif newer:
                alerts.append(f"{name} / {f['id']} : nouvelle version publiée le {newer:%d/%m/%Y}, relancer « npm run data » et déployer")

    print(f"Contrôle des données Maillage — {today:%d/%m/%Y} (seuil {args.days} jours)")
    print("\n".join(lines))
    if alerts:
        print(f"\n{len(alerts)} alerte(s) :")
        for a in alerts:
            print(f"  - {a}")
        sys.exit(1)
    print("\nAucune alerte.")


if __name__ == "__main__":
    main()
