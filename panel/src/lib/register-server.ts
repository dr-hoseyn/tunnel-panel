import { prisma } from "@/lib/db";
import { agentFetchFingerprint, agentGet, AgentError } from "@/lib/agent-client";
import { encryptSecret } from "@/lib/crypto";

/** Thrown with an HTTP status already attached, so route handlers can just
 * catch-and-respond without re-deriving what status code fits the error. */
export class RegisterServerError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
    this.name = "RegisterServerError";
  }
}

/**
 * Shared by both registration paths (manual token/fingerprint paste, and
 * SSH-based auto-provisioning): verifies the agent's live TLS fingerprint
 * matches what's expected (trust-on-first-use) and that the token actually
 * works, and only then persists the server. Never partially succeeds --
 * either both checks pass and the row is created, or nothing is written.
 */
export async function registerServer(params: {
  name: string;
  host: string;
  agentPort: number;
  token: string;
  expectedFingerprint: string;
}) {
  const { name, host, agentPort, token } = params;
  const expectedFingerprint = params.expectedFingerprint.toUpperCase();

  let liveFingerprint: string;
  try {
    liveFingerprint = await agentFetchFingerprint(host, agentPort);
  } catch (err) {
    const message = err instanceof AgentError ? err.message : "could not reach the agent";
    throw new RegisterServerError(`Could not connect to the agent: ${message}`, 502);
  }

  if (liveFingerprint !== expectedFingerprint) {
    throw new RegisterServerError(
      "The certificate the agent is presenting does not match the fingerprint given. " +
        "Re-check it against the agent's install output before registering this server.",
      409,
    );
  }

  try {
    await agentGet({ host, port: agentPort, token, tlsFingerprint: liveFingerprint }, "/api/v1/metrics");
  } catch (err) {
    const message = err instanceof AgentError ? err.message : "token check failed";
    throw new RegisterServerError(`Certificate verified, but the token was rejected: ${message}`, 401);
  }

  return prisma.server.create({
    data: { name, host, agentPort, agentTokenEnc: encryptSecret(token), tlsFingerprint: liveFingerprint },
    select: { id: true, name: true, host: true, agentPort: true, createdAt: true },
  });
}
