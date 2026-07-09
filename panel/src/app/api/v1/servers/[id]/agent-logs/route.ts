import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { agentGet, AgentError } from "@/lib/agent-client";
import { decryptSecret } from "@/lib/crypto";
import { requireRoleResponse } from "@/lib/rbac";

/** Proxies the agent's own recent journal output (tunnel-agent.service) --
 * distinct from a tunnel's own logs. Read-only, so VIEWER can fetch it. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireRoleResponse("VIEWER");
  if ("response" in auth) return auth.response;

  const { id } = await params;
  const server = await prisma.server.findUnique({ where: { id } });
  if (!server) {
    return NextResponse.json({ error: "server not found" }, { status: 404 });
  }

  const lines = new URL(request.url).searchParams.get("lines") ?? "";
  const path = lines ? `/api/v1/agent/logs?lines=${encodeURIComponent(lines)}` : "/api/v1/agent/logs";

  try {
    const body = await agentGet(
      {
        host: server.host,
        port: server.agentPort,
        token: decryptSecret(server.agentTokenEnc),
        tlsFingerprint: server.tlsFingerprint,
      },
      path,
    );
    const parsed = JSON.parse(body) as { lines: string[] };
    return NextResponse.json({ ok: true, lines: parsed.lines ?? [] });
  } catch (err) {
    const message = err instanceof AgentError ? err.message : "agent request failed";
    return NextResponse.json({ ok: false, error: message }, { status: 502 });
  }
}
