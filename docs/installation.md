# Installation

tunnel-panel has two pieces: the **panel** (one Next.js app, wherever you want your dashboard to live) and the **agent** (one small Go binary per VPS you want to manage).

## 1. Install the panel

On whichever server should host the dashboard:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/dr-hoseyn/tunnel-panel/main/panel/install.sh)
```

This installs Node.js if missing, clones the repo to `/opt/tunnel-panel`, builds it, generates an admin account (random password, printed once), and runs it as `tunnel-panel.service`.

By default it binds to `127.0.0.1:3000` only — the install script prints an SSH tunnel command to reach it. For direct access with a real TLS certificate, point a domain at the server first and re-run with `--domain panel.example.com`; this installs [Caddy](https://caddyserver.com) as a reverse proxy with automatic Let's Encrypt.

Re-running the script later pulls and rebuilds in place without touching the existing admin account.

### Required environment

Two secrets live in `panel/.env` (the install script generates both):

- `AUTH_SECRET` — NextAuth session signing key.
- `AGENT_TOKEN_ENC_KEY` — encrypts every agent bearer token and tunnel shared secret at rest (AES-256-GCM). Losing this key means losing the ability to decrypt stored credentials — back it up alongside your database.

## 2. Install the agent on each VPS

The agent is what lets the panel manage a server with **no SSH required** for day-to-day operation. It needs to be installed once, over SSH or manually — after that, everything goes through the agent's authenticated HTTPS API.

**Recommended: let the panel do it.** From the panel's "+ Add server" flow, choose "Automatic (SSH)", give it SSH credentials (used once, never stored), and it installs and registers the agent for you. This is the "Adding your first server" flow — see [adding-servers.md](adding-servers.md).

**Manual alternative**, if you'd rather not give the panel SSH access:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/dr-hoseyn/tunnel-panel/main/agent/install.sh)
```

This installs the `tunnel-agent` binary, generates a bearer token (shown once — save it), sets up `tunnel-agent.service`, opens its port in `ufw` if present, and prints a TLS fingerprint. Paste the host, port, token, and fingerprint into the panel's manual registration form.

The agent needs no pre-existing `tunnel-manager.sh` install to create/manage tunnels through the panel — it downloads and manages Backhaul/Rathole/GOST/Hysteria2 binaries itself, in its own directory, independent of anything else on the box.

## Local development

```bash
# panel
cd panel
npm install
cp .env.example .env   # edit AUTH_SECRET and AGENT_TOKEN_ENC_KEY, see comments in that file
npx prisma migrate deploy
SEED_ADMIN_EMAIL=admin@example.com SEED_ADMIN_PASSWORD=change-me npm run db:seed
npm run dev

# agent
cd agent
go build ./...
go test ./...
```
