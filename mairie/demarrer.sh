#!/bin/sh
# msmtp exige que son fichier de configuration (qui contient le mot de passe du relais) appartienne
# à l'utilisateur qui l'exécute : copie privée pour l'utilisateur du service, puis abandon des droits root.
set -eu
APP_UID="${APP_UID:-1000}"
if [ -f /run/secrets-msmtp/msmtprc ]; then
  cp /run/secrets-msmtp/msmtprc /etc/msmtprc
  chown "$APP_UID:$APP_UID" /etc/msmtprc && chmod 600 /etc/msmtprc
fi
exec setpriv --reuid="$APP_UID" --regid="$APP_UID" --clear-groups python3 -I /app/serveur.py
