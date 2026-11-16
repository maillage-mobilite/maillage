# Mise en ligne privée : maillage.tuatam.fr

Même schéma que les autres sites statiques du VPS Tuatam (voir `/srv/sites/README.md` sur le VPS, modèle homecinema) :

- **DNS** (16/11/2026, zone OVH de tuatam.fr) : `maillage.tuatam.fr. IN A 57.129.163.124`.
- **VPS** : `/srv/sites/maillage/` → conteneur `maillage-web` (nginx 1.27 alpine) derrière le proxy Traefik de Coolify
  (réseau Docker `coolify`, certificat Let's Encrypt). Fichiers versionnés ici : `compose.yml`, `compose.domain.yml`, `nginx.conf`.
- **Accès privé** : authentification HTTP gérée par nginx, comptes dans `/srv/sites/maillage/private/htpasswd`
  (root:101 640, hors dossier web). Sans compte valide, tout répond 401 (pages et données). Non indexé :
  en-tête `X-Robots-Tag`, `robots.txt`, balise `noindex`.

## Publier une mise à jour (depuis le Mac)

```bash
cd demonstrateur && ./deploy/deploy-vps.sh
```

`--config` envoie aussi `compose*.yml` et `nginx.conf` puis relance le conteneur. Pour rafraîchir les horaires : `npm run data` avant.

## Comptes d'accès

Ajouter un compte (le mot de passe est demandé deux fois au clavier, rien n'est stocké en clair) ; remplacer `demo` par le nom voulu :

```bash
ssh -t -i ~/.ssh/id_ed25519_ovh_almanach ubuntu@vps-4075b317.vps.ovh.net 'h=$(openssl passwd -apr1) && echo "demo:$h" | sudo tee -a /srv/sites/maillage/private/htpasswd >/dev/null && echo "Compte ajouté"'
```

nginx relit le fichier à chaque requête : pas de redémarrage.

Le fichier est monté seul dans le conteneur : Docker suit son inode. Il faut donc le **réécrire sur place**
(`cat … >`), jamais le remplacer (`sed -i`, éditeur, `mv`), sinon le conteneur garde l'ancienne version.

Changer le mot de passe d'un compte (ici `demo`) :

```bash
ssh -t -i ~/.ssh/id_ed25519_ovh_almanach ubuntu@vps-4075b317.vps.ovh.net 'F=/srv/sites/maillage/private/htpasswd; h=$(openssl passwd -apr1) && sudo install -m 600 /dev/null $F.new && { sudo grep -v "^demo:" $F; printf "demo:%s\n" "$h"; } | sudo tee $F.new >/dev/null && sudo sh -c "cat $F.new > $F && rm $F.new" && echo "Mot de passe changé"'
```

Retirer un compte :

```bash
ssh -i ~/.ssh/id_ed25519_ovh_almanach ubuntu@vps-4075b317.vps.ovh.net 'F=/srv/sites/maillage/private/htpasswd; sudo sh -c "grep -v \"^demo:\" $F > $F.new; cat $F.new > $F && rm $F.new" && echo "Compte retiré"'
```

## Limites de l'accès privé

Le site est protégé, mais il appelle des services tiers depuis le navigateur des visiteurs : fond de carte OpenFreeMap,
adresses (Base Adresse Nationale), marche à pied (FOSSGIS), recalage OSRM côté pipeline, temps réel SNCF. Ils ne reçoivent
que des requêtes anonymes (coordonnées de départ et d'arrivée pour la marche). À remplacer par des services hébergés
avant une diffusion large.

## Encart public « prochains départs »

Seuls `/widget.html`, ses fichiers `assets/widget-*` et `assets/modulepreload-polyfill-*`, et les
`data/<territoire>/widget-<commune>.json` sont servis sans mot de passe (voir `nginx.conf`). Tout le reste
demande toujours un compte. Pour qu'une autre commune puisse intégrer l'encart, ajouter son domaine à la
directive `frame-ancestors` de `nginx.conf` puis lancer `./deploy/deploy-vps.sh --config`.
Code à coller dans le site de la commune : `encart-ornex.html` (exemple pour Ornex).
