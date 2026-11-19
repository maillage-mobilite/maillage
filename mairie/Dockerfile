# Espace mairie de Maillage : Python seul (bibliothèque standard) + msmtp pour les liens de connexion.
# Le code est monté depuis le dépôt (/app) : une mise à jour = redémarrage du conteneur.
FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends msmtp ca-certificates tzdata && rm -rf /var/lib/apt/lists/*
ENV TZ=Europe/Paris PYTHONUNBUFFERED=1
COPY demarrer.sh /demarrer.sh
EXPOSE 8090
ENTRYPOINT ["/bin/sh", "/demarrer.sh"]
