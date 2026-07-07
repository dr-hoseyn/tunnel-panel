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

if [[ ! -f "${DATA_DIR}/token.hash" ]]; then
echo ""
"$BIN_PATH" -init -data-dir "$DATA_DIR"
echo ""
echo "^ Copy that token now -- it will not be shown again. It's what you'll"
echo "  enter in the panel when registering this server."
else
echo "Existing token found at ${DATA_DIR}/token.hash -- leaving it as is."
fi

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
systemctl enable --now tunnel-agent.service

echo ""
echo "tunnel-agent ${tag} installed and running on port 8443."
echo "Fingerprint for verifying this server when you register it in the panel:"
"$BIN_PATH" -fingerprint -data-dir "$DATA_DIR"
