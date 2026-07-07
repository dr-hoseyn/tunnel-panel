# tunnel-panel (web)

Centralized dashboard for [tunnel-panel](../README.md)'s [Agent](../agent/README.md) fleet. Next.js (App Router), Prisma + SQLite, NextAuth v5.

## What's actually implemented (phase 1)

- Single-admin login (email/password, seeded via a script — no self-registration).
- Register a server: paste its host, agent port, bearer token, and TLS fingerprint (all printed by the agent's install script). The panel connects, verifies the live cert matches the fingerprint you gave it (trust-on-first-use), confirms the token actually works, and only then saves it — a bad fingerprint or token is rejected before anything is persisted.
- Dashboard: live CPU/RAM/network per registered server, polling every 5s.
- Server detail page: same metrics plus the full tunnel list (engine/name/role/active) and GOST status, proxied live from that server's agent.
- Every request to a registered server's agent is certificate-pinned against the fingerprint captured at registration — not just on first connect.

## What's deliberately NOT implemented yet

Multi-server bulk actions, RBAC/multiple users, WebSocket live updates (currently polling), tunnel creation/editing from the UI (read-only for phase 1), audit log, notifications. See the [root README](../README.md)'s security note on why command-execution isn't exposed yet either.

**Known gap:** the agent bearer token is stored in cleartext in the SQLite DB (`Server.agentToken`) — acceptable for phase 1's single-admin scope, but needs encryption-at-rest before this handles multiple untrusted operators sharing one panel instance.

## Setup

```bash
npm install
cp .env.example .env   # then edit AUTH_SECRET -- see the comment in that file
npx prisma migrate deploy
SEED_ADMIN_EMAIL=admin@example.com SEED_ADMIN_PASSWORD=change-me npm run db:seed
npm run build
npm run start
```

For local development: `npm run dev` instead of build+start, and `npx prisma migrate dev` instead of `migrate deploy` if you're changing `prisma/schema.prisma`.

## Registering a server

1. Install the agent on the VPS (see [agent/README.md](../agent/README.md)) — its install script prints a bearer token and, at the end, a TLS fingerprint.
2. In the panel, "+ Add server" and paste the host, agent port (default 8443), token, and fingerprint.
3. The panel verifies both before saving — if either is wrong, registration is rejected with a specific error, nothing is persisted.

## Architecture notes

- **Prisma 7** requires an explicit driver adapter now (no more bare connection-string mode) — `@prisma/adapter-better-sqlite3`, wired in `src/lib/db.ts`.
- **`src/proxy.ts`**, not `middleware.ts` — Next.js 16 renamed the file convention. It builds its own lightweight NextAuth instance from `src/auth.config.ts` (no providers, no Prisma) specifically so the Edge runtime this proxy runs on never has to load Prisma's native SQLite binding. The full auth config with the Credentials provider (`src/auth.ts`) is only ever used from Node-runtime code (API routes, Server Components).
- **`src/lib/agent-client.ts`** talks to agents with `rejectUnauthorized: false` + a custom `checkServerIdentity` — this is certificate *pinning* (compare against a known-good fingerprint), not "skip verification". Connections are made with `agent: false` (no keep-alive pooling) deliberately: a pooled/reused socket doesn't reliably expose the current handshake's peer certificate the way a fresh one does, which caused real intermittent "could not read certificate" failures during testing before this was added.

## Development

```bash
npm run build   # full production build + typecheck
npm run lint
```

Verified end-to-end during development against a real running agent binary: real login, real fingerprint-pinned registration (including the negative cases — wrong fingerprint, wrong token, both correctly rejected before any DB write), real metrics/tunnels proxying, repeated polling.
