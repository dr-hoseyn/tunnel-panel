import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { agentGet, AgentError } from "@/lib/agent-client";
import { decryptSecret } from "@/lib/crypto";
import { requireRoleResponse } from "@/lib/rbac";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireRoleResponse("VIEWER");
  if ("response" in auth) return auth.response;

  const { id } = await params;
  const server = await prisma.server.findUnique({ where: { id } });
  if (!server) {
    return NextResponse.json({ error: "server not found" }, { status: 404 });
  }

  const startedAt = Date.now();
  try {
    const body = await agentGet(
      {
        host: server.host,
        port: server.agentPort,
        token: decryptSecret(server.agentTokenEnc),
        tlsFingerprint: server.tlsFingerprint,
      },
      "/api/v1/agent/info",
    );
    const info = JSON.parse(body) as {
      version: string;
      commit: string;
      os: string;
      arch: string;
      supported_drivers: string[];
    };
    const latencyMs = Date.now() - startedAt;
    await prisma.server.update({
      where: { id },
      data: {
        lastSeenAt: new Date(),
        agentVersion: info.version,
        agentCommit: info.commit,
        agentOs: info.os,
        agentArch: info.arch,
      },
    });
    return NextResponse.json({ ok: true, latencyMs, info });
  } catch (err) {
    const message = err instanceof AgentError ? err.message : "agent request failed";
    return NextResponse.json({ ok: false, error: message }, { status: 200 });
  }
}
