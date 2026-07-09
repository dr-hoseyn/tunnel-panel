import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { agentPost, AgentError } from "@/lib/agent-client";
import { decryptSecret } from "@/lib/crypto";
import { requireRoleResponse } from "@/lib/rbac";

/** Swaps one core's binary back to its saved "<binary>.previous" version --
 * see the agent's own tunnels.RollbackCore doc comment: it's a genuine
 * two-way swap (the binary being replaced becomes the new .previous), but
 * only ever remembers one prior version. Returns whatever 4xx the agent
 * returned (404 today, "no previous version available") when there is
 * nothing to roll back to, instead of flattening every failure to a
 * generic 502 -- the operator needs to be able to tell "there's nothing to
 * undo" apart from "the box is unreachable". Admin-only, same gating as
 * Reinstall: this replaces a binary shared by every tunnel on the box using
 * this core. */
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
      `/api/v1/agent/cores/${encodeURIComponent(core)}/rollback`,
    );
    const report = JSON.parse(body) as { core: string; path: string; status: string; has_previous: boolean };

    await prisma.event.create({
      data: {
        category: "AUDIT",
        type: "CORE_ROLLED_BACK",
        severity: "WARNING",
        message: `Core "${core}" rolled back to its previous version on server "${server.name}" by ${auth.session.user?.email ?? "unknown"}. Tunnels already using this core keep running on the binary they already loaded until they are restarted.`,
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
