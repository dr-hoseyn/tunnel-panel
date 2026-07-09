import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { agentGet, AgentError } from "@/lib/agent-client";
import { decryptSecret } from "@/lib/crypto";
import { requireRoleResponse } from "@/lib/rbac";

/** Proxies the agent's installed-core-binary report (backhaul/rathole/gost/
 * hysteria2 -- installed and healthy / installed but broken / not
 * installed). Read-only, so VIEWER can fetch it. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireRoleResponse("VIEWER");
  if ("response" in auth) return auth.response;

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
        token: decryptSecret(server.agentTokenEnc),
        tlsFingerprint: server.tlsFingerprint,
      },
      "/api/v1/agent/cores",
    );
    const parsed = JSON.parse(body) as { cores: { core: string; path: string; status: string }[] };
    return NextResponse.json({ ok: true, cores: parsed.cores ?? [] });
  } catch (err) {
    const message = err instanceof AgentError ? err.message : "agent request failed";
    return NextResponse.json({ ok: false, error: message }, { status: 502 });
  }
}
