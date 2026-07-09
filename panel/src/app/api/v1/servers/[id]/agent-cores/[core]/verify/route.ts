import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { agentGet, AgentError } from "@/lib/agent-client";
import { decryptSecret } from "@/lib/crypto";
import { requireRoleResponse } from "@/lib/rbac";

/** Re-checks one core's binary on demand -- see the agent's own
 * tunnels.VerifyCore doc comment for why this is a distinct action from
 * GET .../agent-cores (which re-checks every core at once). Read-only (a
 * fresh health check, not a mutation), so VIEWER can fetch it, same gating
 * as agent-cores. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; core: string }> },
) {
  const auth = await requireRoleResponse("VIEWER");
  if ("response" in auth) return auth.response;

  const { id, core } = await params;
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
      `/api/v1/agent/cores/${encodeURIComponent(core)}/verify`,
    );
    const report = JSON.parse(body) as { core: string; path: string; status: string; has_previous: boolean };
    return NextResponse.json({ ok: true, report });
  } catch (err) {
    const message = err instanceof AgentError ? err.message : "agent request failed";
    const status = err instanceof AgentError && err.status && err.status >= 400 && err.status < 500 ? err.status : 502;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
