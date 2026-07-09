import { NextResponse } from "next/server";
import { startTunnel, OrchestratorError } from "@/lib/tunnel-orchestrator";
import { requireRoleResponse } from "@/lib/rbac";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireRoleResponse("OPERATOR");
  if ("response" in auth) return auth.response;

  const { id } = await params;
  try {
    const { deploymentId } = await startTunnel(id);
    return NextResponse.json({ deploymentId }, { status: 202 });
  } catch (err) {
    if (err instanceof OrchestratorError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
}
