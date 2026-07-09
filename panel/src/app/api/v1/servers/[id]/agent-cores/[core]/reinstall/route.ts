import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { agentPost, AgentError } from "@/lib/agent-client";
import { decryptSecret } from "@/lib/crypto";
import { requireRoleResponse } from "@/lib/rbac";

/** Forces a fresh download+install of one core's binary on the target VPS,
 * even if the currently installed one already passes its health check --
 * see the agent's own tunnels.ReinstallCore doc comment for the mechanics
 * (it backs up the existing binary to "<binary>.previous" first, which is
 * also what makes Rollback possible afterward) and, importantly, what it
 * deliberately does NOT do: restart any tunnel service already using this
 * core. Those keep running on the old binary already loaded into memory
 * until something restarts them. Admin-only, same gating as agent-update/
 * agent-stop: this replaces a binary shared by every tunnel on the box
 * using this core, not just one tunnel. */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string; core: string }> },
) {
  const auth = await requireRoleResponse("ADMIN");
  if ("response" in auth) return auth.response;

  const { id, core } = await params;
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
      `/api/v1/agent/cores/${encodeURIComponent(core)}/reinstall`,
    );
    const report = JSON.parse(body) as { core: string; path: string; status: string; has_previous: boolean };

    await prisma.event.create({
      data: {
        category: "AUDIT",
        type: "CORE_REINSTALLED",
        severity: "WARNING",
        message: `Core "${core}" reinstalled on server "${server.name}" by ${auth.session.user?.email ?? "unknown"}. Tunnels already using this core keep running on the old binary until they are restarted.`,
        serverId: id,
        userId: auth.session.user?.id,
      },
    });

    return NextResponse.json({ ok: true, report });
  } catch (err) {
    const message = err instanceof AgentError ? err.message : "agent request failed";
    const status = err instanceof AgentError && err.status && err.status >= 400 && err.status < 500 ? err.status : 502;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
