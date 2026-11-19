# Mise en ligne privée : maillage.tuatam.fr

Même schéma que les autres sites statiques du VPS Tuatam (voir `/srv/sites/README.md` sur le VPS, modèle homecinema) :

- **DNS** (16/11/2026, zone OVH de tuatam.fr) : enregistrement A de `maillage.tuatam.fr` vers l'adresse du VPS.
- **VPS** : `/srv/sites/maillage/` → conteneur `maillage-web` (nginx 1.27 alpine) derrière le proxy Traefik de Coolify
  (réseau Docker `coolify`, certificat Let's Encrypt). Fichiers versionnés ici : `compose.yml`, `compose.domain.yml`, `nginx.conf`.
- **Accès privé** : authentification HTTP gérée par nginx, comptes dans `/srv/sites/maillage/private/htpasswd`
  (root:101 640, hors dossier web). Sans compte valide, tout répond 401 (pages et données). Non indexé :
  en-tête `X-Robots-Tag`, `robots.txt`, balise `noindex`.

## Publier une mise à jour (depuis le Mac)

```bash
cd demonstrateur && ./deploy/deploy-vps.sh
```

Le Mac envoie le code (dépôt nu `/srv/sites/maillage/depot.git`) ; **le VPS construit et publie** (`deploy/vps/publier.sh`,
unités systemd `maillage-*`), après contrôle des données, tests du calculateur et build. `--donnees` force la mise à jour
des horaires, `--retour` remet les données précédentes, `--config` envoie aussi `compose*.yml` et `nginx.conf` puis relance
le conteneur. Mise à jour automatique chaque matin et e-mails : [../EXPLOITATION.md](../EXPLOITATION.md), section 3.

## Comptes d'accès

Les commandes ci-dessous lisent l'accès au serveur dans `deploy/config.sh` (non versionné, modèle `deploy/config.exemple.sh`) : lancer d'abord `. deploy/config.sh` depuis `demonstrateur/`.

Ajouter un compte (le mot de passe est demandé deux fois au clavier, rien n'est stocké en clair) ; remplacer `demo` par le nom voulu :

```bash
ssh -t -i "$VPS_KEY" "$VPS_HOST" 'h=$(openssl passwd -apr1) && echo "demo:$h" | sudo tee -a /srv/sites/maillage/private/htpasswd >/dev/null && echo "Compte ajouté"'
```

nginx relit le fichier à chaque requête : pas de redémarrage.

Le fichier est monté seul dans le conteneur : Docker suit son inode. Il faut donc le **réécrire sur place**
(`cat … >`), jamais le remplacer (`sed -i`, éditeur, `mv`), sinon le conteneur garde l'ancienne version.

Changer le mot de passe d'un compte (ici `demo`) :

```bash
ssh -t -i "$VPS_KEY" "$VPS_HOST" 'F=/srv/sites/maillage/private/htpasswd; h=$(openssl passwd -apr1) && sudo install -m 600 /dev/null $F.new && { sudo grep -v "^demo:" $F; printf "demo:%s\n" "$h"; } | sudo tee $F.new >/dev/null && sudo sh -c "cat $F.new > $F && rm $F.new" && echo "Mot de passe changé"'
```

Retirer un compte :

```bash
ssh -i "$VPS_KEY" "$VPS_HOST" 'F=/srv/sites/maillage/private/htpasswd; sudo sh -c "grep -v \"^demo:\" $F > $F.new; cat $F.new > $F && rm $F.new" && echo "Compte retiré"'
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
Code à coller dans le site de la commune : modèle `encart-exemple.html`, ou l'onglet Encart de l'espace mairie.

## Mesure d'usage (sans IP ni cookie)

nginx n'écrit qu'un journal : `/srv/sites/maillage/logs/usage.log`, une ligne par affichage de l'encart et par
ouverture de l'application (date, événement, compte, site d'origine, commune, provenance, type d'appareil).
Ni adresse IP, ni cookie, ni robots. On compte donc des affichages, pas des personnes.

```bash
./deploy/stats.sh        # 30 derniers jours
./deploy/stats.sh 7      # 7 derniers jours
```

## Alerte d'expiration des données

`check_data.py` contrôle, pour chaque territoire, la fin de validité des flux GTFS, la fin de la fenêtre
d'horaires précalculée et la publication d'une nouvelle version sur data.gouv.fr (alerte à 21 jours).
Le VPS le lance chaque matin sur les données en ligne (`maillage-donnees.timer`, 5 h) : une nouvelle version
déclenche la mise à jour, une échéance sans nouvelle version envoie un e-mail.
Après l'expiration, l'encart affiche « horaires en cours de mise à jour » au lieu de « aucun départ ».
