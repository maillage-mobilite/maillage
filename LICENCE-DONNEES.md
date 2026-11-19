# Licence des données

Le **code** de ce dépôt est sous licence [AGPL-3.0](LICENSE). Les **données** qu'il contient ou qu'il produit ne
sont pas couvertes par cette licence : elles restent sous la licence de leurs sources.

## Données générées (`public/data/`)

Les fichiers de `public/data/` sont produits par le pipeline (`npm run data`) à partir des sources ci-dessous.
Comme ils combinent des bases sous **ODbL**, ils sont mis à disposition sous
[Open Database License (ODbL) 1.0](https://opendatacommons.org/licenses/odbl/1-0/) : vous pouvez les réutiliser,
y compris commercialement, en citant les sources et en partageant à l'identique les bases que vous en dérivez.

Ils ne servent qu'au développement : le service en ligne les reconstruit chaque jour à partir des sources.
Ce sont des horaires **théoriques**, sans garantie d'exactitude.

## Sources

| Source | Producteur | Licence | Utilisée pour |
|---|---|---|---|
| GTFS urbain, scolaire et transport à la demande CoqueliGO | Annonay Rhône Agglo, via [transport.data.gouv.fr](https://transport.data.gouv.fr) | Licence Ouverte v2 | CoqueliGO |
| GTFS réseau urbain du Pays de Gex (lignes TPG) | Pays de Gex Agglo, via transport.data.gouv.fr | Licence Ouverte v2 | Pays de Gex |
| Agrégat régional Oùra (cars Région Auvergne-Rhône-Alpes) | Région Auvergne-Rhône-Alpes, via transport.data.gouv.fr | ODbL | les deux territoires |
| GTFS SNCF (TER, TGV, Intercités) | SNCF Voyageurs, via transport.data.gouv.fr | ODbL | trains en correspondance |
| Gares de voyageurs | [SNCF Open Data](https://ressources.data.sncf.com) | ODbL | gares |
| Horaire national suisse (GTFS) | [opentransportdata.swiss](https://opentransportdata.swiss) | conditions d'utilisation d'opentransportdata.swiss (source à citer) | trains suisses (Pays de Gex) |
| OpenStreetMap | © [contributeurs OpenStreetMap](https://www.openstreetmap.org/copyright) | ODbL | lieux utiles, tracés recalés sur la chaussée et les voies ferrées (OSRM) |
| Grille tarifaire CoqueliGO | portail d'information voyageurs du réseau (relevé manuel) | faits publics, source citée | tarifs indicatifs |

Les adresses exactes des jeux de données sont déclarées dans `pipeline/tenants/*.json`.

## Services appelés depuis le navigateur

Fond de carte [OpenFreeMap](https://openfreemap.org) et CyclOSM (données OpenStreetMap), orthophotographies de
l'IGN (Géoplateforme, Licence Ouverte), géocodage par la Base Adresse Nationale, itinéraires à pied par le service
OSRM de FOSSGIS. Leurs conditions d'utilisation s'appliquent.

## Nom et marque

La licence AGPL porte sur le code. Elle ne donne aucun droit sur le nom « Maillage », sur l'identité visuelle du
service ni sur les noms des réseaux présentés (CoqueliGO, TPG, etc.), qui restent à leurs titulaires. Un service
dérivé doit porter un autre nom. Ce projet est indépendant et n'est affilié à aucun des réseaux présentés.
