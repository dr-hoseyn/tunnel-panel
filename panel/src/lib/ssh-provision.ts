import { NodeSSH } from "node-ssh";

/**
 * Provisions a fresh VPS over SSH: checks tunnel-manager.sh is already
 * installed there (this deliberately does NOT try to auto-install it --
 * tunnel-manager's own install.sh ends by exec-ing into its interactive
 * menu, which would hang forever with no TTY attached; see agent/README.md
 * and the commit history for why this boundary is intentional, not an
 * oversight), then runs the existing agent/install.sh remotely and parses
 * its machine-readable result line. SSH credentials passed in here are used
 * once for this connection and never persisted anywhere.
 */

const AGENT_INSTALL_URL =
  "https://raw.githubusercontent.com/dr-hoseyn/tunnel-panel/main/agent/install.sh";
const TUNNEL_MANAGER_INSTALL_CMD =
  "bash <(curl -fsSL https://raw.githubusercontent.com/dr-hoseyn/tunnel-manager/main/install.sh)";
const RESULT_PREFIX = "TUNNEL_AGENT_INSTALL_RESULT: ";

export class ProvisionError extends Error {
  constructor(
    message: string,
    /** Machine-readable marker for cases the UI needs to react to
     * specifically, e.g. offering a "reset & retry" action -- string
     * matching on `message` would be fragile. */
    public code?: "agent-already-installed",
  ) {
    super(message);
    this.name = "ProvisionError";
  }
}

export interface SshCredentials {
  host: string;
  sshPort: number;
  username: string;
  password?: string;
  privateKey?: string;
  /** If a previous agent install's token can't be recovered (see the
   * "agent-already-installed" case below), the caller can set this to have
   * us wipe that stored token hash ourselves over the same SSH connection
   * and re-provision -- the operator doesn't need to SSH in by hand. This
   * only invalidates that server's bearer token (the panel or anything
   * else that had it stops working); it does not touch the agent's TLS
   * cert/fingerprint or tunnel-manager itself. */
  resetExisting?: boolean;
}

export interface ProvisionResult {
  tag: string;
  fingerprint: string;
  token: string;
}

export async function provisionAgentViaSsh(creds: SshCredentials): Promise<ProvisionResult> {
  const ssh = new NodeSSH();
  try {
    try {
      await withTimeout(
        ssh.connect({
          host: creds.host,
          port: creds.sshPort,
          username: creds.username,
          password: creds.password,
          privateKey: creds.privateKey,
          readyTimeout: 15_000,
        }),
        20_000,
        "SSH connection timed out",
      );
    } catch (err) {
      if (err instanceof ProvisionError) throw err;
      throw new ProvisionError(
        `Could not connect over SSH: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const precheck = await withTimeout(
      ssh.execCommand(
        "test -f /opt/tunnel-manager/tunnel-manager.sh && echo EXISTS || echo MISSING",
      ),
      15_000,
      "Checking for tunnel-manager.sh timed out",
    );
    if (precheck.stdout.trim() !== "EXISTS") {
      throw new ProvisionError(
        "tunnel-manager.sh is not installed on this server yet. Install it first over SSH " +
          `yourself, then try again: ${TUNNEL_MANAGER_INSTALL_CMD}`,
      );
    }

    if (creds.resetExisting) {
      // User-confirmed action (surfaced as an explicit "Reset & retry"
      // button after a first attempt fails with "agent-already-installed"
      // below) -- only rotates this one server's bearer token over the
      // SSH connection already established for this same request. Does
      // not touch the agent's TLS cert/fingerprint or tunnel-manager.
      await withTimeout(
        ssh.execCommand("rm -f /etc/tunnel-agent/token.hash"),
        15_000,
        "Resetting the existing agent token timed out",
      );
    }

    const result = await withTimeout(
      ssh.execCommand(`bash <(curl -fsSL ${AGENT_INSTALL_URL})`),
      180_000,
      "Agent install timed out after 3 minutes",
    );

    if (result.code !== 0) {
      throw new ProvisionError(
        `Agent install failed (exit code ${result.code}): ${(result.stderr || result.stdout).slice(-2000)}`,
      );
    }

    const resultLine = result.stdout.split("\n").find((line) => line.startsWith(RESULT_PREFIX));
    if (!resultLine) {
      throw new ProvisionError(
        "Agent install finished but didn't report a result. Full output: " +
          result.stdout.slice(-2000),
      );
    }

    let parsed: ProvisionResult;
    try {
      parsed = JSON.parse(resultLine.slice(RESULT_PREFIX.length)) as ProvisionResult;
    } catch {
      throw new ProvisionError(`Could not parse the agent install result: ${resultLine}`);
    }

    if (!parsed.token) {
      throw new ProvisionError(
        "This server already had an agent installed. Its original token can't be retrieved " +
          "(it's only ever shown once, at install time) -- reset it to get a new one, or use " +
          "the manual registration form if you still have that server's existing " +
          "token/fingerprint.",
        "agent-already-installed",
      );
    }

    return parsed;
  } finally {
    ssh.dispose();
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new ProvisionError(message)), ms);
    }),
  ]);
}
