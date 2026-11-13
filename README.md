# Maillage · démonstrateur (cas CoqueliGO)

Prototype web mobile-first de la Phase 0 (voir [../docs/roadmap.md](../docs/roadmap.md)). Il sert à montrer à une régie, à partir de **ses seules données ouvertes**, ce que pourrait être son service numérique voyageur.

> Démonstrateur indépendant et non officiel. Horaires **théoriques** uniquement. Il n'est affilié ni à CoqueliGO ni à Annonay Rhône Agglo.

## Démarrer

```bash
npm install
```

```bash
npm run data
```

```bash
npm run dev
```

Puis ouvrir http://localhost:5199 (de préférence en vue mobile).

`npm run data` télécharge (avec repli automatique sur `curl` si le Python de python.org n'a pas ses certificats racine) les GTFS déclarés dans `pipeline/tenants/coqueligo.json`, dont l'agrégat régional Oùra (~110 Mo). Comptez quelques minutes la première fois. Les données générées couvrent **60 jours** à partir du jour d'exécution : il faut relancer la commande ensuite.

Autres commandes : `npm run test:router` (tests du calculateur sur les vraies données) et `npm run build` (version statique dans `dist/`, déployable sur n'importe quel hébergement de fichiers).

## Ce que montre la démo

| Écran | Contenu | Source |
|---|---|---|
| Sens de circulation | Flèches discrètes **uniquement là où l'aller et le retour d'une ligne ne suivent pas le même chemin** (boucles, rues différentes) : le pipeline compare chaque tracé aux tracés de la même ligne en sens inverse (tolérance 25 m) et produit `oneway.geojson`. Plus visibles sur la ligne survolée ou sélectionnée. Exemples : navette centre-ville 94 % du tracé, ligne 1 42 %, la plupart des lignes 2 à 18 % | GTFS + pipeline |
| Aperçu de ligne | Au survol d'une ligne dans le panneau (pastille, ligne de départ) : mise en évidence sur la carte sans la déplacer, et fiche avec les deux sens, le nombre d'arrêts, les courses du jour et le prochain départ | GTFS |
| Carte | Filtre par type (CoqueliGO : urbain, TAD, scolaire · cars Région), mémorisé sur l'appareil. Survol (souris) ou toucher d'un tracé : ligne, nom, **provenance → destination** du tracé ; plusieurs lignes superposées sont listées, chacune ouvre sa fiche | GTFS + pipeline |
| Gares | 7 gares SNCF reliées à moins de 500 m d'un arrêt desservi (Péage-de-Roussillon, Saint-Rambert-d'Albon, Saint-Vallier, Valence, Lyon Part-Dieu, Saint-Étienne Bellevue, Saint-Péray) : sur la carte, dans la recherche et sur les fiches arrêt (« correspondance train ») | SNCF Open Data (ODbL) |
| Trains en correspondance | Tableau **départs / arrivées** de chaque gare sur la fiche des arrêts proches (TER, TGV, OUIGO, Intercités ; option « TER seulement »). Sur un itinéraire qui finit près d'une gare : **trains au départ après l'arrivée du bus**, marche et 5 min de marge comprises. Desserte ponctuelle signalée (ex. Saint-Péray, desservie uniquement le week-end du 14-15/11 : trains probablement déviés) | GTFS SNCF national (ODbL) |
| Itinéraires car + train | Les **TER** qui desservent les 7 gares reliées sont un flux du réseau à part entière : la recherche Annonay → Grenoble, Avignon ou Marseille propose « X75 puis TER ». 5 min minimum pour monter dans un train ; allers-retours inutiles supprimés ; une correspondance évitée compte pour 20 min de départ. Option « Trains (TER) » dans la recherche | GTFS SNCF national (ODbL) |
| Tarifs | Grille 2026-2027 (19 titres) et **tarif indicatif** de chaque itinéraire (tickets nécessaires selon la durée de validité et les correspondances) | Portail Matawan, relevé le 13/11/2026 |
| Explorer | Arrêts autour de soi et prochains départs, regroupés par ligne et direction, avec les deux prochains passages | GTFS |
| Fiche arrêt | Toutes les lignes, départs sur 48 h avec séparateurs de jour, badge « Sur réservation » pour le TAD, favori | GTFS |
| Fiche ligne | Sens, choix du jour, tous les départs (passés grisés), parcours détaillé : **remplace les fiches PDF** | GTFS |
| Itinéraire | Adresse ou arrêt → adresse ou arrêt, plusieurs options, marche, correspondances, « Partez dans X min », bascule au lendemain, TAD et lignes scolaires activables | GTFS + BAN |
| Réservation TAD | Formulaire en 1 écran, délai « veille avant 15 h » appliqué, confirmation. **Rien n'est envoyé.** | Config territoire |
| Info trafic | Honnête : aucune perturbation publiée, alertes d'expiration des données réelles, exemple fictif étiqueté | Pipeline |
| Mes trajets | Favoris sur l'appareil, liens billettique / Open Payment / agence, page « Sources et qualité » | Config + pipeline |

## Architecture (volontairement minimale)

```
pipeline/tenants/coqueligo.json      configuration du territoire (flux, liens, règles TAD)
pipeline/build_network.py            Python standard : téléchargement, contrôle, corrections,
                                      réconciliation des arrêts, sortie compacte
public/data/network.json  (~410 Ko) réseau complet : lignes, arrêts, pôles, courses, calendriers
public/data/lines.geojson (~790 Ko) tracés simplifiés
src/net.ts                           modèle, calendriers, prochains départs
src/router.ts                        calcul d'itinéraires (Connection Scan Algorithm)
src/map.tsx                          MapLibre GL 5 + fond OpenFreeMap
src/views/*                          écrans (Preact)
```

Aucun serveur applicatif : tout tourne dans le navigateur. C'est possible parce qu'un petit réseau tient dans 400 Ko.

### Ce que fait le pipeline
- télécharge 4 flux : urbain, scolaire, TAD et cars Région filtrés sur 6 km autour d'Annonay ;
- **corrige automatiquement** : 34 temps de parcours négatifs (scolaire), séquences dupliquées, couleurs de texte illisibles (contraste WCAG) ;
- **réconcilie les arrêts entre flux** : 936 arrêts → 527 pôles, dont 135 rapprochements inter-flux (la gare routière regroupe urbain, TAD, scolaire et Région) ;
- calcule les correspondances à pied (< 400 m) ;
- **recale sur la voirie les tracés droits** (critères : plus de 30 % de la longueur en segments droits de plus de 600 m, ou moins de 4 points/km, ce qui attrape aussi les 5S et 6S) : le TAD (100 %), les lignes scolaires B, C, E, G et H (70 à 90 %) et une partie des cars Région (E95, E96, 07-AN5) ne publient que des lignes droites d'arrêt à arrêt. Chaque suite de segments droits est remplacée par l'itinéraire routier OSRM passant par les mêmes arrêts. Si la route fait plus de 2,2 fois la ligne droite, la ligne droite est conservée. Résultats en cache (`.cache/osrm-cache.json`) ; à désactiver avec `--no-snap` ;
- **signale l'expiration** des flux (urbain et TAD s'arrêtent fin 2026).

### Garanties
- Chaque horaire affiché provient du GTFS. Le test `npm run test:router` le vérifie sur chaque étape d'itinéraire.
- Pas de compte, pas de traceur. Les favoris restent dans le navigateur. La seule requête externe avec saisie utilisateur part vers la Base Adresse Nationale (adresses tapées).

## Écarts assumés par rapport à la cible (docs/architecture-technique.md)

| Cible | Démonstrateur | Pourquoi |
|---|---|---|
| OpenTripPlanner 2 | CSA en TypeScript dans le navigateur | Pas de Java sur le poste, et inutile pour 15 000 connexions/jour. Pas de GTFS-RT ni de GTFS-Flex. |
| React Native / Expo | Web (Preact + Vite) | Démo partageable par simple lien |
| Tuiles PMTiles auto-hébergées | OpenFreeMap (gratuit, sans clé) | Rapidité de mise en place |
| Recalage des tracés : instance OSRM/Valhalla auto-hébergée, ou pfaedle (outil de référence pour recaler des GTFS sur OSM) | Serveur de démonstration public OSRM (usage léger, 1 requête/s, cache) | Rapidité de mise en place |
| Tracés réels des trajets | Lignes droites d'arrêt à arrêt sur l'itinéraire (les tracés de ligne, eux, sont réels) | Simplicité |

## Sécurité : alerte `npm audit` sur MapLibre 5
`npm audit` signale une vulnérabilité **critique** sur `maplibre-gl` ≤ 6.4.0 ([GHSA-jrc7-96c5-q579](https://github.com/advisories/GHSA-jrc7-96c5-q579)) : contournement du nettoyeur HTML `DOM.sanitize()`, donc risque de XSS.

- Dans MapLibre 5.24, ce nettoyeur n'est appelé qu'à un seul endroit : le contrôle d'attribution, qui affiche le HTML fourni par la source de tuiles (ici OpenFreeMap, un tiers).
- Le démonstrateur **désactive ce contrôle** (`attributionControl: false`) et affiche les crédits OpenStreetMap lui-même, en texte échappé par Preact. Le code vulnérable n'est donc jamais exécuté, et l'application n'utilise aucune popup HTML.
- MapLibre 6.18 (corrigé) a été essayé deux fois : son style ne se charge pas avec Vite 8. **À retenter** lors d'une prochaine mise à jour de MapLibre ou de Vite. L'alerte disparaîtra alors.

## Limites connues
- Seuls les **TER** sont intégrés au calcul d'itinéraire : les TGV, OUIGO et Intercités apparaissent dans les tableaux des gares, mais pas dans les itinéraires (billets et réservation différents).
- Horaires de trains théoriques. La SNCF publie un flux **temps réel GTFS-RT** (retards, suppressions) sur transport.data.gouv.fr, qui pourrait être branché ensuite.
- Le fichier `network.json` passe à ~770 Ko avec les trains, dont 2 154 passages pour Lyon Part-Dieu seule. On pourrait le réduire en limitant Lyon aux TER.
- Les tracés recalés sur la voirie sont **probables, pas certains** : le trajet réel d'un car scolaire ou d'un TAD peut différer. À faire valider par le réseau, idéalement en lui proposant de publier ces tracés dans ses GTFS.
- Horaires théoriques uniquement (le temps réel n'est pas publié en open data).
- L'expiration affichée pour l'urbain (2 janvier 2027) correspond au service du samedi : en semaine, les données publiées s'arrêtent dès le **18 décembre 2026**.
- Les lignes scolaires sont désactivées par défaut dans le calcul : leur ouverture au public reste à confirmer.
- Le TAD est modélisé comme des courses à horaires fixes. Le démonstrateur interdit d'enchaîner deux TAD.
- La réconciliation d'arrêts regroupe parfois des arrêts voisins de noms différents (ex. « Lycées » et « Boissy d'Anglas »). En production, une validation humaine unique est prévue.
