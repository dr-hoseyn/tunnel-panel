# tunnel-panel (web)

Centralized dashboard for [tunnel-panel](../README.md)'s [Agent](../agent/README.md) fleet. Next.js (App Router), Prisma + SQLite, NextAuth v5.

## What's implemented

- Login (email/password) with three roles — Admin/Operator/Viewer — enforced server-side on every mutating `/api/v1/...` route (`src/lib/rbac.ts`), not just hidden in the UI. Admins manage users from the Users page; there's no self-registration.
- Register a server manually (paste host/port/token/fingerprint) or let the panel provision it over SSH (installs the agent for you, credentials used once and never stored) — either way, the panel verifies the live cert matches the given fingerprint (trust-on-first-use) and that the token actually works before persisting anything.
- **Tunnels**: create/start/stop/restart/delete across Backhaul, Rathole, GOST, and Hysteria2, via a deployment queue (`src/lib/deploy-queue.ts`) that's per-tunnel-locked, retries transient agent failures, supports cancellation, and rolls back the source side automatically if the destination fails to deploy. Progress streams live over SSE (`/api/v1/deployments/[id]/stream`).
- **Real-time health monitoring**: a background job (`src/instrumentation.ts` → `src/lib/health-sampler.ts`) health-checks every tunnel every ~15s independent of the UI, records traffic samples, and makes one bounded automatic restart attempt on repeated failure before flagging a tunnel Failed.
- Dashboard, Servers (live CPU/RAM/network, agent version/OS, active tunnel count), Tunnel list/detail (overview/performance graph/live log tail), Topology (visual server/tunnel map), Logs (audit/deployment/runtime events, filterable), Cores, Backups (snapshot + restore-as-new-tunnel), Settings.
- Every registered server's agent connection is certificate-pinned on *every* request, not just at registration.
- Agent bearer tokens and tunnel shared secrets are encrypted at rest (AES-256-GCM, `src/lib/crypto.ts`) — closes what was previously a documented cleartext-storage gap.

## What's deliberately NOT implemented yet

Forcing a core binary to update once installed, in-place tunnel config edits (delete-and-recreate or restore-a-backup-as-new-tunnel instead), per-tunnel/per-server permission scoping (roles are global), 2FA, panel-native TLS (front it with a reverse proxy or SSH tunnel). See [docs/security.md](../docs/security.md) for the full list.

## Install on a server (production)

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/dr-hoseyn/tunnel-panel/main/panel/install.sh)
```

Installs Node.js if missing, clones this repo to `/opt/tunnel-panel`, builds, generates an admin account (random password, printed once — same pattern as the agent's bearer token), and runs it as `tunnel-panel.service`.

**Binds to `127.0.0.1:3000` by default, not the public interface.** The panel has no TLS of its own and holds every registered server's bearer token, so the safe default is reaching it over an SSH tunnel (the install script prints the exact command).

**For direct access with a real certificate**, point a domain's DNS at this server first, then:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/dr-hoseyn/tunnel-panel/main/panel/install.sh) --domain panel.example.com
```

This installs [Caddy](https://caddyserver.com) as a reverse proxy in front of the panel; Caddy obtains and auto-renews a real Let's Encrypt certificate for that domain with no further config. The panel itself still only binds to `127.0.0.1` — only Caddy is public. (Let's Encrypt can't issue a certificate for a bare IP, so this only works with a real domain already pointed here.)

`--public` binds the panel directly to `0.0.0.0` instead (plaintext HTTP) — only for when you're fronting this with your own separately-managed reverse proxy/TLS. Ignored if `--domain` is given.

Re-running the script later pulls and rebuilds in place; it won't overwrite an existing admin account or generate a new password.

## Manual / local development setup

```bash
npm install
cp .env.example .env   # then edit AUTH_SECRET and AGENT_TOKEN_ENC_KEY -- see the comments in that file
npx prisma migrate deploy
SEED_ADMIN_EMAIL=admin@example.com SEED_ADMIN_PASSWORD=change-me npm run db:seed
npm run build
npm run start
```

For local development: `npm run dev` instead of build+start, and `npx prisma migrate dev` instead of `migrate deploy` if you're changing `prisma/schema.prisma`.

## Registering a server and creating a tunnel

See [docs/adding-servers.md](../docs/adding-servers.md) and [docs/creating-tunnels.md](../docs/creating-tunnels.md) for the user-facing walkthrough.

## Architecture notes

- **Prisma 7** requires an explicit driver adapter now (no more bare connection-string mode) — `@prisma/adapter-better-sqlite3`, wired in `src/lib/db.ts`.
- **`src/proxy.ts`**, not `middleware.ts` — Next.js 16 renamed the file convention. It builds its own lightweight NextAuth instance from `src/auth.config.ts` (no providers, no Prisma) specifically so the Edge runtime this proxy runs on never has to load Prisma's native SQLite binding. The full auth config with the Credentials provider (`src/auth.ts`) is only ever used from Node-runtime code (API routes, Server Components). Fine-grained role checks (`src/lib/rbac.ts`) live in that same Node-only code, not in `proxy.ts` — the proxy only ever checks "is there a session at all".
- **`src/lib/agent-client.ts`** talks to agents with `rejectUnauthorized: false` + a custom `checkServerIdentity` — this is certificate *pinning* (compare against a known-good fingerprint), not "skip verification". Connections are made with `agent: false` (no keep-alive pooling) deliberately: a pooled/reused socket doesn't reliably expose the current handshake's peer certificate the way a fresh one does, which caused real intermittent "could not read certificate" failures during testing before this was added.
- **`src/lib/tunnel-orchestrator.ts`** and **`src/lib/deploy-queue.ts`** are core-agnostic — they read from **`src/lib/cores/registry.ts`** (per-core: agent driver name, which side gets forwarded-port config, wizard form fields) rather than branching on tunnel core. Adding a future core to the UI means adding one descriptor there, matching the same registry pattern the agent's own `internal/tunnels` package uses.
- **`src/instrumentation.ts`** → **`src/lib/health-sampler.ts`**: Next.js's instrumentation hook, gated to the Node runtime, starting a `setInterval`-based background health sampler once per process (guarded against Next dev-mode's hot-reload calling `register()` more than once).
- SSE routes (`/api/v1/deployments/[id]/stream`, `/api/v1/tunnels/[id]/stream`, `/api/v1/tunnels/[id]/logs/stream`) poll their underlying DB/agent state server-side and push only on change — a real persistent SSE connection to the browser either way, just not backed by a separate pub/sub layer.

## Development

```bash
npm run build   # full production build + typecheck
npm run lint
npm run test    # vitest -- crypto, agent-client, deploy-queue, orchestrator, rbac, health-sampler
```

Verified end-to-end during development against a real running agent binary: real login, real fingerprint-pinned registration (including the negative cases — wrong fingerprint, wrong token, both correctly rejected before any DB write), real metrics/tunnels proxying, real `agent/info`-backed Test connection, and a real tunnel-create request through to the agent's install step (fails cleanly and leaves no orphaned state when the downloaded binary can't run in the dev environment, as expected on a non-Linux dev machine).
