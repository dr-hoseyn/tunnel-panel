# tunnel-agent

Lightweight Go agent that runs on each VPS managed by the [tunnel-panel](../README.md) web dashboard. Two roles:

1. A thin, authenticated HTTPS wrapper around [tunnel-manager.sh](https://github.com/dr-hoseyn/tunnel-manager)'s non-interactive `--metrics-json` / `--list-json` modes, where that's already installed on the box (read-only — this agent never modifies anything `tunnel-manager.sh` itself manages).
2. A **native tunnel-lifecycle engine** (`internal/tunnels`) for panel-created tunnels: installs Backhaul/Rathole/GOST/Hysteria2 binaries itself, generates their config, creates systemd services, opens firewall ports, and health-checks them — no `tunnel-manager.sh` involvement at all for these. Panel-created tunnels live in their own namespace (`tunnel-agent-<id>.service`, own config directory) specifically so they can never collide with anything `tunnel-manager.sh` has configured on the same box.

## What's implemented

- HTTPS server with a self-signed TLS cert (generated on first run, ECDSA P-256, 365-day validity).
- Bearer-token authentication: one shared token per agent, generated via `-init` or rotated via the API below, stored hashed (SHA-256) on disk, verified in constant time. The raw token is shown exactly once and never written to disk.
- `GET /api/v1/health` — no auth, liveness check.
- `GET /api/v1/metrics` — auth required, proxies `tunnel-manager.sh --metrics-json` verbatim.
- `GET /api/v1/tunnels` — auth required, proxies `tunnel-manager.sh --list-json` verbatim (read-only, tunnel-manager's own tunnels).
- `GET /api/v1/agent/info` — auth required, build-time version/commit/date + OS/arch + which tunnel core drivers this binary supports.
- `POST /api/v1/token/rotate` — auth required (with the current token), atomically replaces the stored token hash.
- `POST /api/v1/agent/restart` — auth required, responds first then restarts its own systemd unit from a short-delayed goroutine.
- `POST /api/v1/managed-tunnels` / `POST .../{id}/{start,stop,restart}` / `DELETE .../{id}` / `GET .../{id}/health` / `GET .../{id}/logs` — auth required, the native tunnel-lifecycle engine described above. See `internal/tunnels/driver.go` for the per-core plugin interface (`Driver`) and `internal/server/tunnel_handlers.go` for the HTTP layer, which never branches on core name itself.

## Security posture

Still no generic "run this command" endpoint — every mutating endpoint above is a small, fixed, schema-validated action. Every field of a create-tunnel request (tunnel id, ports, peer address) is validated against a strict allowlist (`internal/tunnels/validate.go`) before it's used for anything; every subprocess call anywhere in this codebase uses an `exec.Command` argv slice, never a shell string; systemd unit names are always derived from an agent-validated tunnel id, never raw request input. A per-tunnel mutex (`internal/tunnels/locks.go`) serializes operations on the same tunnel while leaving different tunnels fully concurrent.

## Install

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/dr-hoseyn/tunnel-panel/main/agent/install.sh)
```

[tunnel-manager](https://github.com/dr-hoseyn/tunnel-manager) at `/opt/tunnel-manager` is optional now — only needed if you also want this agent's read-only `/api/v1/metrics` and `/api/v1/tunnels` endpoints to reflect a `tunnel-manager.sh` install already on the box. Panel-created tunnels (`/api/v1/managed-tunnels/...`) work with no `tunnel-manager.sh` install at all.

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

All internal packages (`authtoken`, `tlscert`, `tunnelscript`, `server`, `tunnels`, `version`) are covered by real unit tests:
- `server`'s tests exercise the full HTTP layer (auth accept/reject, routing, error handling, the whole create/start/stop/restart/health/logs/delete tunnel lifecycle, token rotation) against a fake `CommandRunner` and a fake tunnel `Driver` registered under a test-only core name — no real `tunnel-manager.sh`, systemd, network, or root environment required.
- `tunnels`' tests cover the validators, the driver registry, per-tunnel locking (real concurrency behavior, not just a type check), the metadata store, and each real core driver's config-generation output (Backhaul/Rathole/Hysteria2/GOST) byte-for-byte against what the config should contain -- the parts of each driver that don't require systemd/network are the parts most likely to regress silently, so they're pinned down here even though `Install`/`Start`/etc. aren't (those need a real Linux box).

Also verified during development against a real compiled agent binary on a non-Linux dev machine: real TLS+auth end to end through the panel (registration, metrics proxy, `agent/info`), and a real `POST /api/v1/managed-tunnels` request that downloads and correctly rejects a binary that can't execute in that environment, leaving no orphaned tunnel metadata behind -- exercising the actual install → sanity-check → clean-failure path, not just its mocked equivalent.
