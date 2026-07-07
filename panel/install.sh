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
# SSH tunnel (printed at the end).
#
# --domain <domain>  Installs Caddy as a reverse proxy in front of the panel
#                     and points it at that domain -- Caddy obtains and
#                     auto-renews a real Let's Encrypt certificate with zero
#                     further config. The panel itself stays bound to
#                     127.0.0.1 either way; only Caddy is public. Requires
#                     the domain's DNS to already point at this server (Let's
#                     Encrypt cannot issue a certificate for a bare IP).
#
# --public            Binds the panel directly to 0.0.0.0 instead (plaintext
#                      HTTP, no TLS). Only for when you're fronting this with
#                      your own separately-managed reverse proxy/TLS. Ignored
#                      if --domain is given, since Caddy is the public
#                      interface in that case.
set -euo pipefail

# Runs headless (bash <(curl ...), no TTY) -- apt must never stop to ask
# anything. Without this, Ubuntu's needrestart hook in particular can pop an
# interactive "which services should be restarted?" dialog after installing
# packages, which silently stalls/short-circuits the apt-get invocation with
# nothing obviously wrong in the log (this is what happened during testing:
# `apt-get install -y build-essential` appeared to run, but the same session
# still couldn't find `make` a few lines later).
export DEBIAN_FRONTEND=noninteractive
export NEEDRESTART_MODE=a

REPO_URL="https://github.com/dr-hoseyn/tunnel-panel.git"
INSTALL_DIR="/opt/tunnel-panel"
SERVICE_FILE="/etc/systemd/system/tunnel-panel.service"
BIND_HOST="127.0.0.1"
ADMIN_EMAIL="admin@tunnel-panel.local"
NODE_MIN_MAJOR=20
DOMAIN=""

while [[ $# -gt 0 ]]; do
case "$1" in
--public) BIND_HOST="0.0.0.0"; shift ;;
--domain)
DOMAIN="${2:-}"
[[ -z "$DOMAIN" ]] && { echo "--domain needs a value, e.g. --domain panel.example.com" >&2; exit 1; }
shift 2
;;
*) shift ;;
esac
done

# Caddy is the public interface when a domain is given -- the panel itself
# always stays internal-only in that mode, regardless of --public.
[[ -n "$DOMAIN" ]] && BIND_HOST="127.0.0.1"

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

# better-sqlite3 (Prisma's SQLite driver adapter) is a native module -- if
# no prebuilt binary matches this exact node/glibc/arch combination, npm
# falls back to compiling it from source, which needs a C++ toolchain.
# Installed unconditionally rather than probed for, since detecting "is a
# prebuilt binary available for this exact target" in advance isn't
# practical here and installing build-essential when it's not needed is
# harmless.
if ! command -v make &> /dev/null || ! command -v g++ &> /dev/null; then
echo "Installing build tools (needed to compile better-sqlite3 if no prebuilt binary matches this server)..."
if command -v apt-get &> /dev/null; then
apt-get update -qq && apt-get install -y build-essential python3
else
echo "build-essential (make/g++) is required but couldn't be installed automatically -- install it yourself and re-run." >&2
exit 1
fi
fi

if [[ -d "${INSTALL_DIR}/.git" ]]; then
echo "Existing install found, updating..."
# This clone is fully owned by this installer -- nothing in it is meant to
# be hand-edited. `reset --hard` (not just `checkout -- .`) because `npm
# install` can leave package-lock.json changes *staged*, not just modified
# in the working tree, depending on the npm version; `checkout -- .` alone
# doesn't touch the index and wasn't enough to unblock a real run. Safe
# specifically because of that ownership -- HEAD is always what's in git,
# and .env/dev.db/node_modules are untracked/gitignored so this never
# touches them either way.
git -C "$INSTALL_DIR" reset --hard HEAD
git -C "$INSTALL_DIR" pull --ff-only
else
echo "Cloning ${REPO_URL}..."
git clone --depth 1 "$REPO_URL" "$INSTALL_DIR"
fi

cd "${INSTALL_DIR}/panel"

echo "Installing dependencies (this can take a minute)..."
# npm ci, not npm install: it never rewrites package-lock.json (npm install
# can, e.g. with platform-specific optional dependency entries resolving
# differently than what was committed from a different OS) -- this is what
# was dirtying the lockfile and breaking the *next* run's `git pull` above,
# even after adding the reset, since it would just get re-dirtied every
# time regardless of what happened before `npm install` ran.
npm ci --no-audit --no-fund

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

echo "Generating Prisma Client..."
npx prisma generate

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

if [[ -n "$DOMAIN" ]]; then
if ! command -v caddy &> /dev/null; then
echo "Installing Caddy..."
if command -v apt-get &> /dev/null; then
apt-get update -qq
apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list > /dev/null
chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg
chmod o+r /etc/apt/sources.list.d/caddy-stable.list
apt-get update -qq
apt-get install -y caddy
else
echo "Unsupported distro for automatic Caddy install -- install it yourself and re-run with --domain." >&2
exit 1
fi
fi

mkdir -p /etc/caddy/conf.d
# Composable rather than overwriting the main Caddyfile outright, in case
# this Caddy instance ends up fronting anything else on this server later.
touch /etc/caddy/Caddyfile
grep -qxF "import /etc/caddy/conf.d/*.caddy" /etc/caddy/Caddyfile || echo "import /etc/caddy/conf.d/*.caddy" >> /etc/caddy/Caddyfile
cat > /etc/caddy/conf.d/tunnel-panel.caddy <<EOF
${DOMAIN} {
	reverse_proxy 127.0.0.1:3000
}
EOF

if command -v ufw &> /dev/null && ufw status | grep -q "Status: active"; then
ufw allow 80/tcp > /dev/null 2>&1
ufw allow 443/tcp > /dev/null 2>&1
fi

systemctl daemon-reload
systemctl enable --now caddy
systemctl reload caddy 2>/dev/null || systemctl restart caddy
fi

echo ""
echo "tunnel-panel installed and running."
echo ""
if [[ -n "$DOMAIN" ]]; then
echo "Reachable at https://${DOMAIN} -- Caddy obtains and auto-renews a real"
echo "Let's Encrypt certificate for it automatically. This only works if"
echo "${DOMAIN}'s DNS already points at this server's IP; if it doesn't yet,"
echo "fix the DNS record and run: systemctl restart caddy"
elif [[ "$BIND_HOST" == "127.0.0.1" ]]; then
echo "Bound to localhost only (no public exposure, no TLS of its own). Reach"
echo "it via an SSH tunnel:"
echo "  ssh -L 3000:localhost:3000 root@$(hostname -I | awk '{print $1}')"
echo "then open http://localhost:3000 on your own machine."
echo ""
echo "For direct access with a real certificate instead, re-run with"
echo "--domain <your-domain> (needs DNS already pointed at this server)."
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
