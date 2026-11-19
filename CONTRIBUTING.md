# Contribuer à Maillage

Merci de votre intérêt. Le projet est jeune et maintenu par une seule personne : les contributions courtes et ciblées
ont le plus de chances d'être intégrées rapidement.

## Signaler un problème

Ouvrez un ticket en indiquant le territoire, l'écran (ou l'adresse de la page), ce que vous attendiez et ce que vous
avez vu. Pour un horaire ou un tracé faux, précisez la ligne, l'arrêt et le jour : l'erreur vient souvent des données
publiées par le réseau, et nous la lui signalerons.

Une faille de sécurité ne se signale pas dans un ticket public : écrivez à contact@tuatam.fr.

## Proposer du code

1. Préparez le poste et lancez l'application en local (voir « Démarrer » dans le [README](README.md)).
2. Faites une modification par proposition, avec un message de commit en français qui dit ce qui change pour
   l'utilisateur.
3. Avant d'envoyer, vérifiez que tout passe :

   ```bash
   npm run test:router && npm run build
   ```

Principes du projet :
- **Aucune dépendance de plus sans bonne raison.** Le pipeline et le serveur de l'espace mairie n'utilisent que la
  bibliothèque standard de Python ; l'application, Preact et MapLibre.
- **Chaque horaire affiché vient des données publiées.** Rien n'est inventé ni « lissé » sans le signaler.
- **Accessibilité** : navigation au clavier, contrastes suffisants, cibles tactiles de 44 px, textes clairs.
- **Vie privée** : pas de cookie côté voyageur, pas de traceur, pas d'adresse IP dans les journaux.

En proposant une contribution, vous acceptez qu'elle soit publiée sous la licence du projet ([AGPL-3.0](LICENSE)).

## Code de conduite

Soyez courtois et constructifs. Les propos discriminants, le harcèlement et les attaques personnelles ne sont pas
tolérés ; les messages concernés seront retirés et leurs auteurs exclus du projet. Signalement : contact@tuatam.fr.
