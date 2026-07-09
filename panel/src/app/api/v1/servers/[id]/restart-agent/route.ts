import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { agentPost, AgentError } from "@/lib/agent-client";
import { decryptSecret } from "@/lib/crypto";
import { requireRoleResponse } from "@/lib/rbac";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireRoleResponse("ADMIN");
  if ("response" in auth) return auth.response;

  const { id } = await params;
  const server = await prisma.server.findUnique({ where: { id } });
  if (!server) {
    return NextResponse.json({ error: "server not found" }, { status: 404 });
  }

  try {
    await agentPost(
      {
        host: server.host,
        port: server.agentPort,
        token: decryptSecret(server.agentTokenEnc),
        tlsFingerprint: server.tlsFingerprint,
      },
      "/api/v1/agent/restart",
    );
    await prisma.event.create({
      data: {
        category: "AUDIT",
        type: "AGENT_RESTARTED",
        severity: "INFO",
        message: `Agent restarted on server "${server.name}" by ${auth.session.user?.email ?? "unknown"}.`,
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
