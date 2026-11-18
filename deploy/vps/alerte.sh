#!/bin/sh
# E-mails de Maillage (exécuté en root par systemd : msmtp lit /etc/msmtprc, relais commun du VPS).
#   alerte.sh echec <unité>   échec d'une publication : dernières lignes du journal
#   alerte.sh changements     nouvelles données publiées : résumé, puis effacement de a-signaler.txt
# Destinataire : /srv/sites/maillage/private/alerte.conf (une ligne : l'adresse), hors dépôt.
set -eu
BASE=/srv/sites/maillage
DEST=$(head -1 "$BASE/private/alerte.conf")
case "${1:-}" in
  echec)
    { echo "Subject: [Maillage] Échec : ${2:-publication}"; echo "To: $DEST"; echo "Content-Type: text/plain; charset=utf-8"; echo
      echo "Le site et les données en ligne n'ont pas été modifiés."
      echo "Relancer à la main sur le VPS : sudo systemctl start ${2:-maillage-donnees}"; echo
      echo "Dernières lignes du journal :"; echo
      journalctl -u "${2:-maillage-donnees}" -n 60 --no-pager -o cat; } | msmtp "$DEST" ;;
  changements)
    [ -s "$BASE/a-signaler.txt" ] || exit 0
    { echo "Subject: [Maillage] Nouvelles données publiées"; echo "To: $DEST"; echo "Content-Type: text/plain; charset=utf-8"; echo
      echo "La mise à jour automatique a publié de nouvelles données :"; echo
      cat "$BASE/a-signaler.txt"; echo
      echo "En cas de problème, revenir à la version précédente : sudo systemctl start maillage-retour"; } | msmtp "$DEST"
    rm -f "$BASE/a-signaler.txt" ;;
  *) echo "usage : $0 echec <unité> | changements" >&2; exit 1 ;;
esac
