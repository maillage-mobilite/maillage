#!/usr/bin/env python3
"""Relais du temps réel des bus : GET /api/tr/<territoire>.json

Les réseaux publient leur temps réel en GTFS-RT, mais leurs serveurs n'autorisent pas les navigateurs d'un autre
site à les lire (pas d'en-tête CORS), et certains flux couvrent toute une région (ZOU ! Proximité : 3,4 Mo).
Ce relais les interroge au plus toutes les 30 s, ne garde que les courses du territoire et renvoie, par course,
le retard arrêt par arrêt :

    {"t": <heure du flux, secondes Unix>, "trips": {"<index de course>@<AAAA-MM-JJ>": [annulée 0|1, retard, …]}}

un retard par arrêt de la course (secondes ; null si inconnu ; "x" si l'arrêt n'est pas desservi).

L'index des courses (identifiant d'origine → index de course de Maillage) est écrit par le pipeline dans
<DONNEES_DIR>/<territoire>/temps-reel.json ; les horaires théoriques sont lus dans network.json du même dossier.
Bibliothèque standard seulement.
"""
import json, os, re, shutil, subprocess, sys, threading, time, urllib.request
from datetime import date, datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from zoneinfo import ZoneInfo

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from gtfsrt import decode_trip_updates  # noqa: E402

DONNEES_DIR = os.environ.get("DONNEES_DIR", "public/data")
PORT = int(os.environ.get("PORT", "8091"))
HOST = os.environ.get("HOST", "127.0.0.1")       # 0.0.0.0 dans le conteneur
TTL = int(os.environ.get("TTL", "30"))            # âge maximal d'un flux avant nouvelle requête (s)
STALE = int(os.environ.get("STALE", "300"))       # au-delà, un flux en échec n'est plus servi (s)
PARIS = ZoneInfo("Europe/Paris")
UA = "Maillage-temps-reel/1.0"


def log(*a):
    print(time.strftime("[%Y-%m-%d %H:%M:%S]"), *a, flush=True)


# ------------------------------------------------------------------ flux amont (partagés entre territoires)

_feeds, _feeds_lock = {}, threading.Lock()   # url -> {"at", "ok_at", "feed", "lock"}


def _download(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return r.read()
    except urllib.error.URLError as e:
        # poste de développement : Python de python.org sans certificats racine → curl
        if "CERTIFICATE" in str(e).upper() and shutil.which("curl"):
            return subprocess.run(["curl", "-sfL", "--max-time", "15", "-A", UA, url], check=True, capture_output=True).stdout
        raise


def feed(url):
    """Flux décodé, rafraîchi au plus toutes les TTL secondes ; None s'il est indisponible depuis plus de STALE s."""
    with _feeds_lock:
        e = _feeds.setdefault(url, {"at": 0, "ok_at": 0, "feed": None, "lock": threading.Lock()})
    with e["lock"]:
        if time.time() - e["at"] >= TTL:
            e["at"] = time.time()
            try:
                e["feed"] = decode_trip_updates(_download(url))
                e["ok_at"] = time.time()
            except Exception as ex:  # flux en panne : on garde le dernier tant qu'il n'est pas trop vieux
                log(f"flux indisponible {url} : {ex}")
        return e["feed"] if time.time() - e["ok_at"] < STALE else None


# ------------------------------------------------------------------ index d'un territoire

_index, _index_lock = {}, threading.Lock()   # territoire -> {"mtime", "feeds", "trips", "times"}


def index(tenant):
    path = os.path.join(DONNEES_DIR, tenant, "temps-reel.json")
    try:
        mtime = os.path.getmtime(path)
    except OSError:
        return None
    with _index_lock:
        cur = _index.get(tenant)
        if cur and cur["mtime"] == mtime:
            return cur
        with open(path, encoding="utf-8") as fh:
            rt = json.load(fh)
        with open(os.path.join(DONNEES_DIR, tenant, "network.json"), encoding="utf-8") as fh:
            trips = json.load(fh)["trips"]
        # horaires théoriques des seules courses suivies : [arrivées, départs]
        times = {v[0]: (trips[v[0]][5], trips[v[0]][6]) for f in rt["trips"].values() for v in f.values()}
        cur = {"mtime": mtime, "feeds": rt["feeds"], "trips": rt["trips"], "times": times}
        _index[tenant] = cur
        log(f"index {tenant} : {sum(len(v) for v in rt['trips'].values())} courses suivies")
        return cur


# ------------------------------------------------------------------ calcul des retards

def midnight(d):
    """Instant (s Unix) de minuit, heure de Paris, du jour de service d."""
    return datetime(d.year, d.month, d.day, tzinfo=PARIS).timestamp()


def trip_delays(rt, entry, arr, dep, now):
    """(jour de service, [retard par arrêt]) d'une course du flux, ou None si rien d'exploitable."""
    k, stop_ids, seqs = entry
    n = len(stop_ids)
    pos_of_seq = {s: p for p, s in enumerate(seqs)}
    updates, last = [], -1   # [(position, retard ou None, heure absolue ou None, desservi)]
    for u in rt["stops"]:
        p = pos_of_seq.get(u["seq"]) if u["seq"] is not None else None
        if p is None and u["stop_id"]:
            p = next((q for q in range(last + 1, n) if stop_ids[q] == u["stop_id"]), None)
        if p is None or p <= last:
            continue
        last = p
        delay = u["dep_delay"] if u["dep_delay"] is not None else u["arr_delay"]
        at = u["dep_time"] or u["arr_time"]
        updates.append((p, delay, at, not u["skipped"]))

    # jour de service : celui du flux, sinon celui (hier ou aujourd'hui) qui colle le mieux aux heures annoncées
    if rt["start_date"] and re.fullmatch(r"\d{8}", rt["start_date"]):
        sd = date(int(rt["start_date"][:4]), int(rt["start_date"][4:6]), int(rt["start_date"][6:]))
    else:
        today = datetime.fromtimestamp(now, PARIS).date()
        ref = next(((p, at) for p, _, at, _ in updates if at), None)
        if ref:
            p, at = ref
            sd = min((today, today - timedelta(days=1)), key=lambda d: abs(at - midnight(d) - dep[p]))
        else:
            sd = today
    base = midnight(sd)

    # course terminée depuis plus d'une heure (certains flux gardent celles de la veille) : inutile
    if base + max(arr[-1], dep[-1]) + 3600 < now:
        return None
    out = [None] * n
    if not updates and rt["delay"] is not None:
        out = [rt["delay"]] * n
    known = []   # annonces porteuses d'un retard : [(position, retard)]
    for p, delay, at, served in updates:
        if delay is None and at:
            delay = int(at - base - (dep[p] if dep[p] else arr[p]))
        if delay is not None:
            known.append((p, delay))
    for i, (p, delay) in enumerate(known):
        end = known[i + 1][0] if i + 1 < len(known) else n   # le retard vaut jusqu'à l'annonce suivante
        for q in range(p, end):
            out[q] = delay
    for p, _, _, served in updates:
        if not served:
            out[p] = "x"
    if not rt["canceled"] and all(v is None for v in out):
        return None
    return sd, out


def build(tenant):
    idx = index(tenant)
    if idx is None:
        return None
    now = time.time()
    trips, stamp, down = {}, 0, []
    for fid, url in idx["feeds"].items():
        f = feed(url)
        if f is None:
            down.append(fid)
            continue
        stamp = max(stamp, f["timestamp"])
        known = idx["trips"].get(fid, {})
        for rt in f["trips"]:
            entry = known.get(rt["trip_id"])
            if not entry:
                continue
            arr, dep = idx["times"][entry[0]]
            res = trip_delays(rt, entry, arr, dep, now)
            if res:
                sd, delays = res
                trips[f"{entry[0]}@{sd.isoformat()}"] = [1 if rt["canceled"] else 0] + delays
    doc = {"t": stamp, "trips": trips}
    if down:
        doc["indisponibles"] = down
    return json.dumps(doc, separators=(",", ":")).encode()


# ------------------------------------------------------------------ serveur

_out, _out_lock = {}, threading.Lock()   # territoire -> (instant, corps)


class Handler(BaseHTTPRequestHandler):
    server_version = "maillage-tr"

    def log_message(self, *a):
        pass

    def do_GET(self):
        m = re.fullmatch(r"/api/tr/([a-z0-9-]{1,40})\.json", self.path.split("?", 1)[0])
        if not m:
            return self.send(404, b'{"erreur":"introuvable"}')
        tenant = m.group(1)
        with _out_lock:
            hit = _out.get(tenant)
        if not hit or time.time() - hit[0] >= TTL / 2:
            try:
                body = build(tenant)
            except Exception as ex:
                log(f"erreur {tenant} : {ex!r}")
                body = None
            if body is None:
                return self.send(404, b'{"erreur":"pas de temps reel pour ce territoire"}')
            hit = (time.time(), body)
            with _out_lock:
                _out[tenant] = hit
        self.send(200, hit[1])

    def send(self, code, body):
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    log(f"Relais temps réel sur le port {PORT} (données : {DONNEES_DIR})")
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
