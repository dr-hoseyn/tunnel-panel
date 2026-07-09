import { NextResponse } from "next/server";
import { z } from "zod";
import { setTunnelAutoRestartDisabled, OrchestratorError } from "@/lib/tunnel-orchestrator";
import { requireRoleResponse } from "@/lib/rbac";

const bodySchema = z.object({ disabled: z.boolean() });

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireRoleResponse("OPERATOR");
  if ("response" in auth) return auth.response;

  const { id } = await params;
  const body = await request.json().catch(() => null);
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues.map((i) => i.message).join("; ") }, { status: 400 });
  }

  try {
    await setTunnelAutoRestartDisabled(id, parsed.data.disabled);
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof OrchestratorError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
}
