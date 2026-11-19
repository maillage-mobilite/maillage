# Accès au serveur de publication. Copier ce fichier en deploy/config.sh (non versionné) et l'adapter :
#   cp deploy/config.exemple.sh deploy/config.sh
VPS_HOST="ubuntu@mon-serveur.example.org"   # compte SSH sur le serveur
VPS_KEY="$HOME/.ssh/id_ed25519"              # clé SSH utilisée pour s'y connecter
VPS_IP="203.0.113.10"                        # adresse IPv4 publique du serveur (vérification du DNS)
# sites des communes autorisés à afficher l'encart (frame-ancestors), séparés par des espaces ;
# appliqué par ./deploy/deploy-vps.sh --config
ENCART_SITES="https://www.ma-commune.fr https://ma-commune.fr"
