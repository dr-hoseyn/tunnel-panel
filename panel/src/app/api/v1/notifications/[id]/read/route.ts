import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireRoleResponse } from "@/lib/rbac";

/** Marks a single notification read. VIEWER-readable -- reading your own
 * notifications isn't a privileged action, unlike the mutating tunnel/server
 * actions elsewhere under /api/v1 that require OPERATOR/ADMIN. */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireRoleResponse("VIEWER");
  if ("response" in auth) return auth.response;

  const { id } = await params;
  const notification = await prisma.notification.findUnique({ where: { id } });
  if (!notification) {
    return NextResponse.json({ error: "notification not found" }, { status: 404 });
  }

  const updated = await prisma.notification.update({ where: { id }, data: { read: true } });
  return NextResponse.json({ notification: updated });
}
