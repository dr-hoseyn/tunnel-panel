import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireRoleResponse } from "@/lib/rbac";

/** Cheap count for the header bell's badge -- polled every ~10s by
 * NotificationBell, so this stays a single COUNT query, not a full list
 * fetch. VIEWER-readable, same reasoning as the list route. */
export async function GET() {
  const auth = await requireRoleResponse("VIEWER");
  if ("response" in auth) return auth.response;

  const count = await prisma.notification.count({ where: { read: false } });
  return NextResponse.json({ count });
}
