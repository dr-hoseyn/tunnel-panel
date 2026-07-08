#!/usr/bin/env bash
# Installs the tunnel-panel Agent on this VPS: downloads the prebuilt
# static binary from the latest GitHub release (built by
# .github/workflows/build-agent.yml, same "download the real release asset,
# verify it runs, atomic-replace into place" pattern tunnel-manager.sh
# itself uses for every tunnel core binary), installs the systemd unit, and
# runs -init to generate this VPS's bearer token.
#
# Requires: tunnel-manager.sh already installed at /opt/tunnel-manager
# (github.com/dr-hoseyn/tunnel-manager) -- the Agent shells out to it, it
# does not duplicate its logic.
set -euo pipefail

REPO="dr-hoseyn/tunnel-panel"
BIN_PATH="/usr/local/bin/tunnel-agent"
DATA_DIR="/etc/tunnel-agent"
SERVICE_FILE="/etc/systemd/system/tunnel-agent.service"

if [[ $EUID -ne 0 ]]; then
echo "This script must be run as root" >&2
exit 1
fi

if [[ ! -f /opt/tunnel-manager/tunnel-manager.sh ]]; then
echo "tunnel-manager.sh not found at /opt/tunnel-manager -- install it first:" >&2
echo "  bash <(curl -fsSL https://raw.githubusercontent.com/dr-hoseyn/tunnel-manager/main/install.sh)" >&2
exit 1
fi

arch=$(uname -m)
case "$arch" in
x86_64) asset="tunnel-agent-linux-amd64" ;;
aarch64|arm64) asset="tunnel-agent-linux-arm64" ;;
*)
echo "Unsupported architecture: ${arch}" >&2
exit 1
;;
esac

latest_url=$(curl -fsSL -o /dev/null -w '%{url_effective}' "https://github.com/${REPO}/releases/latest")
tag="${latest_url##*/}"
if [[ -z "$tag" ]]; then
echo "Could not determine the latest tunnel-panel release." >&2
exit 1
fi

dl_url="https://github.com/${REPO}/releases/download/${tag}/${asset}"
tmp_dir=$(mktemp -d)
trap 'rm -rf "$tmp_dir"' EXIT

echo "Downloading ${dl_url}..."
curl -fsSL "$dl_url" -o "${tmp_dir}/tunnel-agent"
chmod +x "${tmp_dir}/tunnel-agent"

mkdir -p "$DATA_DIR"
tmp_bin=$(mktemp "$(dirname "$BIN_PATH")/.tunnel-agent.XXXXXX")
cp "${tmp_dir}/tunnel-agent" "$tmp_bin"
chmod +x "$tmp_bin"
mv -f "$tmp_bin" "$BIN_PATH"

GENERATED_TOKEN=""
if [[ ! -f "${DATA_DIR}/token.hash" ]]; then
echo ""
INIT_OUTPUT=$("$BIN_PATH" -init -data-dir "$DATA_DIR")
echo "$INIT_OUTPUT"
echo ""
echo "^ Copy that token now -- it will not be shown again. It's what you'll"
echo "  enter in the panel when registering this server."
# -init's output is "<label line>\n<token>\n\n<instructions>" -- line 2 is
# the raw token. Captured here (not just printed) so the JSON summary line
# at the end can carry it too, for automated callers.
GENERATED_TOKEN=$(sed -n '2p' <<< "$INIT_OUTPUT")
else
echo "Existing token found at ${DATA_DIR}/token.hash -- leaving it as is."
fi

# Generate (or load, if it already exists) the TLS cert now, before the
# service ever starts -- not after. The service's own startup path also
# calls LoadOrGenerate, and if nothing has created the cert yet by the time
# `systemctl enable --now` returns, this command and the freshly-started
# service race to generate it independently: whichever writes the cert file
# last wins on disk, but the fingerprint already printed to the user could
# be from the *other* one, so it silently wouldn't match what the running
# service actually presents. Doing this first makes the service's own
# LoadOrGenerate call a guaranteed no-op load of what's already on disk.
FINGERPRINT=$("$BIN_PATH" -fingerprint -data-dir "$DATA_DIR")

cp "$(dirname "$0")/tunnel-agent.service" "$SERVICE_FILE" 2>/dev/null || cat > "$SERVICE_FILE" <<'EOF'
[Unit]
Description=Tunnel Panel Agent
After=network.target

[Service]
Type=simple
User=root
ExecStart=/usr/local/bin/tunnel-agent -listen :8443 -data-dir /etc/tunnel-agent -script /opt/tunnel-manager/tunnel-manager.sh
Restart=always
RestartSec=3
LimitNOFILE=1048576
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable tunnel-agent.service
# `enable --now` is a no-op on an already-running service -- on a version
# update, the already-running process would keep serving the old binary
# indefinitely even after it's been replaced on disk above. `restart` is
# what actually makes an update take effect.
systemctl restart tunnel-agent.service

# Open the agent's port if ufw is managing this host's firewall -- otherwise
# it defaults to deny-incoming and the panel can never reach the agent it
# just installed. Same pattern tunnel-manager's own cores use per-tunnel
# (see core/backhaul/core.sh's `ufw allow`).
if command -v ufw &> /dev/null && ufw status | grep -q "Status: active"; then
ufw allow 8443/tcp > /dev/null 2>&1
fi

echo ""
echo "tunnel-agent ${tag} installed and running on port 8443."
echo "Fingerprint for verifying this server when you register it in the panel:"
echo "$FINGERPRINT"

# Machine-readable summary for automated callers (e.g. the panel's SSH-based
# provisioning flow) to grep out of the full human-readable output above --
# a single sentinel-prefixed line rather than a --json mode, so this stays
# purely additive and every existing line above is untouched. token is only
# non-empty on a fresh install (see the GENERATED_TOKEN comment above); a
# caller provisioning a brand-new server should always see it populated.
echo "TUNNEL_AGENT_INSTALL_RESULT: {\"tag\":\"${tag}\",\"fingerprint\":\"${FINGERPRINT}\",\"token\":\"${GENERATED_TOKEN}\"}"
