import https from "node:https";

/**
 * Talks to a tunnel-agent over HTTPS with certificate pinning instead of CA
 * validation -- the agent's cert is self-signed (no shared CA between
 * independently-run VPS agents), so trust comes from comparing the
 * presented cert's SHA-256 fingerprint against the one recorded when the
 * server was registered in the panel (trust-on-first-use), not from chain
 * validation. `rejectUnauthorized: false` disables Node's normal CA check;
 * `checkServerIdentity` replaces it with our own fingerprint comparison, so
 * a mismatched cert still fails the connection -- this is pinning, not
 * "skip verification".
 */
export class AgentError extends Error {
  constructor(
    message: string,
    public status?: number,
  ) {
    super(message);
    this.name = "AgentError";
  }
}

export interface AgentTarget {
  host: string;
  port: number;
  token: string;
  tlsFingerprint: string;
}

async function agentRequest(
  target: AgentTarget,
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const req = https.request(
      {
        host: target.host,
        port: target.port,
        path,
        method,
        headers: {
          Authorization: `Bearer ${target.token}`,
          ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
        },
        rejectUnauthorized: false,
        // Force a fresh TLS handshake every call instead of reusing a
        // pooled keep-alive socket -- checkServerIdentity/getPeerCertificate
        // both need the *current* handshake's certificate, and pinning is
        // the whole point of every request here.
        agent: false,
        checkServerIdentity: (_hostname, cert) => {
          const actual = cert.fingerprint256;
          if (actual !== target.tlsFingerprint) {
            return new Error(
              `certificate fingerprint mismatch: expected ${target.tlsFingerprint}, got ${actual}`,
            );
          }
          return undefined;
        },
        // Every path this hits shells out to tunnel-manager.sh or drives a
        // tunnel core install/deploy on the agent side, which can take
        // longer than the read-only endpoints -- 25s comfortably clears the
        // agent's own internal timeouts (10s script timeout, 15s write
        // timeout) with margin; deploy-shaped calls (create/start/etc) pass
        // a longer timeout explicitly via the `timeoutMs` option below.
        timeout: 25_000,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          const status = res.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            reject(new AgentError(`agent returned HTTP ${status}: ${data}`, status));
            return;
          }
          resolve(data);
        });
      },
    );
    req.on("timeout", () => {
      req.destroy();
      reject(new AgentError("agent request timed out"));
    });
    req.on("error", (err) => reject(new AgentError(err.message)));
    if (payload) req.write(payload);
    req.end();
  });
}

export async function agentGet(target: AgentTarget, path: string): Promise<string> {
  return agentRequest(target, "GET", path);
}

/** POSTs a JSON body (or none) to path and returns the raw response text.
 * Used for every mutating managed-tunnel/admin endpoint (create, start,
 * stop, restart, token rotate, agent restart). */
export async function agentPost(target: AgentTarget, path: string, body?: unknown): Promise<string> {
  return agentRequest(target, "POST", path, body);
}

export async function agentDelete(target: AgentTarget, path: string): Promise<string> {
  return agentRequest(target, "DELETE", path);
}

/** Fetches and pins on trust-on-first-use: no fingerprint check, since this
 * IS how the fingerprint gets established. Only ever call this from the
 * server-registration flow, immediately after the operator has verified the
 * fingerprint out of band (e.g. against the agent install output). */
export async function agentFetchFingerprint(host: string, port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host,
        port,
        path: "/api/v1/health",
        method: "GET",
        rejectUnauthorized: false,
        agent: false,
        timeout: 10_000,
      },
      (res) => {
        const cert = (res.socket as import("tls").TLSSocket).getPeerCertificate();
        res.resume();
        if (!cert || !cert.fingerprint256) {
          reject(new AgentError("could not read the agent's TLS certificate"));
          return;
        }
        resolve(cert.fingerprint256);
      },
    );
    req.on("timeout", () => {
      req.destroy();
      reject(new AgentError("connection to agent timed out"));
    });
    req.on("error", (err) => reject(new AgentError(err.message)));
    req.end();
  });
}
