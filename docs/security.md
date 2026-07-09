# Security

## Authentication & roles

The panel uses email/password login (NextAuth, credentials provider, sessions as signed JWTs) with three roles:

| Role | Can |
|---|---|
| **Viewer** | See everything — dashboard, servers, tunnels, logs, topology. No mutating actions. |
| **Operator** | Everything Viewer can, plus create/start/stop/restart/delete tunnels, edit/remove servers, create backups/restores. |
| **Admin** | Everything Operator can, plus manage users, rotate agent tokens, restart agents. |

There's no self-registration — the first admin is created by the seed script at install time; additional users are created from **Users** (admin-only). Every mutating API route checks its minimum role server-side (`src/lib/rbac.ts`) — the UI hiding a button is a convenience, not the actual enforcement boundary.

Every login, role change, user creation/removal, password change, and token rotation writes an **Audit**-category event, visible on the Logs page.

## Agent communication

- Every agent has its own self-signed TLS certificate (ECDSA P-256). There's no shared CA between independently-run VPS boxes, so trust is **pinned**, not chain-validated: the panel compares the live certificate's SHA-256 fingerprint against the one captured at registration time, on *every* request, not just the first.
- Every request carries a bearer token, verified in constant time on the agent side.
- **Token rotation**: an admin can invalidate and reissue an agent's token from its detail page. The new token takes effect immediately — the panel must persist it before anyone re-reads the old one, since the old one stops working the instant the agent responds.
- The agent's own HTTP surface is intentionally narrow and schema-validated, not a generic "run this command" endpoint: every field of a tunnel-create request (port numbers, tunnel id, peer address) is validated against a strict allowlist before it's ever written to disk or passed to a subprocess, and every subprocess call uses an argv array — nothing ever passes through a shell string.

## Secrets at rest

Agent bearer tokens and tunnel shared secrets are encrypted at rest (AES-256-GCM) in the panel's database, keyed by `AGENT_TOKEN_ENC_KEY` (see [installation.md](installation.md)). This closes a gap earlier phases of this project explicitly flagged as a known limitation.

Encrypted secrets are never returned by any API response — routes that need to *use* a secret (e.g. proxying a request to an agent) decrypt it server-side and never echo it back.

## What's still out of scope

- The panel itself has no TLS of its own — put it behind a reverse proxy (the install script can set up Caddy for you with `--domain`) or reach it over an SSH tunnel, same as phase 1.
- No 2FA.
- No per-tunnel or per-server permission scoping — roles are global (an Operator can act on every server/tunnel, not a restricted subset).
- No rate limiting on the login endpoint.
