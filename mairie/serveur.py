#!/usr/bin/env python3
"""Espace mairie de Maillage : messages d'info trafic, lieux utiles, statistiques de l'encart.

Petit serveur HTTP sans dépendance (bibliothèque standard), derrière nginx (`/api/mairie/…`).
- Connexion sans mot de passe : la mairie saisit son adresse, reçoit un lien valable 15 minutes
  (une seule utilisation), qui ouvre une session de 30 jours (cookie HttpOnly, Secure, SameSite=Strict).
- Comptes autorisés : fichier `comptes.json` (géré par l'éditeur, voir deploy/mairie-compte.sh).
- Ce que publie la mairie est écrit en fichiers statiques (`contenus/<territoire>/messages.json`,
  `lieux.json`) lus par l'application et l'encart : le serveur n'est jamais sur le chemin des voyageurs.

Configuration (variables d'environnement) :
  ESPACE_DIR    données de l'espace (espace.db, comptes.json)        [défaut : ./espace]
  CONTENUS_DIR  fichiers publiés pour l'application et l'encart       [défaut : ./contenus]
  DONNEES_DIR   données en ligne (<territoire>/network.json, pois.json, widget-<commune>.json)
  ENCARTS_FILE  registre des communes (pipeline/encarts.json)
  USAGE_LOG     journal de mesure d'usage nginx (usage.log)
  ORIGIN        adresse publique, ex. https://maillage.tuatam.fr (liens envoyés, contrôle des requêtes)
  MAIL          « msmtp » (relais du VPS) ou « console » (développement : le lien s'affiche dans le terminal)
  BRAND_FILE    nom et contact du service (brand.json, relu à chaque envoi)   [défaut : ../brand.json]
  PORT          port d'écoute (défaut 8090)

Usage : python3 -I mairie/serveur.py
"""
import collections
import datetime as dt
import hashlib
import json
import os
import re
import secrets
import sqlite3
import subprocess
import sys
import threading
import time
import urllib.parse
from email.message import EmailMessage
from http import cookies
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from zoneinfo import ZoneInfo

HERE = os.path.dirname(os.path.abspath(__file__))
ESPACE_DIR = os.environ.get("ESPACE_DIR", os.path.join(HERE, "espace"))
CONTENUS_DIR = os.environ.get("CONTENUS_DIR", os.path.join(HERE, "contenus"))
DONNEES_DIR = os.environ.get("DONNEES_DIR", os.path.join(HERE, "..", "public", "data"))
ENCARTS_FILE = os.environ.get("ENCARTS_FILE", os.path.join(HERE, "..", "pipeline", "encarts.json"))
USAGE_LOG = os.environ.get("USAGE_LOG", "")
ORIGIN = os.environ.get("ORIGIN", "http://localhost:5199").rstrip("/")
MAIL = os.environ.get("MAIL", "console")
BRAND_FILE = os.environ.get("BRAND_FILE", os.path.join(HERE, "..", "brand.json"))
PORT = int(os.environ.get("PORT", "8090"))

PARIS = ZoneInfo("Europe/Paris")
JETON_MIN = 15
SESSION_JOURS = 30
COOKIE = "maillage_mairie"
MAX_CORPS = 64 * 1024
CATEGORIES = {"services", "education", "sante", "commerces", "loisirs", "dechets", "transport"}
LOCK = threading.Lock()


def log(*a):
    print(f"[{dt.datetime.now(PARIS):%Y-%m-%d %H:%M:%S}]", *a, file=sys.stderr, flush=True)


def h(s):
    return hashlib.sha256(s.encode()).hexdigest()


def today():
    return dt.datetime.now(PARIS).date()


# ------------------------------------------------------------------ stockage

def db():
    c = sqlite3.connect(os.path.join(ESPACE_DIR, "espace.db"), timeout=10)
    c.row_factory = sqlite3.Row
    return c


def init_db():
    os.makedirs(ESPACE_DIR, exist_ok=True)
    os.makedirs(CONTENUS_DIR, exist_ok=True)
    with db() as c:
        c.executescript("""
          CREATE TABLE IF NOT EXISTS jetons (hash TEXT PRIMARY KEY, email TEXT, expire INTEGER, utilise INTEGER DEFAULT 0);
          CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, email TEXT, expire INTEGER);
          CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, commune TEXT, data TEXT, cree TEXT, modifie TEXT, auteur TEXT);
          CREATE TABLE IF NOT EXISTS lieux (id TEXT PRIMARY KEY, commune TEXT, data TEXT, cree TEXT, modifie TEXT, auteur TEXT);
          CREATE TABLE IF NOT EXISTS masques (commune TEXT, cle TEXT, PRIMARY KEY (commune, cle));
          CREATE TABLE IF NOT EXISTS journal (ts TEXT, email TEXT, action TEXT, details TEXT);
        """)


def journal(c, email, action, details=""):
    c.execute("INSERT INTO journal VALUES (?,?,?,?)", (dt.datetime.now(PARIS).isoformat(timespec="seconds"), email, action, details))


def lire_json(path, defaut=None):
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return defaut


def ecrire_json(path, doc):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, path)


def comptes():
    doc = lire_json(os.path.join(ESPACE_DIR, "comptes.json"), {"comptes": []})
    return {a["email"].strip().lower(): a for a in doc.get("comptes", []) if a.get("email")}


def communes():
    """Communes clientes (pipeline/encarts.json) : slug → {territoire, nom, poles}."""
    doc = lire_json(ENCARTS_FILE, {"encarts": []})
    return {e["slug"]: e for e in doc.get("encarts", [])}


def communes_du_compte(compte):
    toutes = communes()
    if "*" in compte.get("communes", []):
        return toutes
    return {s: toutes[s] for s in compte.get("communes", []) if s in toutes}


# ------------------------------------------------------------------ publication des fichiers statiques

def publier(territoire):
    """Réécrit contenus/<territoire>/messages.json et lieux.json (toutes les communes du territoire)."""
    slugs = [s for s, e in communes().items() if e["territoire"] == territoire]
    if not slugs:
        return
    q = ",".join("?" * len(slugs))
    jour = today().isoformat()
    with db() as c:
        msgs = [dict(json.loads(r["data"]), id=r["id"], commune=r["commune"]) for r in c.execute(f"SELECT * FROM messages WHERE commune IN ({q})", slugs)]
        ajouts = [dict(json.loads(r["data"]), id=r["id"], commune=r["commune"]) for r in c.execute(f"SELECT * FROM lieux WHERE commune IN ({q})", slugs)]
        masques = [dict(commune=r["commune"], cle=r["cle"]) for r in c.execute(f"SELECT * FROM masques WHERE commune IN ({q})", slugs)]
    msgs = sorted((m for m in msgs if m["fin"] >= jour), key=lambda m: (m["debut"], m["titre"]))
    noms = {s: communes()[s]["nom"] for s in slugs}
    for m in msgs + ajouts:
        m["commune_nom"] = noms.get(m["commune"], m["commune"])
    gen = dt.datetime.now(PARIS).isoformat(timespec="seconds")
    ecrire_json(os.path.join(CONTENUS_DIR, territoire, "messages.json"), {"version": 1, "generated_at": gen, "messages": msgs})
    ecrire_json(os.path.join(CONTENUS_DIR, territoire, "lieux.json"), {"version": 1, "generated_at": gen, "ajouts": ajouts, "masques": masques})


def publier_tout():
    for t in sorted({e["territoire"] for e in communes().values()}):
        publier(t)


# ------------------------------------------------------------------ validation

class Refus(Exception):
    def __init__(self, code, msg):
        super().__init__(msg)
        self.code = code


def texte(d, k, maxi, requis=True):
    v = d.get(k)
    v = v.strip() if isinstance(v, str) else ""
    if requis and not v:
        raise Refus(400, f"champ « {k} » manquant")
    if len(v) > maxi:
        raise Refus(400, f"champ « {k} » trop long ({maxi} caractères au plus)")
    return v


def date_iso(d, k):
    try:
        return dt.date.fromisoformat(str(d.get(k, ""))).isoformat()
    except ValueError:
        raise Refus(400, f"date « {k} » invalide")


def lien(d, k):
    v = texte(d, k, 300, requis=False)
    if v and not re.match(r"^https://[^\s<>\"']+$", v):
        raise Refus(400, f"« {k} » doit être une adresse https://")
    return v


def valider_message(d, ctx):
    debut, fin = date_iso(d, "debut"), date_iso(d, "fin")
    if fin < debut:
        raise Refus(400, "la date de fin précède la date de début")
    if dt.date.fromisoformat(fin) > today() + dt.timedelta(days=200):
        raise Refus(400, "durée trop longue : 6 mois au plus (le message peut être prolongé ensuite)")
    gravite = d.get("gravite")
    if gravite not in ("info", "perturbation"):
        raise Refus(400, "gravité inconnue")
    lignes = [x for x in d.get("lignes", []) if isinstance(x, str)][:20]
    arrets = [x for x in d.get("arrets", []) if isinstance(x, str)][:20]
    if any(x not in ctx["lignes_codes"] for x in lignes):
        raise Refus(400, "ligne inconnue")
    if any(x not in ctx["arrets_noms"] for x in arrets):
        raise Refus(400, "arrêt inconnu")
    return {"titre": texte(d, "titre", 90), "texte": texte(d, "texte", 600, requis=False), "debut": debut, "fin": fin,
            "gravite": gravite, "lignes": lignes, "arrets": arrets, "lien": lien(d, "lien")}


def valider_lieu(d, ctx):
    cat = d.get("cat")
    if cat not in CATEGORIES:
        raise Refus(400, "catégorie inconnue")
    try:
        lat, lon = float(d.get("lat")), float(d.get("lon"))
    except (TypeError, ValueError):
        raise Refus(400, "position invalide")
    b = ctx["bbox"]
    if not (b[1] - 0.05 <= lat <= b[3] + 0.05 and b[0] - 0.05 <= lon <= b[2] + 0.05):
        raise Refus(400, "position hors du territoire")
    return {"nom": texte(d, "nom", 90), "cat": cat, "lat": round(lat, 6), "lon": round(lon, 6),
            "adresse": texte(d, "adresse", 160, requis=False), "horaires": texte(d, "horaires", 200, requis=False),
            "tel": texte(d, "tel", 30, requis=False), "web": lien(d, "web")}


def contexte(slug):
    """Lignes, arrêts et lieux OpenStreetMap d'une commune (données en ligne)."""
    e = communes()[slug]
    t = e["territoire"]
    net = lire_json(os.path.join(DONNEES_DIR, t, "network.json"), {})
    w = lire_json(os.path.join(DONNEES_DIR, t, f"widget-{slug}.json"), {})
    pois = lire_json(os.path.join(DONNEES_DIR, t, "pois.json"), {"pois": [], "categories": []})
    # lignes et arrêts de la commune (ceux de son encart) : un message les cible pour s'afficher sur leurs fiches
    lignes = [{"code": r["short"], "nom": r["long"], "couleur": r["color"], "texte": r["text"]} for r in w.get("routes", [])]
    arrets = sorted({s["name"] for s in w.get("stops", [])} | set(e.get("poles", [])))
    osm = [{"cle": cle_lieu(p[0], p[4], p[5]), "nom": p[0], "cat": p[1], "type": p[2], "lat": p[4], "lon": p[5]}
           for p in pois.get("pois", []) if p[3] == e["nom"]]
    return {"slug": slug, "nom": e["nom"], "territoire": t, "reseau": net.get("tenant", {}).get("name", t),
            "bbox": net.get("tenant", {}).get("bbox", [-180, -90, 180, 90]), "center": net.get("tenant", {}).get("center"),
            "lignes": lignes, "lignes_codes": {l["code"] for l in lignes}, "arrets": arrets, "arrets_noms": set(arrets),
            "osm": osm, "categories": pois.get("categories", [])}


def cle_lieu(nom, lat, lon):
    return f"{nom}|{lat:.5f}|{lon:.5f}"


# ------------------------------------------------------------------ statistiques (usage.log)

def stats(slug, mois):
    """Affichages de l'encart de la commune et clics vers l'application, par jour du mois et sur 6 mois."""
    try:
        y, m = map(int, mois.split("-"))
        debut = dt.date(y, m, 1)
    except ValueError:
        raise Refus(400, "mois invalide")
    fin = (debut.replace(day=28) + dt.timedelta(days=4)).replace(day=1)
    six = (debut - dt.timedelta(days=150)).replace(day=1)
    par_jour = collections.Counter()
    par_mois = collections.Counter()
    formats, sites, appareils = collections.Counter(), collections.Counter(), collections.Counter()
    clics = collections.Counter()
    try:
        fh = open(USAGE_LOG, encoding="utf-8", errors="replace") if USAGE_LOG else None
    except OSError:
        fh = None
    if fh:
        with fh:
            for line in fh:
                p = line.split()
                if len(p) not in (8, 9):
                    continue
                # champs « valeur- » ; un paramètre absent s'écrit « - », d'où « -- »
                champ = lambda v: "" if v in ("-", "--") else (v[:-1] if v.endswith("-") else v)
                commune = champ(p[5])
                if commune != slug:
                    continue
                try:
                    jour = dt.datetime.fromisoformat(p[0]).astimezone(PARIS).date()
                except ValueError:
                    continue
                if not (six <= jour < fin):
                    continue
                src = champ(p[6])
                cle_mois = f"{jour:%Y-%m}"
                if p[1] == "encart":
                    par_mois[cle_mois] += 1
                    if jour >= debut:
                        par_jour[jour.isoformat()] += 1
                        formats[(champ(p[8]) if len(p) == 9 else "") or "complet"] += 1
                        sites[p[3].removeprefix("www.") if p[3] != "-" else "lien direct"] += 1
                        appareils[p[7]] += 1
                elif p[1] == "appli" and src.startswith("encart"):
                    clics[cle_mois] += 1
    jours = []
    d = debut
    while d < fin:
        jours.append({"jour": d.isoformat(), "affichages": par_jour[d.isoformat()]})
        d += dt.timedelta(days=1)
    mois_liste = []
    d = six
    while d < fin:
        k = f"{d:%Y-%m}"
        mois_liste.append({"mois": k, "affichages": par_mois[k], "clics": clics[k]})
        d = (d.replace(day=28) + dt.timedelta(days=4)).replace(day=1)
    return {"mois": mois, "jours": jours, "historique": mois_liste,
            "formats": formats.most_common(), "sites": sites.most_common(10), "appareils": appareils.most_common()}


# ------------------------------------------------------------------ e-mail

def marque():
    """Nom et contact du service, relus à chaque envoi : un changement de nom ne demande pas de redémarrage."""
    try:
        with open(BRAND_FILE, encoding="utf-8") as f:
            b = json.load(f)
        return b["nom"], b["contact"]
    except (OSError, ValueError, KeyError):
        return "Maillage", "contact@tuatam.fr"


def envoyer_lien(email, nom, jeton):
    url = f"{ORIGIN}/mairie.html#jeton={jeton}"
    msg = EmailMessage()
    msg["To"] = email
    nom_service, contact = marque()
    msg["Subject"] = f"Votre lien de connexion à l'espace mairie {nom_service}"
    msg.set_content(
        f"Bonjour,\n\nPour ouvrir l'espace mairie {nom_service} ({nom}), cliquez sur ce lien :\n\n{url}\n\n"
        f"Il est valable {JETON_MIN} minutes et ne sert qu'une fois.\n"
        "Si vous n'êtes pas à l'origine de cette demande, ignorez ce message : rien ne change sans ce lien.\n\n"
        f"{nom_service} · {contact}\n")
    if MAIL == "msmtp":
        subprocess.run(["msmtp", "-t"], input=msg.as_bytes(), check=True, timeout=60)
    else:
        log(f"[e-mail pour {email}] {url}")


# ------------------------------------------------------------------ limites de débit (mémoire)

_tentatives = collections.defaultdict(list)


def limiter(cle, n, secondes):
    now = time.time()
    t = [x for x in _tentatives[cle] if now - x < secondes]
    _tentatives[cle] = t
    if len(t) >= n:
        raise Refus(429, "trop de demandes, réessayez plus tard")
    t.append(now)


# ------------------------------------------------------------------ HTTP

ROUTES = re.compile(r"^/api/mairie/communes/([a-z0-9-]+)/(contexte|messages|lieux|masques|stats)(?:/([A-Za-z0-9_-]{6,40}))?$")


class Handler(BaseHTTPRequestHandler):
    server_version = "maillage-mairie"
    sys_version = ""

    def log_message(self, fmt, *args):  # pas d'adresse IP dans le journal
        pass

    def envoyer(self, code, doc, extra=()):
        corps = json.dumps(doc, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        for k, v in extra:
            self.send_header(k, v)
        self.send_header("Content-Length", str(len(corps)))
        self.end_headers()
        self.wfile.write(corps)

    def corps(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n > MAX_CORPS:
            raise Refus(413, "requête trop grosse")
        if n and "application/json" not in (self.headers.get("Content-Type") or ""):
            raise Refus(415, "JSON attendu")
        try:
            return json.loads(self.rfile.read(n) or b"{}")
        except ValueError:
            raise Refus(400, "JSON invalide")

    def compte(self):
        c = cookies.SimpleCookie(self.headers.get("Cookie") or "")
        v = c.get(COOKIE)
        if not v:
            raise Refus(401, "non connecté")
        with db() as cx:
            r = cx.execute("SELECT email, expire FROM sessions WHERE hash=?", (h(v.value),)).fetchone()
        if not r or r["expire"] < time.time():
            raise Refus(401, "session expirée")
        a = comptes().get(r["email"])
        if not a:
            raise Refus(403, "compte désactivé")
        return a

    def traiter(self, methode):
        path = urllib.parse.urlsplit(self.path).path
        query = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
        try:
            if methode != "GET":
                # requêtes modifiantes : uniquement depuis l'espace mairie lui-même (en plus de SameSite=Strict)
                if (self.headers.get("Origin") or "").rstrip("/") != ORIGIN:
                    raise Refus(403, "origine refusée")
            if path == "/api/mairie/connexion" and methode == "POST":
                return self.connexion(self.corps())
            if path == "/api/mairie/session" and methode == "POST":
                return self.ouvrir_session(self.corps())
            if path == "/api/mairie/deconnexion" and methode == "POST":
                c = cookies.SimpleCookie(self.headers.get("Cookie") or "").get(COOKIE)
                if c:
                    with LOCK, db() as cx:
                        cx.execute("DELETE FROM sessions WHERE hash=?", (h(c.value),))
                return self.envoyer(200, {"ok": True}, [("Set-Cookie", f"{COOKIE}=; Path=/api/mairie; Max-Age=0; HttpOnly; Secure; SameSite=Strict")])
            a = self.compte()
            mes = communes_du_compte(a)
            if path == "/api/mairie/moi" and methode == "GET":
                return self.envoyer(200, {"email": a["email"], "nom": a.get("nom", ""), "communes": [
                    {"slug": s, "nom": e["nom"], "territoire": e["territoire"]} for s, e in sorted(mes.items())]})
            m = ROUTES.match(path)
            if not m:
                raise Refus(404, "inconnu")
            slug, quoi, ident = m.groups()
            if slug not in mes:
                raise Refus(403, "commune non autorisée pour ce compte")
            return self.commune(methode, a, slug, quoi, ident, query)
        except Refus as e:
            self.envoyer(e.code, {"erreur": str(e)})
        except Exception as e:  # erreur inattendue : jamais de détail technique au navigateur
            log("erreur", methode, path, repr(e))
            self.envoyer(500, {"erreur": "erreur du serveur"})

    def connexion(self, d):
        email = texte(d, "email", 200).lower()
        limiter("global", 60, 3600)
        limiter("email:" + email, 5, 3600)
        a = comptes().get(email)
        if a:
            jeton = secrets.token_urlsafe(32)
            with LOCK, db() as c:
                c.execute("DELETE FROM jetons WHERE expire < ?", (time.time(),))
                c.execute("INSERT INTO jetons (hash, email, expire) VALUES (?,?,?)", (h(jeton), email, time.time() + JETON_MIN * 60))
                journal(c, email, "lien demandé")
            try:
                envoyer_lien(email, a.get("nom") or email, jeton)
            except Exception as e:
                log("envoi du lien impossible", repr(e))
                raise Refus(502, "envoi de l'e-mail impossible, réessayez dans quelques minutes")
        # même réponse que l'adresse soit connue ou non (on ne révèle pas la liste des comptes)
        self.envoyer(200, {"ok": True})

    def ouvrir_session(self, d):
        jeton = texte(d, "jeton", 100)
        limiter("session", 30, 600)
        with LOCK, db() as c:
            r = c.execute("SELECT email, expire, utilise FROM jetons WHERE hash=?", (h(jeton),)).fetchone()
            if not r or r["utilise"] or r["expire"] < time.time():
                raise Refus(401, "lien expiré ou déjà utilisé : demandez-en un nouveau")
            c.execute("UPDATE jetons SET utilise=1 WHERE hash=?", (h(jeton),))
            s = secrets.token_urlsafe(32)
            c.execute("DELETE FROM sessions WHERE expire < ?", (time.time(),))
            c.execute("INSERT INTO sessions VALUES (?,?,?)", (h(s), r["email"], time.time() + SESSION_JOURS * 86400))
            journal(c, r["email"], "connexion")
        self.envoyer(200, {"ok": True}, [("Set-Cookie", f"{COOKIE}={s}; Path=/api/mairie; Max-Age={SESSION_JOURS * 86400}; HttpOnly; Secure; SameSite=Strict")])

    def commune(self, methode, a, slug, quoi, ident, query):
        ctx = contexte(slug)
        t = ctx["territoire"]
        now = dt.datetime.now(PARIS).isoformat(timespec="seconds")
        if quoi == "contexte" and methode == "GET":
            out = {k: v for k, v in ctx.items() if k not in ("lignes_codes", "arrets_noms", "osm")}
            return self.envoyer(200, out)
        if quoi == "stats" and methode == "GET":
            mois = (query.get("mois") or [f"{today():%Y-%m}"])[0]
            return self.envoyer(200, stats(slug, mois))
        if quoi == "messages":
            if methode == "GET":
                with db() as c:
                    rows = c.execute("SELECT * FROM messages WHERE commune=? ORDER BY json_extract(data,'$.fin') DESC", (slug,)).fetchall()
                return self.envoyer(200, {"messages": [dict(json.loads(r["data"]), id=r["id"], modifie=r["modifie"], auteur=r["auteur"]) for r in rows]})
            if methode in ("POST", "PUT"):
                doc = valider_message(self.corps(), ctx)
                with LOCK, db() as c:
                    if methode == "POST":
                        ident = secrets.token_urlsafe(9)
                        c.execute("INSERT INTO messages VALUES (?,?,?,?,?,?)", (ident, slug, json.dumps(doc, ensure_ascii=False), now, now, a["email"]))
                    elif not c.execute("UPDATE messages SET data=?, modifie=?, auteur=? WHERE id=? AND commune=?", (json.dumps(doc, ensure_ascii=False), now, a["email"], ident, slug)).rowcount:
                        raise Refus(404, "message introuvable")
                    journal(c, a["email"], f"message {methode}", f"{slug} {ident} {doc['titre']}")
                publier(t)
                return self.envoyer(200, {"ok": True, "id": ident})
            if methode == "DELETE" and ident:
                with LOCK, db() as c:
                    c.execute("DELETE FROM messages WHERE id=? AND commune=?", (ident, slug))
                    journal(c, a["email"], "message supprimé", f"{slug} {ident}")
                publier(t)
                return self.envoyer(200, {"ok": True})
        if quoi == "lieux":
            if methode == "GET":
                with db() as c:
                    ajouts = [dict(json.loads(r["data"]), id=r["id"]) for r in c.execute("SELECT * FROM lieux WHERE commune=? ORDER BY modifie DESC", (slug,))]
                    masques = {r["cle"] for r in c.execute("SELECT cle FROM masques WHERE commune=?", (slug,))}
                osm = [dict(p, masque=p["cle"] in masques) for p in ctx["osm"]]
                return self.envoyer(200, {"ajouts": ajouts, "osm": osm})
            if methode in ("POST", "PUT"):
                doc = valider_lieu(self.corps(), ctx)
                with LOCK, db() as c:
                    if methode == "POST":
                        ident = secrets.token_urlsafe(9)
                        c.execute("INSERT INTO lieux VALUES (?,?,?,?,?,?)", (ident, slug, json.dumps(doc, ensure_ascii=False), now, now, a["email"]))
                    elif not c.execute("UPDATE lieux SET data=?, modifie=?, auteur=? WHERE id=? AND commune=?", (json.dumps(doc, ensure_ascii=False), now, a["email"], ident, slug)).rowcount:
                        raise Refus(404, "lieu introuvable")
                    journal(c, a["email"], f"lieu {methode}", f"{slug} {ident} {doc['nom']}")
                publier(t)
                return self.envoyer(200, {"ok": True, "id": ident})
            if methode == "DELETE" and ident:
                with LOCK, db() as c:
                    c.execute("DELETE FROM lieux WHERE id=? AND commune=?", (ident, slug))
                    journal(c, a["email"], "lieu supprimé", f"{slug} {ident}")
                publier(t)
                return self.envoyer(200, {"ok": True})
        if quoi == "masques" and methode == "POST":
            d = self.corps()
            cle = texte(d, "cle", 200)
            if cle not in {p["cle"] for p in ctx["osm"]}:
                raise Refus(400, "lieu OpenStreetMap inconnu")
            with LOCK, db() as c:
                if d.get("masque"):
                    c.execute("INSERT OR IGNORE INTO masques VALUES (?,?)", (slug, cle))
                else:
                    c.execute("DELETE FROM masques WHERE commune=? AND cle=?", (slug, cle))
                journal(c, a["email"], "lieu OSM " + ("masqué" if d.get("masque") else "affiché"), f"{slug} {cle}")
            publier(t)
            return self.envoyer(200, {"ok": True})
        raise Refus(405, "méthode non prise en charge")

    def do_GET(self):
        self.traiter("GET")

    def do_POST(self):
        self.traiter("POST")

    def do_PUT(self):
        self.traiter("PUT")

    def do_DELETE(self):
        self.traiter("DELETE")


def main():
    init_db()
    publier_tout()
    # chaque nuit, les messages arrivés à échéance disparaissent des fichiers publiés
    def nettoyage():
        while True:
            time.sleep(3600)
            try:
                publier_tout()
            except Exception as e:
                log("nettoyage", repr(e))
    threading.Thread(target=nettoyage, daemon=True).start()
    log(f"Espace mairie sur le port {PORT} (origine {ORIGIN}, e-mail : {MAIL})")
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
