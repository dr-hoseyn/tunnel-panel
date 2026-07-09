import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { agentPost, AgentError } from "@/lib/agent-client";
import { decryptSecret } from "@/lib/crypto";
import { requireRoleResponse } from "@/lib/rbac";

/** Stops the agent's systemd unit on the target VPS. Unlike restart, the
 * agent will NOT come back on its own afterwards -- see the agent's own
 * handleAgentStop comment. Admin-only, same gating as restart-agent/
 * rotate-token: this is a disruptive action against a remote box. */
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
      "/api/v1/agent/stop",
    );
    await prisma.event.create({
      data: {
        category: "AUDIT",
        type: "AGENT_STOPPED",
        severity: "WARNING",
        message: `Agent stopped on server "${server.name}" by ${auth.session.user?.email ?? "unknown"}. It will not restart on its own.`,
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
