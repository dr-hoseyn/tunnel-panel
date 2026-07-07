import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { agentGet, AgentError } from "@/lib/agent-client";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const server = await prisma.server.findUnique({ where: { id } });
  if (!server) {
    return NextResponse.json({ error: "server not found" }, { status: 404 });
  }

  try {
    const body = await agentGet(
      {
        host: server.host,
        port: server.agentPort,
        token: server.agentToken,
        tlsFingerprint: server.tlsFingerprint,
      },
      "/api/v1/metrics",
    );
    return new NextResponse(body, { headers: { "Content-Type": "application/json" } });
  } catch (err) {
    const message = err instanceof AgentError ? err.message : "agent request failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
