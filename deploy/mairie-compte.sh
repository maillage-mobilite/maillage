#!/usr/bin/env bash
# Comptes de l'espace mairie (fichier /srv/sites/maillage/espace/comptes.json sur le VPS). Depuis le Mac :
#   ./deploy/mairie-compte.sh liste
#   ./deploy/mairie-compte.sh ajoute <e-mail> "<nom affiché>" <commune>[,<commune>…]   (communes : slugs de pipeline/encarts.json, ou *)
#   ./deploy/mairie-compte.sh retire <e-mail>
# Effet immédiat (le fichier est relu à chaque requête) ; retirer un compte coupe aussi ses sessions ouvertes.
set -euo pipefail
CONF="$(cd "$(dirname "$0")" && pwd)/config.sh"
[[ -f "$CONF" ]] || { echo "Configuration absente : copier deploy/config.exemple.sh en deploy/config.sh" >&2; exit 1; }
. "$CONF"
HOST="$VPS_HOST"
KEY="$VPS_KEY"
ssh -i "$KEY" -o BatchMode=yes "$HOST" "python3 -I - $(printf '%q ' "$@")" <<'PY'
import json, os, sys
f = "/srv/sites/maillage/espace/comptes.json"
doc = json.load(open(f)) if os.path.exists(f) else {"comptes": []}
a = sys.argv[1:]
cmd = a[0] if a else "liste"
if cmd == "ajoute" and len(a) == 4:
    email = a[1].strip().lower()
    doc["comptes"] = [c for c in doc["comptes"] if c["email"] != email] + [{"email": email, "nom": a[2], "communes": a[3].split(",")}]
elif cmd == "retire" and len(a) == 2:
    doc["comptes"] = [c for c in doc["comptes"] if c["email"] != a[1].strip().lower()]
elif cmd != "liste":
    sys.exit("usage : liste | ajoute <e-mail> <nom> <communes> | retire <e-mail>")
if cmd != "liste":
    tmp = f + ".tmp"
    json.dump(doc, open(tmp, "w"), ensure_ascii=False, indent=1)
    os.replace(tmp, f)
for c in doc["comptes"]:
    print(f"{c['email']:<40} {c['nom']:<36} {','.join(c['communes'])}")
print(f"{len(doc['comptes'])} compte(s)")
PY
