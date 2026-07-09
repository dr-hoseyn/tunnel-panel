import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireRoleResponse } from "@/lib/rbac";
import { createTunnel, OrchestratorError } from "@/lib/tunnel-orchestrator";
import type { TunnelCore } from "@/generated/prisma/enums";

interface ConfigSnapshot {
  port: number;
  ports?: { remote: number; local: number }[];
  extra?: Record<string, string | undefined>;
}

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireRoleResponse("OPERATOR");
  if ("response" in auth) return auth.response;

  const { id } = await params;
  const backup = await prisma.tunnelBackup.findUnique({
    where: { id },
    include: { tunnel: true },
  });
  if (!backup) {
    return NextResponse.json({ error: "backup not found" }, { status: 404 });
  }

  const config = backup.configSnapshot as unknown as ConfigSnapshot;

  try {
    const { tunnel, deploymentId } = await createTunnel({
      name: `${backup.tunnel.name} (restored ${new Date().toLocaleDateString()})`,
      core: backup.tunnel.core as TunnelCore,
      sourceServerId: backup.tunnel.sourceServerId,
      destServerId: backup.tunnel.destServerId,
      port: config.port,
      ports: config.ports,
      extra: config.extra,
      createdById: auth.session.user?.id,
    });
    return NextResponse.json({ tunnel, deploymentId }, { status: 202 });
  } catch (err) {
    if (err instanceof OrchestratorError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
}
