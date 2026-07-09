# Managing tunnels

## Actions

From a tunnel's detail page:

- **Start / Stop / Restart** — applies to both sides. For GOST specifically, this affects the *shared* daemon on each agent, so restarting one GOST tunnel briefly affects every other GOST tunnel on that same server — the Health tab's detail text says so explicitly when this applies to you.
- **View logs** — a live tail (Server-Sent Events, polling both agents every ~1.5s and pushing only new lines) from both sides at once, each line labeled with which server it came from.
- **Backup** — snapshots the tunnel's current config + secret into the database.
- **Delete** — removes the tunnel from both agents (config, service, firewall rule) and then the panel's own record. If one side is already unreachable, the other side and the panel record are still cleaned up — it won't get stuck because one agent went away.

## Status meaning

| Status | Meaning |
|---|---|
| 🟦 Deploying | Initial create in progress. |
| 🟢 Running | Both agents report the process active and (where applicable) the port accepting connections. |
| 🟡 Warning | First failed health check — not yet acted on. |
| 🔴 Failed | Failed health checks even after one automatic restart attempt (see below) — needs a manual look. |
| ⚪ Stopped | Manually stopped. |

## Real health checks, not just "is the unit active"

A background job on the panel checks every tunnel roughly every 15 seconds, hitting each agent's `GET /api/v1/managed-tunnels/{id}/health`. That endpoint reports:

- **Process state** (systemd) — is it actually running.
- **Port reachability** — a real connection attempt (or, for Hysteria2's UDP, a bind check), not just systemd's own idea of "active".
- **Traffic activity** — real byte counters via systemd's `IPAccounting`, not a synthetic heartbeat.

On two consecutive failures, the panel makes **exactly one** automatic restart attempt (the same action a manual Restart click triggers) and logs why. If it's still failing after that, the tunnel is flagged Failed and left alone — it will not keep retrying forever.

## Backups

**Backups** (top-level nav) lists every snapshot across every tunnel. Restoring deploys a **new** tunnel from that snapshot's config rather than overwriting the original in place — the agent doesn't yet have an "update config on an existing tunnel" endpoint, only create/delete, so an in-place restore would mean a destructive delete-then-recreate if the redeploy failed partway. Spinning up a fresh tunnel from the snapshot is the safe operation available today.

## Updating a core binary

Not implemented yet. The agent's install step is idempotent (it won't re-download a binary that's already present and passes its sanity check) but there's no "force re-download to the latest version" action from the UI today — see the **Cores** page for each server's currently-reported agent version in the meantime.
