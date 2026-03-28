#!/usr/bin/env bash
# ClawBoard - VPS/Linux Installer
# Installe ClawBoard sur un serveur Linux (Debian/Ubuntu)
# Cree : service systemd + config nginx + build production
#
# Usage: bash install-vps.sh
# Usage silencieux: INSTALL_DIR=/opt/clawboard DOMAIN=clawboard.example.com bash install-vps.sh

set -euo pipefail

# ── Couleurs ──────────────────────────────────────────────────────────────────

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

log_info()    { echo -e "${CYAN}[INFO]${NC} $*"; }
log_success() { echo -e "${GREEN}[OK]${NC}   $*"; }
log_warn()    { echo -e "${YELLOW}[WARN]${NC} $*"; }
log_error()   { echo -e "${RED}[ERR]${NC}  $*"; }
log_step()    { echo -e "\n${BOLD}${CYAN}==> $*${NC}"; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo ""
echo -e "${CYAN}  ======================================"
echo -e "   ClawBoard - Installateur VPS Linux"
echo -e "  ======================================${NC}"
echo ""

# ── Verification root ─────────────────────────────────────────────────────────

if [[ $EUID -ne 0 ]]; then
  log_error "Ce script doit etre execute en tant que root (sudo bash install-vps.sh)"
  exit 1
fi

# ── Variables configurables ───────────────────────────────────────────────────

INSTALL_DIR="${INSTALL_DIR:-/opt/clawboard}"
DOMAIN="${DOMAIN:-}"
BACKEND_PORT="${BACKEND_PORT:-4000}"
SERVICE_USER="${SERVICE_USER:-www-data}"

# ── 1. Verification / installation de Node.js 20 LTS ─────────────────────────

log_step "1/9 - Verification de Node.js 20 LTS"

NODE_OK=false
if command -v node &>/dev/null; then
  NODE_MAJOR=$(node --version | sed 's/v\([0-9]*\).*/\1/')
  if [[ "$NODE_MAJOR" -ge 18 ]]; then
    log_success "Node.js $(node --version) deja installe."
    NODE_OK=true
  else
    log_warn "Node.js $(node --version) trop ancien. Installation de Node.js 20..."
  fi
fi

if [[ "$NODE_OK" == "false" ]]; then
  log_info "Installation de Node.js 20 LTS via NodeSource..."
  if command -v apt-get &>/dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
  elif command -v dnf &>/dev/null; then
    curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
    dnf install -y nodejs
  elif command -v yum &>/dev/null; then
    curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
    yum install -y nodejs
  else
    log_error "Gestionnaire de paquets non supporte. Installez Node.js 20 manuellement."
    exit 1
  fi
  log_success "Node.js $(node --version) installe."
fi

# ── 2. Verification / installation de nginx ───────────────────────────────────

log_step "2/9 - Verification de nginx"

if ! command -v nginx &>/dev/null; then
  log_info "Installation de nginx..."
  if command -v apt-get &>/dev/null; then
    apt-get install -y nginx
  elif command -v dnf &>/dev/null; then
    dnf install -y nginx
  elif command -v yum &>/dev/null; then
    yum install -y nginx
  fi
  log_success "nginx installe."
else
  log_success "nginx deja installe : $(nginx -v 2>&1 | head -1)"
fi

# ── 3. Saisie interactive de la configuration ─────────────────────────────────

log_step "3/9 - Configuration"

if [[ -z "$DOMAIN" ]]; then
  read -rp "  Domaine ou IP du serveur (ex: clawboard.example.com) [localhost]: " DOMAIN
  DOMAIN="${DOMAIN:-localhost}"
fi

read -rp "  URL PostgreSQL [postgresql://postgres:postgres@localhost:5432/clawboard]: " DB_URL
DB_URL="${DB_URL:-postgresql://postgres:postgres@localhost:5432/clawboard}"

read -rp "  Port backend [$BACKEND_PORT]: " INPUT_PORT
BACKEND_PORT="${INPUT_PORT:-$BACKEND_PORT}"

if [[ "$DOMAIN" == "localhost" || "$DOMAIN" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  ALLOWED_ORIGINS="http://${DOMAIN}"
else
  ALLOWED_ORIGINS="https://${DOMAIN}"
fi

log_info "  Domaine         : $DOMAIN"
log_info "  Base de donnees : $DB_URL"
log_info "  Port backend    : $BACKEND_PORT"
log_info "  Origines CORS   : $ALLOWED_ORIGINS"

# ── 4. Copie des fichiers vers le dossier d'installation ─────────────────────

log_step "4/9 - Copie des fichiers vers $INSTALL_DIR"

mkdir -p "$INSTALL_DIR"

# Copie en excluant .git, node_modules, dist, .env
rsync -a --delete \
  --exclude='.git' \
  --exclude='node_modules' \
  --exclude='dist' \
  --exclude='.env' \
  "$SCRIPT_DIR/" "$INSTALL_DIR/"

log_success "Fichiers copies vers $INSTALL_DIR"

# ── 5. npm install (prod) + build Vite ────────────────────────────────────────

log_step "5/9 - Installation des dependances et build"

cd "$INSTALL_DIR"

log_info "npm install --omit=dev..."
npm install --omit=dev --no-fund --no-audit --silent
log_success "Dependances installees."

log_info "npm run build (Vite)..."
npm run build
log_success "Build frontend termine."

# ── 6. Creation du fichier .env ───────────────────────────────────────────────

log_step "6/9 - Creation du fichier .env"

ENV_FILE="$INSTALL_DIR/.env"

if [[ -f "$ENV_FILE" ]]; then
  log_warn ".env existant conserve. Mise a jour des valeurs manquantes seulement."
else
  # Generation des cles cryptographiques
  SECRET_KEY=$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))")
  KEK_KEY=$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))")

  cat > "$ENV_FILE" <<EOF
# ClawBoard - Configuration production
# Genere automatiquement par install-vps.sh

PORT=$BACKEND_PORT
NODE_ENV=production

# Securite
CLAWBOARD_SECRET=$SECRET_KEY
CLAWBOARD_KEK=$KEK_KEY

# Base de donnees
DATABASE_URL=$DB_URL

# CORS
ALLOWED_ORIGINS=$ALLOWED_ORIGINS

# Launcher
LAUNCHER_USER=admin
LAUNCHER_PASS=admin
SETUP_DONE=false

# Redis (optionnel)
# REDIS_URL=redis://localhost:6379
EOF
  log_success ".env cree dans $ENV_FILE"
  log_warn "IMPORTANT : Le mot de passe admin est 'admin'. Changez-le via le wizard au premier lancement."
fi

# ── 7. Migration de la base de donnees ────────────────────────────────────────

log_step "7/9 - Migration de la base de donnees"

cd "$INSTALL_DIR"

if [[ -f "src/db/migrate.js" ]]; then
  log_info "Lancement de node src/db/migrate.js..."
  node --env-file=.env src/db/migrate.js && log_success "Migration reussie." || log_warn "Migration echouee (la DB sera creee au premier demarrage)."
else
  log_warn "src/db/migrate.js introuvable - migration ignoree."
fi

# ── 8. Service systemd ────────────────────────────────────────────────────────

log_step "8/9 - Creation du service systemd"

SERVICE_FILE="/etc/systemd/system/clawboard.service"

# Chemin de node
NODE_PATH=$(command -v node)

cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=ClawBoard
After=network.target postgresql.service

[Service]
Type=simple
User=$SERVICE_USER
WorkingDirectory=$INSTALL_DIR
ExecStart=$NODE_PATH launcher.mjs
Restart=always
RestartSec=5
EnvironmentFile=$INSTALL_DIR/.env

[Install]
WantedBy=multi-user.target
EOF

log_success "Service systemd cree : $SERVICE_FILE"

# Droits sur le dossier pour SERVICE_USER
chown -R "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR" 2>/dev/null || true

systemctl daemon-reload
systemctl enable clawboard
systemctl restart clawboard
log_success "Service clawboard demarre."

# ── 9. Configuration nginx ────────────────────────────────────────────────────

log_step "9/9 - Configuration nginx"

NGINX_CONF="/etc/nginx/sites-available/clawboard"
NGINX_ENABLED="/etc/nginx/sites-enabled/clawboard"

cat > "$NGINX_CONF" <<EOF
# ClawBoard - nginx reverse proxy
server {
    listen 80;
    server_name $DOMAIN;

    # Taille max body (pour uploads)
    client_max_body_size 10M;

    # Proxy vers le backend ClawBoard (mode prod = single process)
    location / {
        proxy_pass         http://127.0.0.1:$BACKEND_PORT;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade \$http_upgrade;
        proxy_set_header   Connection 'upgrade';
        proxy_set_header   Host \$host;
        proxy_set_header   X-Real-IP \$remote_addr;
        proxy_set_header   X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto \$scheme;
        proxy_cache_bypass \$http_upgrade;

        # SSE / streaming
        proxy_buffering    off;
        proxy_read_timeout 3600s;
    }
}
EOF

# Activation du site
if [[ ! -f "$NGINX_ENABLED" ]]; then
  ln -s "$NGINX_CONF" "$NGINX_ENABLED"
fi

# Test de la config nginx
nginx -t && systemctl reload nginx
log_success "nginx configure et recharge."

# ── Resume ────────────────────────────────────────────────────────────────────

if [[ "$DOMAIN" == "localhost" || "$DOMAIN" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  ACCESS_URL="http://${DOMAIN}"
else
  ACCESS_URL="https://${DOMAIN}"
fi

echo ""
echo -e "${GREEN}  ======================================"
echo -e "   Installation terminee avec succes !"
echo -e "  ======================================${NC}"
echo ""
echo -e "  ${BOLD}Acces ClawBoard :${NC}   $ACCESS_URL"
echo -e "  ${BOLD}Launcher (admin):${NC}   http://${DOMAIN}:3999"
echo ""
echo "  Commandes utiles :"
echo "    systemctl status clawboard   - etat du service"
echo "    systemctl restart clawboard  - redemarrer"
echo "    journalctl -u clawboard -f   - logs en temps reel"
echo ""
echo "  Identifiants par defaut : admin / admin"
echo "  Un wizard de configuration s'affichera au premier acces."
echo ""
if [[ "$DOMAIN" != "localhost" ]] && [[ ! "$DOMAIN" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo -e "  ${YELLOW}Pour activer HTTPS, installez certbot :${NC}"
  echo "    apt-get install -y certbot python3-certbot-nginx"
  echo "    certbot --nginx -d $DOMAIN"
  echo ""
fi
