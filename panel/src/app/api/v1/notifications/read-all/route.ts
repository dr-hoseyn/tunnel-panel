import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireRoleResponse } from "@/lib/rbac";

/** Marks every currently-unread notification read in one statement -- the
 * dropdown's "mark all read" action. VIEWER-readable, same reasoning as the
 * rest of this route group: reading your own notifications isn't a
 * privileged action, there's nothing here an OPERATOR/ADMIN gate protects. */
export async function POST() {
  const auth = await requireRoleResponse("VIEWER");
  if ("response" in auth) return auth.response;

  const result = await prisma.notification.updateMany({ where: { read: false }, data: { read: true } });
  return NextResponse.json({ count: result.count });
}
