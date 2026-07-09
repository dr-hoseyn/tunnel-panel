# Adding your first server

You need at least two registered servers before you can create a tunnel — a tunnel always connects two of them.

From **Servers → + Add server** you get two ways in:

## Automatic (SSH) — recommended

Give it the host, SSH port/username, and a password or private key. The panel connects once, installs the agent (and `tunnel-manager.sh` first if it isn't already present and you opt in), registers it, and never touches SSH again after that — everything from here on goes through the agent's own authenticated HTTPS API.

Credentials are used for that single connection and are never persisted anywhere.

If the agent's already installed on that box (e.g. you're re-adding it after removing it from the panel), you'll see an **"agent already installed"** error — its original token can't be recovered since it's only ever shown once at install time. Use **"Reset token & retry"** to have the panel wipe and regenerate it over the same SSH connection, or fall back to manual registration if you still have the original token/fingerprint.

## Manual

If you'd rather install the agent yourself (see [installation.md](installation.md)), paste in what its install script printed: host, agent port (default `8443`), bearer token, and TLS fingerprint.

Either way, the panel:

1. Connects to the agent's `/api/v1/health` endpoint and reads its live TLS certificate.
2. Compares that certificate's fingerprint against the one you gave it — trust-on-first-use, not CA validation (agents are self-signed, there's no shared CA between independently-run VPS boxes).
3. Confirms the bearer token actually works.
4. Only then writes the server to its database, with the token encrypted at rest.

A wrong fingerprint or token is rejected before anything is persisted — there's no partial/broken registration state.

## After registering

The server's card shows live CPU/RAM/network (polled from the agent every 5s), its OS/arch/agent version (populate these with the **Test connection** button on its detail page), and how many tunnels currently use it. From its detail page you can also **Restart agent** and **Rotate token** (admin-only — these restart the agent process / invalidate and reissue its bearer token).
