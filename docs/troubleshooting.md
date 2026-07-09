# Troubleshooting

## "Could not connect to the agent" when registering a server

The panel couldn't reach `https://<host>:<agentPort>/api/v1/health`. Check the agent is running (`systemctl status tunnel-agent` on that box), the port isn't firewalled from wherever the panel runs, and the host/port you typed match what the agent's install output printed.

## "The certificate the agent is presenting does not match the fingerprint given"

Either the fingerprint was mistyped, or the agent's certificate was regenerated since you copied it (e.g. its data directory was wiped and it was re-initialized). Re-run `tunnel-agent -fingerprint -data-dir /etc/tunnel-agent` on that box and use the fresh value.

## "This server already had an agent installed" during SSH auto-provisioning

The agent's token is only ever shown once, at install time, and isn't recoverable from disk (only its hash is stored). Use the **"Reset token & retry"** button — it wipes just the stored token hash over the same SSH connection and re-provisions, without touching the agent's TLS cert or tunnel-manager itself.

## Tunnel creation fails at "installing core"

The agent couldn't download or sanity-check the core binary. Common causes:
- No outbound internet access from that VPS to the core's release host (GitHub for Rathole/GOST/Hysteria2; `en.backhaul-dev.com`/`ir.backhaul-dev.com` for Backhaul).
- Unsupported CPU architecture (only `amd64`/`arm64` are supported per core).
- A previously-downloaded binary that's corrupt or for the wrong OS — the agent's own sanity check (running the binary with `--version`/`--help`) catches this and refuses to proceed rather than silently deploying a broken binary; it will attempt a fresh download on the next try since the sanity check also gates whether the cached copy is considered "already installed".

Whatever step fails, everything applied on that agent up to that point is rolled back automatically before the error is reported — you won't be left with a half-configured tunnel on that side. If the fully-deployed side then fails to establish contact with the second side, that side is torn down too and the tunnel record is removed.

## A tunnel shows Warning or Failed

See [managing-tunnels.md](managing-tunnels.md)'s status table. Check **Logs** on the tunnel's detail page first — it tails both sides live. A single Warning after a network blip is normal and usually self-clears; Failed means the platform already tried restarting it once and it didn't recover.

## GOST tunnels affecting each other

Expected, not a bug — every GOST tunnel on one agent shares a single daemon process (see [creating-tunnels.md](creating-tunnels.md)'s core comparison table). Restarting or stopping one briefly affects all of them on that server.

## I can't tell if a server is online on the Dashboard

"Online" there is based on `lastSeenAt`, which updates automatically whenever a health check successfully reaches that server's agent through one of its tunnels — a server with zero tunnels won't get this signal automatically. Use **Test connection** on its detail page to update it manually.
