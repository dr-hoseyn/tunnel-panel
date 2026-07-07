# Tunnel Panel

Centralized web management platform for [tunnel-manager](https://github.com/dr-hoseyn/tunnel-manager) — manage Backhaul, Rathole, GOST, Hysteria2, FRP, and TUIC tunnels across multiple VPS servers from one dashboard, with no manual SSH required.

This is a separate project/repo from `tunnel-manager` on purpose: `tunnel-manager` is the standalone CLI panel that runs on a single server and needs no dependencies beyond bash; this repo adds a centralized web layer on top of it for anyone managing more than one server.

## Architecture

```
Browser
  |
  v
Web Panel (Next.js + Prisma/SQLite)  <-- this repo: panel/
  |  HTTPS + bearer token, one connection per registered server
  v
Agent (Go, one static binary per VPS)  <-- this repo: agent/
  |  shells out locally, non-interactively
  v
tunnel-manager.sh --list-json / --metrics-json  <-- github.com/dr-hoseyn/tunnel-manager (untouched project, small new CLI flags added)
```

The Agent does not reimplement tunnel logic. It's a thin, authenticated HTTPS wrapper around the already-built, already-tested `tunnel-manager.sh` cores running locally on each VPS — the Agent's job is exposing that safely over the network, not duplicating it.

## Status

**Phase 1 (in progress):** one Agent, one registered server, login + live dashboard. No multi-server, no RBAC, no remote command execution yet — see `agent/README.md` and `panel/README.md` for what's actually implemented today versus the long-term plan.

## Quick install

On each VPS you want managed (needs [tunnel-manager](https://github.com/dr-hoseyn/tunnel-manager) already installed there):

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/dr-hoseyn/tunnel-panel/main/agent/install.sh)
```

On whichever server hosts the dashboard itself:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/dr-hoseyn/tunnel-panel/main/panel/install.sh)
```

Both print what you need for the next step (the agent prints a token + TLS fingerprint to paste into the panel; the panel prints its login and, by default, an SSH tunnel command since it binds to localhost only). See `agent/README.md` and `panel/README.md` for details and flags.

## Layout

- `agent/` — Go agent that runs on each VPS.
- `panel/` — Next.js web panel (the central dashboard).

## Security note

The Agent is intentionally scoped to a small, fixed set of read-only endpoints in phase 1 (health, metrics, tunnel listing) — no generic "run this command" endpoint exists yet. That's deliberate: an agent capable of executing arbitrary remote commands is the highest-value attack target in this whole system, and it needs a properly designed command allowlist/audit trail before it ships, not a rushed one.
