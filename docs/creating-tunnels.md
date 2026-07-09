# Creating your first tunnel

**Tunnels → Create tunnel** opens a four-step wizard. No SSH, no config files — the panel drives both agents directly.

## 1. Servers

Name the tunnel, pick a **source** and **destination** server. These play fixed roles per the underlying tunnel core (matching the convention the wider Backhaul/Rathole/etc. ecosystem already uses): the source is the protocol's "server" side (it binds a port), the destination is the "client" side (it dials the source). Which side ends up holding the *forwarded-port* configuration varies by core — see the per-core notes below — but source/destination themselves always map the same way.

## 2. Core

Pick the tunnel engine:

| Core | Shape | Forwarded ports configured on |
|---|---|---|
| **Backhaul** | One systemd service per tunnel, multiplexed. Good general-purpose default. | Source |
| **Rathole** | One systemd service per tunnel, plain TCP. Lightweight. | Source |
| **GOST** | *All* GOST tunnels on a given agent share one daemon + config file; each tunnel is a fragment, not its own service. | Both sides (server side is the terminal hop; client side dials in through a chain) |
| **Hysteria2** | One systemd service per tunnel, QUIC/UDP. DPI/throttling-resistant. | Destination |

## 3. Configure

- **Bind port** — where the source side listens.
- Core-specific fields (e.g. Backhaul/GOST transport type, Hysteria2 obfuscation password/SNI) — only the fields that core actually supports are shown.
- **Forwarded ports** (optional) — remote/local port pairs if you need more than the single bind port forwarded.

## 4. Deploy

Clicking Deploy immediately:

1. Generates a random shared secret for this tunnel.
2. Calls the **source** agent's `POST /api/v1/managed-tunnels`: installs the core binary if not already cached, writes its config, creates a systemd service, opens the firewall port, starts it.
3. Does the same on the **destination** agent, pointed at the source's public address.
4. If the destination fails, the source side is automatically torn down and the tunnel record is deleted — you never end up with a half-deployed tunnel. If it succeeds, both sides are up and the tunnel shows **Running**.

Progress streams live (step by step, over Server-Sent Events) rather than as a spinner — you can see exactly which step is running and, if something fails, exactly which one and why.

## What actually gets created

Every panel-created tunnel lives in its own namespace on each agent — config under the agent's own data directory, systemd units prefixed `tunnel-agent-<id>.service` — specifically so it can never collide with, or be confused with, anything a `tunnel-manager.sh` interactive session on the same box has configured. Those stay visible read-only in the server's tunnel list; panel-created tunnels are the ones you can actually manage from here.
