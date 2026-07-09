import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { agentPost, AgentError } from "@/lib/agent-client";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { requireRoleResponse } from "@/lib/rbac";

/** Rotates an agent's bearer token: tells the agent to generate a new one
 * (invalidating the old one immediately, see admin_handlers.go's own
 * comment on that), then persists the new token encrypted. Admin-only --
 * this is a credential-management action. */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireRoleResponse("ADMIN");
  if ("response" in auth) return auth.response;

  const { id } = await params;
  const server = await prisma.server.findUnique({ where: { id } });
  if (!server) {
    return NextResponse.json({ error: "server not found" }, { status: 404 });
  }

  try {
    const body = await agentPost(
      {
        host: server.host,
        port: server.agentPort,
        token: decryptSecret(server.agentTokenEnc),
        tlsFingerprint: server.tlsFingerprint,
      },
      "/api/v1/token/rotate",
    );
    const parsed = JSON.parse(body) as { token: string };
    await prisma.server.update({
      where: { id },
      data: { agentTokenEnc: encryptSecret(parsed.token) },
    });
    await prisma.event.create({
      data: {
        category: "AUDIT",
        type: "TOKEN_ROTATED",
        severity: "INFO",
        message: `Agent token rotated for server "${server.name}" by ${auth.session.user?.email ?? "unknown"}.`,
        serverId: id,
        userId: auth.session.user?.id,
      },
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof AgentError ? err.message : "agent request failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
