# Maillage · démonstrateur (CoqueliGO, Pays de Gex)

Prototype web mobile-first de la Phase 0 (voir [../docs/roadmap.md](../docs/roadmap.md)). Il sert à montrer à une régie, à partir de **ses seules données ouvertes**, ce que pourrait être son service numérique voyageur.

En ligne (accès privé) : https://maillage.tuatam.fr. **Mise à jour des horaires, moteurs OSRM, publication, encart, statistiques : voir [EXPLOITATION.md](EXPLOITATION.md).** Serveur et comptes : [deploy/README.md](deploy/README.md).

> Démonstrateur indépendant et non officiel. Horaires **théoriques** uniquement. Il n'est affilié à aucun des réseaux présentés (CoqueliGO, Annonay Rhône Agglo, Pays de Gex Agglo, TPG).

## Démarrer

```bash
npm install
```

```bash
pipeline/osrm/osrm.sh start && pipeline/osrm/osrm.sh start-rail && pipeline/osrm/osrm.sh start-genf
```

```bash
npm run data
```

```bash
npm run dev
```

Les moteurs OSRM (Docker) recalent les tracés sur la chaussée et les voies ferrées ; à préparer une fois avec `prepare`, `prepare-rail` et `prepare-genf` (voir [EXPLOITATION.md](EXPLOITATION.md)). Sans eux, `npm run data` fonctionne, mais les tracés restent grossiers.

Puis ouvrir http://localhost:5199 (de préférence en vue mobile) : la page d'accueil propose les territoires. Accès direct : `?reseau=coqueligo` ou `?reseau=paysdegex`.

`npm run data` télécharge (avec repli automatique sur `curl` si le Python de python.org n'a pas ses certificats racine) les GTFS déclarés dans `pipeline/tenants/coqueligo.json` puis `pipeline/tenants/paysdegex.json` (un seul territoire : `npm run data:coqueligo` ou `npm run data:paysdegex`), dont l'agrégat régional Oùra (~110 Mo). Comptez quelques minutes la première fois. Les données générées couvrent **60 jours** à partir du jour d'exécution : il faut relancer la commande ensuite.

**Trains suisses (Pays de Gex).** Le flux `train-ch` part de l'horaire national suisse (opentransportdata.swiss, ~400 Mo pour deux années d'horaires, dont 3,7 Go de `stop_times` décompressés). `pipeline/extract_gtfs.py` n'en garde, en une minute, que les trains qui passent à moins de 13 km de Genève (≈ 4 Mo). Le Léman Express, les TER et les trains SNCF sont écartés : ils figurent déjà dans le flux SNCF. Les sources sont retéléchargées au plus tous les 3 jours. Chaque année, avant le changement de service de décembre, il faut ajouter l'horaire de l'année suivante (`timetable-AAAA-gtfs2020`) dans `pipeline/tenants/paysdegex.json` ; l'alerte d'expiration (`npm run check:data`) le rappelle 21 jours avant. Les lignes suisses sont tracées de gare en gare (le moteur ferroviaire OSRM ne couvre que Rhône-Alpes).

Autres commandes : `npm run test:router` (tests du calculateur sur les vraies données), `npm run check:data` (alerte d'expiration des données), `npm run build` (version statique dans `dist/`, pages `index.html` et `widget.html`) et `./deploy/deploy-vps.sh` (publication sur maillage.tuatam.fr).

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
| Mes lieux | Domicile, Travail, École et lieux libres (adresse, arrêt ou gare), enregistrés sur l'appareil. Sur l'accueil : **prochain trajet** vers chacun (« Partez dans 11 min · ligne 2 · arrivée 14:11 ») ; dans l'itinéraire : raccourcis et suggestions en tête | Appareil |
| Explorer | Arrêts autour de soi et prochains départs, regroupés par ligne et direction, avec les deux prochains passages | GTFS |
| Fiche arrêt | Toutes les lignes, départs sur 48 h avec séparateurs de jour, badge « Sur réservation » pour le TAD, favori | GTFS |
| Fiche ligne | Sens, choix du jour, tous les départs (passés grisés), parcours détaillé : **remplace les fiches PDF** | GTFS |
| Itinéraire | Adresse ou arrêt → adresse ou arrêt, plusieurs options, marche, correspondances, « Partez dans X min », bascule au lendemain, TAD et lignes scolaires activables | GTFS + BAN |
| Réservation TAD | Formulaire en 1 écran, délai « veille avant 15 h » appliqué, confirmation. **Rien n'est envoyé.** | Config territoire |
| Info trafic | Honnête : aucune perturbation publiée, alertes d'expiration des données réelles, exemple fictif étiqueté | Pipeline |
| Mes trajets | Favoris sur l'appareil, liens billettique / Open Payment / agence, page « Sources et qualité » | Config + pipeline |
| Territoires | Page d'accueil de choix du territoire ; CoqueliGO (Annonay) et Pays de Gex (Ornex) | Config par territoire |
| Lieux utiles | Mairies, services, écoles, santé, culture et sport, commerces, déchetteries, aéroport : pastille à pictogramme par catégorie, **légende-filtre** (puce « Lieux ▾ »), fiche avec horaires, accessibilité, « Y aller », appel, site. Proposés dans la recherche (« mairie ornex », « piscine », « déchetterie ») | OpenStreetMap (ODbL) |
| Recherche | Arrêts, gares, lieux et adresses ; **navigation au clavier** (flèches, Entrée, Échap) | GTFS, OSM, BAN |
| Trains suisses (Pays de Gex) | Trains CFF dans les itinéraires (RE33, IR90, IC1…, pastille rouge), Cornavin réunissant bus, SNCF et CFF : Ornex → Lausanne par la 60 puis le RE33 | opentransportdata.swiss |
| Encarts pour un site de commune | Page `widget.html` (publique), trois formats : **complet** (page Transports), **compact** (accueil), **« Comment venir »** à un lieu (arrêts proches, marche, départs, itinéraire prérempli) ; couleur de la commune ; hauteur ajustée automatiquement ; message clair après expiration. Démonstration : `demo-encarts.html` | GTFS + OSM + pipeline |

## Architecture (volontairement minimale)

```
pipeline/tenants/<id>.json           configuration d'un territoire (flux, liens, règles TAD, lacunes)
pipeline/build_network.py            Python standard : téléchargement, contrôle, corrections,
                                      réconciliation des arrêts, sortie compacte
public/data/tenants.json             registre des territoires (page d'accueil)
public/data/<id>/network.json (~410 Ko) réseau complet : lignes, arrêts, pôles, courses, calendriers
public/data/<id>/lines.geojson (~790 Ko) tracés simplifiés
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
- **trace les TER sur les voies ferrées** avec un second moteur OSRM local au **profil « rail »** (`pipeline/osrm/rail.lua`, `osrm.sh prepare-rail` / `start-rail`, port 5056), gare par gare ; les tronçons hors de l'extrait Rhône-Alpes restent droits ;
- **apparie sur la chaussée tous les tracés CoqueliGO** (et, depuis, les cars Région), comble les trous d'appariement par un itinéraire routier et répare les segments droits restants (urbain, scolaire, TAD) avec un **moteur OSRM local au profil « bus »** (voies réservées aux bus autorisées) : chaque tracé est rééchantillonné tous les 35 m puis apparié par blocs ; un bloc n'est remplacé que si ≥ 90 % des points sont appariés et que la longueur reste entre 0,8 et 1,25 × l'original. Bilan au 13/11 : 193 tracés, 5 blocs gardés tels quels, écart corrigé médian 1-3 m (p95 ≈ 25 m pour 5S et 6S, les plus décalées). Moteur : `pipeline/osrm/osrm.sh prepare` puis `start` (Docker, http://localhost:5055) ; sans moteur lancé, l'étape est ignorée ;
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
| Recalage des tracés : instance OSRM/Valhalla auto-hébergée, ou pfaedle (outil de référence pour recaler des GTFS sur OSM) | Trois moteurs OSRM locaux (Docker : bus et rail Rhône-Alpes, bus Genève) ; serveur public OSRM en repli pour les portions hors extrait | Les moteurs tournent sur le poste, pas sur le serveur |
| Tracés réels des trajets | Lignes droites d'arrêt à arrêt sur l'itinéraire (les tracés de ligne, eux, sont réels) | Simplicité |

## Sécurité : alerte `npm audit` sur MapLibre 5
`npm audit` signale une vulnérabilité **critique** sur `maplibre-gl` ≤ 6.4.0 ([GHSA-jrc7-96c5-q579](https://github.com/advisories/GHSA-jrc7-96c5-q579)) : contournement du nettoyeur HTML `DOM.sanitize()`, donc risque de XSS.

- Dans MapLibre 5.24, ce nettoyeur n'est appelé qu'à un seul endroit : le contrôle d'attribution, qui affiche le HTML fourni par la source de tuiles (ici OpenFreeMap, un tiers).
- Le démonstrateur **désactive ce contrôle** (`attributionControl: false`) et affiche les crédits OpenStreetMap lui-même, en texte échappé par Preact. Le code vulnérable n'est donc jamais exécuté, et l'application n'utilise aucune popup HTML.
- MapLibre 6.18 (corrigé) a été essayé deux fois : son style ne se charge pas avec Vite 8. **À retenter** lors d'une prochaine mise à jour de MapLibre ou de Vite. L'alerte disparaîtra alors.

## Limites connues
- **Lignes TER affichées par leur parcours** (« TER · Mâcon – Lyon Perrache – Valence ») : les codes du GTFS SNCF (K4, K64, P4…) ne sont pas les numéros affichés aux voyageurs (TER Auvergne-Rhône-Alpes numérote ses lignes 01 à 76) et un même code sert dans plusieurs régions. Vérifié le 13/11/2026 sur ter.sncf.com.
- **Marche par les rues** : chaque étape à pied est recalculée après coup par le service OSRM piéton public de FOSSGIS (coordonnées envoyées à ce tiers ; en production, un moteur hébergé). Le calcul lui-même choisit les correspondances sur une estimation à vol d'oiseau × 1,25 : une correspondance devenue trop juste par les rues est signalée, pas recalculée.
- Côté SNCF, seuls les **TER** sont intégrés au calcul d'itinéraire : les TGV, OUIGO et Intercités apparaissent dans les tableaux des gares, mais pas dans les itinéraires (billets et réservation différents). Au Pays de Gex s'y ajoutent les **trains suisses** (CFF), sans temps réel et absents des tableaux de gare.
- **Tracés hors extrait OSM** : trains suisses et portions suisses des TER tracés de gare en gare ; à l'aéroport de Genève, la boucle de demi-tour de la ligne 66 est déduite du calcul d'itinéraire (les TPG ne publient aucun tracé).
- **Temps réel des trains** (GTFS-RT SNCF via transport.data.gouv.fr) : retards, suppressions et arrêts supprimés dans les tableaux de gare et les correspondances, rafraîchis chaque minute tant qu'ils sont affichés. Le flux national pèse ~900 Ko : en production, un serveur le filtrerait sur les gares du réseau. Pas encore appliqué aux trajets TER dans le détail d'un itinéraire.
- Le fichier `network.json` passe à ~770 Ko avec les trains, dont 2 154 passages pour Lyon Part-Dieu seule. On pourrait le réduire en limitant Lyon aux TER.
- Les tracés recalés sur la voirie sont **probables, pas certains** : le trajet réel d'un car scolaire ou d'un TAD peut différer. À faire valider par le réseau, idéalement en lui proposant de publier ces tracés dans ses GTFS.
- Bus et cars : horaires théoriques uniquement (le temps réel CoqueliGO n'est pas publié en open data).
- L'expiration affichée pour l'urbain (2 janvier 2027) correspond au service du samedi : en semaine, les données publiées s'arrêtent dès le **18 décembre 2026**.
- Les lignes scolaires sont désactivées par défaut dans le calcul : leur ouverture au public reste à confirmer.
- Le TAD est modélisé comme des courses à horaires fixes. Le démonstrateur interdit d'enchaîner deux TAD.
- La réconciliation d'arrêts regroupe parfois des arrêts voisins de noms différents (ex. « Lycées » et « Boissy d'Anglas »). En production, une validation humaine unique est prévue.
