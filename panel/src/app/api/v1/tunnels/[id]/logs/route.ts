import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { agentGet, AgentError } from "@/lib/agent-client";
import { decryptSecret } from "@/lib/crypto";
import { requireRoleResponse } from "@/lib/rbac";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireRoleResponse("VIEWER");
  if ("response" in auth) return auth.response;

  const { id } = await params;
  const lines = Number(new URL(request.url).searchParams.get("lines") ?? "200") || 200;

  const tunnel = await prisma.tunnel.findUnique({
    where: { id },
    include: { sourceServer: true, destServer: true },
  });
  if (!tunnel) {
    return NextResponse.json({ error: "tunnel not found" }, { status: 404 });
  }

  async function fetchSide(server: NonNullable<typeof tunnel>["sourceServer"]) {
    try {
      const body = await agentGet(
        {
          host: server.host,
          port: server.agentPort,
          token: decryptSecret(server.agentTokenEnc),
          tlsFingerprint: server.tlsFingerprint,
        },
        `/api/v1/managed-tunnels/${id}/logs?lines=${lines}`,
      );
      const parsed = JSON.parse(body) as { lines: string[] };
      return { server: server.name, lines: parsed.lines, error: null };
    } catch (err) {
      const message = err instanceof AgentError ? err.message : "agent request failed";
      return { server: server.name, lines: [], error: message };
    }
  }

  const [source, destination] = await Promise.all([
    fetchSide(tunnel.sourceServer),
    fetchSide(tunnel.destServer),
  ]);
  return NextResponse.json({ source, destination });
}
