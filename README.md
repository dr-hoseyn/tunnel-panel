# Tunnel Panel

Centralized web management platform for Backhaul, Rathole, GOST, and Hysteria2 tunnels across multiple VPS servers — create, monitor, and troubleshoot tunnels between any two registered servers from one dashboard, with **no SSH required** for day-to-day operation.

`tunnel-manager` ([github.com/dr-hoseyn/tunnel-manager](https://github.com/dr-hoseyn/tunnel-manager)) is a separate, related project: a standalone interactive CLI panel that runs on a single server. This repo doesn't depend on it or modify it — the Agent here has its own native tunnel-lifecycle engine (install binaries, generate config, create systemd services, configure firewalls, health-check) so a `tunnel-manager.sh` install is never required on a server this panel manages. Where one *is* present, its existing tunnels are still shown read-only, kept in a completely separate namespace from anything the panel creates so the two can never collide.

## Architecture

```
Browser
  |
  v
Web Panel (Next.js + Prisma/SQLite)  <-- this repo: panel/
  |  HTTPS + bearer token (cert-pinned), one connection per registered server
  v
Agent (Go, one static binary per VPS)  <-- this repo: agent/
  |  installs/configures/runs tunnel cores natively -- no shelling out to a third-party script
  v
Backhaul / Rathole / GOST / Hysteria2 (downloaded and managed by the Agent itself)
```

A background job on the panel (`panel/src/instrumentation.ts`) continuously health-checks every tunnel through its agents and drives real status transitions, independent of anyone having the dashboard open.

## Status

Servers, tunnels (create/start/stop/restart/delete/backup/restore across Backhaul, Rathole, GOST, Hysteria2), real health monitoring, a network topology view, central audit/deployment/runtime logging, and role-based access (Admin/Operator/Viewer) are all implemented — see `agent/README.md` and `panel/README.md` for the endpoint-level detail, and [docs/](docs/) for user-facing guides (installation, adding a server, creating a tunnel, managing tunnels, troubleshooting, security).

Not yet implemented: forcing a core binary to update to a newer version once installed, in-place tunnel config edits (today: delete and recreate, or restore a backup as a new tunnel), and per-tunnel/per-server permission scoping (roles are global).

## Quick install

On whichever server hosts the dashboard itself:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/dr-hoseyn/tunnel-panel/main/panel/install.sh)
```

Then add a server from the panel's UI — it can install the agent on a fresh VPS for you over SSH (used once, never stored), so you don't need to run the agent's own install script by hand. See [docs/installation.md](docs/installation.md) and [docs/adding-servers.md](docs/adding-servers.md) for both paths.

## Layout

- `agent/` — Go agent that runs on each VPS: authenticated HTTPS API, native tunnel-lifecycle engine (`agent/internal/tunnels`) for Backhaul/Rathole/GOST/Hysteria2.
- `panel/` — Next.js web panel (the central dashboard): tunnel orchestration/deployment queue, RBAC, real-time health monitoring, UI.
- `docs/` — user-facing guides: installation, adding servers, creating/managing tunnels, troubleshooting, security.

## Security note

The Agent does not expose a generic "run this command" endpoint. Every mutating endpoint is a small, fixed, schema-validated action (create/start/stop/restart/delete a tunnel, rotate its own token, restart itself) — every field is validated against a strict allowlist before it's used, and every subprocess call uses an argv array, never a shell string. See [docs/security.md](docs/security.md) for the full picture (roles, audit logging, secret encryption at rest, certificate pinning).
