#!/usr/bin/env bash
# Installs the tunnel-panel web dashboard on this server: installs Node.js if
# missing, clones/updates the repo, builds the app, generates an admin
# account (random password, shown once, same "generate once, never write the
# raw secret to disk" pattern as the agent's -init), and runs it as a
# systemd service.
#
# Binds to 127.0.0.1:3000 by default -- deliberately not exposed on the
# public interface. The panel has no TLS of its own and holds every
# registered server's bearer token, so the safe default is: reach it over an
# SSH tunnel (printed at the end), or put a reverse proxy with real TLS
# (nginx + certbot, Caddy, etc.) in front of it yourself if you want it
# reachable directly. Pass --public to bind 0.0.0.0 instead, if you already
# have TLS termination sorted out in front of this or you understand the
# risk of a plaintext-HTTP login page on the open internet.
set -euo pipefail

REPO_URL="https://github.com/dr-hoseyn/tunnel-panel.git"
INSTALL_DIR="/opt/tunnel-panel"
SERVICE_FILE="/etc/systemd/system/tunnel-panel.service"
BIND_HOST="127.0.0.1"
ADMIN_EMAIL="admin@tunnel-panel.local"
NODE_MIN_MAJOR=20

for arg in "$@"; do
case "$arg" in
--public) BIND_HOST="0.0.0.0" ;;
esac
done

if [[ $EUID -ne 0 ]]; then
echo "This script must be run as root" >&2
exit 1
fi

node_major_version() {
command -v node &> /dev/null || { echo 0; return; }
node -v 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/'
}

if (( $(node_major_version) < NODE_MIN_MAJOR )); then
echo "Installing Node.js ${NODE_MIN_MAJOR}.x..."
if command -v apt-get &> /dev/null; then
curl -fsSL "https://deb.nodesource.com/setup_${NODE_MIN_MAJOR}.x" | bash -
apt-get install -y nodejs
else
echo "Unsupported distro for automatic Node.js install -- install Node.js ${NODE_MIN_MAJOR}+ yourself and re-run." >&2
exit 1
fi
fi

if ! command -v git &> /dev/null; then
if command -v apt-get &> /dev/null; then
apt-get update -qq && apt-get install -y git
else
echo "git is required but not available." >&2
exit 1
fi
fi

if [[ -d "${INSTALL_DIR}/.git" ]]; then
echo "Existing install found, updating..."
git -C "$INSTALL_DIR" pull --ff-only
else
echo "Cloning ${REPO_URL}..."
git clone --depth 1 "$REPO_URL" "$INSTALL_DIR"
fi

cd "${INSTALL_DIR}/panel"

echo "Installing dependencies (this can take a minute)..."
npm install --no-audit --no-fund

ENV_FILE="${INSTALL_DIR}/panel/.env"
if [[ ! -f "$ENV_FILE" ]]; then
echo "Generating .env..."
AUTH_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")
cat > "$ENV_FILE" <<EOF
DATABASE_URL="file:./dev.db"
AUTH_SECRET="${AUTH_SECRET}"
EOF
fi

echo "Applying database migrations..."
npx prisma migrate deploy

ADMIN_PASSWORD=""
EXISTING_ADMIN_COUNT=$(node -e "
const Database = require('better-sqlite3');
const db = new Database('${INSTALL_DIR}/panel/dev.db');
console.log(db.prepare('SELECT COUNT(*) AS c FROM User').get().c);
" 2>/dev/null || echo "0")

if [[ "$EXISTING_ADMIN_COUNT" == "0" ]]; then
ADMIN_PASSWORD=$(node -e "console.log(require('crypto').randomBytes(12).toString('base64url'))")
SEED_ADMIN_EMAIL="$ADMIN_EMAIL" SEED_ADMIN_PASSWORD="$ADMIN_PASSWORD" npm run db:seed
else
echo "An admin account already exists -- leaving it as is, not generating a new password."
fi

echo "Building (production)..."
npm run build

cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=Tunnel Panel (web dashboard)
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=${INSTALL_DIR}/panel
ExecStart=${INSTALL_DIR}/panel/node_modules/.bin/next start -H ${BIND_HOST} -p 3000
Restart=always
RestartSec=3
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now tunnel-panel.service

echo ""
echo "tunnel-panel installed and running."
echo ""
if [[ "$BIND_HOST" == "127.0.0.1" ]]; then
echo "Bound to localhost only (no public exposure, no TLS of its own -- see the"
echo "note at the top of this script). Reach it via an SSH tunnel:"
echo "  ssh -L 3000:localhost:3000 root@$(hostname -I | awk '{print $1}')"
echo "then open http://localhost:3000 on your own machine."
echo ""
echo "To expose it directly instead (only if you're putting real TLS in front"
echo "of it yourself), re-run with --public."
else
echo "Bound to 0.0.0.0:3000 -- reachable at http://$(hostname -I | awk '{print $1}'):3000"
echo "This is plaintext HTTP. Put a reverse proxy with real TLS in front of it"
echo "if this server is reachable from the internet."
fi
echo ""
if [[ -n "$ADMIN_PASSWORD" ]]; then
echo "Admin login -- save this now, it will not be shown again:"
echo "  Email:    ${ADMIN_EMAIL}"
echo "  Password: ${ADMIN_PASSWORD}"
else
echo "Admin account already existed; sign in with your existing credentials."
fi
