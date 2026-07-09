import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { deleteTunnel, OrchestratorError } from "@/lib/tunnel-orchestrator";
import { requireRoleResponse } from "@/lib/rbac";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireRoleResponse("VIEWER");
  if ("response" in auth) return auth.response;

  const { id } = await params;
  const tunnel = await prisma.tunnel.findUnique({
    where: { id },
    include: {
      sourceServer: { select: { id: true, name: true, host: true } },
      destServer: { select: { id: true, name: true, host: true } },
      deployments: { orderBy: { createdAt: "desc" }, take: 10 },
    },
  });
  if (!tunnel) {
    return NextResponse.json({ error: "tunnel not found" }, { status: 404 });
  }
  return NextResponse.json({ tunnel });
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireRoleResponse("OPERATOR");
  if ("response" in auth) return auth.response;

  const { id } = await params;
  try {
    const { deploymentId } = await deleteTunnel(id);
    return NextResponse.json({ deploymentId }, { status: 202 });
  } catch (err) {
    if (err instanceof OrchestratorError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
}
