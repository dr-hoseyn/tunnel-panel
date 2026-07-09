import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireRoleResponse } from "@/lib/rbac";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/** Newest first, VIEWER-readable (reading your own notifications isn't a
 * privileged action). `?unread=true` restricts to unread only; `?limit=`
 * caps the page size, defaulting to DEFAULT_LIMIT and clamped to MAX_LIMIT
 * so the bell's dropdown can't accidentally request the entire table. */
export async function GET(request: Request) {
  const auth = await requireRoleResponse("VIEWER");
  if ("response" in auth) return auth.response;

  const { searchParams } = new URL(request.url);
  const unreadOnly = searchParams.get("unread") === "true";
  const requestedLimit = Number(searchParams.get("limit"));
  const limit =
    Number.isFinite(requestedLimit) && requestedLimit > 0 ? Math.min(requestedLimit, MAX_LIMIT) : DEFAULT_LIMIT;

  const notifications = await prisma.notification.findMany({
    where: unreadOnly ? { read: false } : undefined,
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  return NextResponse.json({ notifications });
}
