import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireRoleResponse } from "@/lib/rbac";

/** Polling fallback for deployment progress -- also used by the SSE stream
 * route below it as its underlying data source. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireRoleResponse("VIEWER");
  if ("response" in auth) return auth.response;
  const { id } = await params;
  const deployment = await prisma.deployment.findUnique({ where: { id } });
  if (!deployment) {
    return NextResponse.json({ error: "deployment not found" }, { status: 404 });
  }
  return NextResponse.json({ deployment });
}
