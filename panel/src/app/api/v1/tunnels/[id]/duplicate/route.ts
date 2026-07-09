import { NextResponse } from "next/server";
import { z } from "zod";
import { duplicateTunnel, OrchestratorError } from "@/lib/tunnel-orchestrator";
import { requireRoleResponse } from "@/lib/rbac";

const bodySchema = z
  .object({
    name: z.string().min(1).max(100),
    sourceServerId: z.string().min(1),
    destServerId: z.string().min(1),
  })
  .partial();

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireRoleResponse("OPERATOR");
  if ("response" in auth) return auth.response;

  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues.map((i) => i.message).join("; ") }, { status: 400 });
  }

  try {
    const { tunnel, deploymentId } = await duplicateTunnel(id, parsed.data);
    return NextResponse.json({ tunnel, deploymentId }, { status: 201 });
  } catch (err) {
    if (err instanceof OrchestratorError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
}
