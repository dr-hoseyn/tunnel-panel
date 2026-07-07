# tunnel-agent

Lightweight Go agent that runs on each VPS managed by the [tunnel-panel](../README.md) web dashboard. It does not reimplement tunnel logic — it's a thin, authenticated HTTPS wrapper around [tunnel-manager.sh](https://github.com/dr-hoseyn/tunnel-manager)'s non-interactive `--metrics-json` / `--list-json` modes, running locally on the same machine.

## What's actually implemented (phase 1)

- HTTPS server with a self-signed TLS cert (generated on first run, ECDSA P-256, 365-day validity — same profile the bash cores already use).
- Bearer-token authentication: one shared token per agent, generated once via `-init`, stored hashed (SHA-256) on disk, verified in constant time. The raw token is shown exactly once and never written to disk.
- `GET /api/v1/health` — no auth, liveness check.
- `GET /api/v1/metrics` — auth required, proxies `tunnel-manager.sh --metrics-json` verbatim.
- `GET /api/v1/tunnels` — auth required, proxies `tunnel-manager.sh --list-json` verbatim.

## What's deliberately NOT implemented yet

No generic "run this command" endpoint. An agent capable of executing arbitrary remote commands is the highest-value attack target in the whole system — it needs a properly designed command allowlist and audit trail before it ships, not a rushed one. Install/config-generation/service-restart endpoints are a later phase.

## Install

Requires [tunnel-manager](https://github.com/dr-hoseyn/tunnel-manager) already installed on this VPS at `/opt/tunnel-manager`.

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/dr-hoseyn/tunnel-panel/main/agent/install.sh)
```

This downloads the prebuilt binary for your architecture from the latest GitHub release, installs it to `/usr/local/bin/tunnel-agent`, generates a bearer token (shown once — save it), sets up `tunnel-agent.service`, and prints the agent's TLS fingerprint to verify when registering it in the panel.

## Manual usage

```bash
# Generate a token (do this once, before starting the service)
tunnel-agent -init -data-dir /etc/tunnel-agent

# Print the TLS cert fingerprint (generates the cert first if it doesn't exist yet)
tunnel-agent -fingerprint -data-dir /etc/tunnel-agent

# Run the server
tunnel-agent -listen :8443 -data-dir /etc/tunnel-agent -script /opt/tunnel-manager/tunnel-manager.sh
```

## Development

```bash
go build ./...
go vet ./...
gofmt -l .
go test ./... -v
```

All internal packages (`authtoken`, `tlscert`, `tunnelscript`, `server`) are covered by real unit tests — `server`'s tests exercise the full HTTP layer (auth accept/reject, routing, error handling) against a fake `CommandRunner`, no real `tunnel-manager.sh` or root environment required.
