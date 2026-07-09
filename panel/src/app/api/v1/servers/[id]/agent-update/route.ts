import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { agentPost, AgentError } from "@/lib/agent-client";
import { decryptSecret } from "@/lib/crypto";
import { requireRoleResponse } from "@/lib/rbac";

/** Triggers the agent's own self-update flow (download the latest release,
 * swap its binary, restart) -- see agent/internal/server/agent_update.go.
 * Admin-only: this replaces the running binary on a remote box. */
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
      "/api/v1/agent/update",
    );
    const result = JSON.parse(body) as {
      status: string;
      new_version?: string;
      latest_version?: string;
      previous_version?: string;
      current_version?: string;
    };

    if (result.status === "updated" && result.new_version) {
      await prisma.server.update({
        where: { id },
        data: { agentVersion: result.new_version },
      });
    }

    await prisma.event.create({
      data: {
        category: "AUDIT",
        type: "AGENT_UPDATED",
        severity: "INFO",
        message:
          result.status === "updated"
            ? `Agent updated on server "${server.name}" (${result.previous_version ?? "?"} -> ${result.new_version ?? "?"}) by ${auth.session.user?.email ?? "unknown"}.`
            : `Agent update checked on server "${server.name}" by ${auth.session.user?.email ?? "unknown"}: ${result.status}.`,
        serverId: id,
        userId: auth.session.user?.id,
      },
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const message = err instanceof AgentError ? err.message : "agent request failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
