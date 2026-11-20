#!/usr/bin/env python3
"""
Encart « prochains départs » pour le site d'une commune : extrait du réseau déjà généré
(public/data/<territoire>/network.json) les seuls passages aux arrêts de la commune.

Le fichier produit (quelques dizaines de Ko au lieu de ~1 Mo) suffit à afficher les départs
de tous les jours de la fenêtre du réseau (60 jours) : chaque passage renvoie à un calendrier.

Usage :
    python3 -I pipeline/build_widget.py public/data/<territoire> --slug <commune> --name "<Nom>" \
        --places "<pôle d'arrêt 1>" "<pôle d'arrêt 2>"
"""
import argparse, json, os, sys


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("datadir", help="dossier de données du territoire (contient network.json)")
    ap.add_argument("--slug", required=True)
    ap.add_argument("--name", required=True, help="nom de la commune affiché dans l'encart")
    ap.add_argument("--places", nargs="+", required=True, help="noms exacts des pôles d'arrêt")
    ap.add_argument("--commune", help="commune OpenStreetMap des lieux, si elle diffère du nom affiché (encart de démonstration)")
    args = ap.parse_args()

    net = json.load(open(os.path.join(args.datadir, "network.json"), encoding="utf-8"))
    places = net["places"]
    wanted = {}
    for name in args.places:
        idx = [i for i, p in enumerate(places) if p[0] == name]
        if not idx:
            sys.exit(f"pôle introuvable : {name}")
        wanted[idx[0]] = name

    stops_of = {}  # index d'arrêt -> index du pôle voulu
    for k, s in enumerate(net["stops"]):
        if s[3] in wanted:
            stops_of[k] = s[3]

    routes, route_index = [], {}
    services, svc_index = [], {}
    out_stops = {pl: [] for pl in wanted}
    stops = net["stops"]
    for t in net["trips"]:
        ri, si, headsign, _dir, tstops, _arr, dep = t[0], t[1], t[2], t[3], t[4], t[5], t[6]
        if t[7]:
            continue  # course sur réservation : pas d'horaire garanti
        for pos, s in enumerate(tstops[:-1]):  # le terminus n'est pas un départ
            pl = stops_of.get(s)
            if pl is None:
                continue
            if ri not in route_index:
                r = net["routes"][ri]
                route_index[ri] = len(routes)
                routes.append({"short": r[0], "long": r[1], "color": "#" + r[2], "text": "#" + r[3], "kind": r[4]})
            if si not in svc_index:
                svc_index[si] = len(services)
                services.append(net["services"][si])
            # direction lisible : terminus de la course (pôle), comme dans l'application
            last = places[stops[tstops[-1]][3]][0]
            out_stops[pl].append([dep[pos], svc_index[si], route_index[ri], headsign or last])

    for v in out_stops.values():
        v.sort(key=lambda x: x[0])
    data = {
        "version": 1,
        "generated_at": net["generated_at"],
        "tenant": net["tenant"]["tenant"],
        "name": args.name,
        "territory": net["tenant"].get("territory"),
        "window_start": net["window_start"],
        "window_days": net["window_days"],
        # fin de validité des flux utilisés par l'encart : au-delà, l'encart annonce une mise à jour
        # au lieu d'afficher « aucun départ »
        "valid_until": min((f["end"] for f in net["feeds"] if f.get("end") and f["kind"] in {r["kind"] for r in routes}), default=None),
        "operator_url": (net["tenant"].get("links") or {}).get("operator"),
        "routes": routes,
        "services": services,
        "stops": [{"name": wanted[pl], "lat": places[pl][1], "lon": places[pl][2], "deps": out_stops[pl]} for pl in wanted],
    }
    # lieux de la commune (pois.json, OpenStreetMap) : format « Comment venir » de l'encart
    pois_path = os.path.join(args.datadir, "pois.json")
    if os.path.exists(pois_path):
        pois = json.load(open(pois_path, encoding="utf-8"))
        data["lieux"] = [[p[0], p[1], p[2], p[4], p[5]] for p in pois["pois"] if p[3] == (args.commune or args.name)]
    path = os.path.join(args.datadir, f"widget-{args.slug}.json")
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, separators=(",", ":"))
    n = sum(len(v) for v in out_stops.values())
    print(f"[widget] {args.name} : {len(wanted)} arrêts, {len(routes)} lignes, {n} passages, "
          f"{len(services)} calendriers, {len(data.get('lieux', []))} lieux → {path} ({os.path.getsize(path) // 1024} Ko)")


if __name__ == "__main__":
    main()
