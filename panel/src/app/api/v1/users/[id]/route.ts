import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireRoleResponse } from "@/lib/rbac";

const updateSchema = z.object({ role: z.enum(["ADMIN", "OPERATOR", "VIEWER"]) });

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireRoleResponse("ADMIN");
  if ("response" in auth) return auth.response;

  const { id } = await params;
  const body = await request.json().catch(() => null);
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "role must be ADMIN, OPERATOR, or VIEWER" }, { status: 400 });
  }

  const target = await prisma.user.findUnique({ where: { id } });
  if (!target) {
    return NextResponse.json({ error: "user not found" }, { status: 404 });
  }

  if (target.role === "ADMIN" && parsed.data.role !== "ADMIN") {
    const adminCount = await prisma.user.count({ where: { role: "ADMIN" } });
    if (adminCount <= 1) {
      return NextResponse.json({ error: "cannot demote the last remaining admin" }, { status: 409 });
    }
  }

  const user = await prisma.user.update({
    where: { id },
    data: { role: parsed.data.role },
    select: { id: true, email: true, role: true },
  });

  await prisma.event.create({
    data: {
      category: "AUDIT",
      type: "USER_ROLE_CHANGED",
      severity: "INFO",
      message: `${user.email}'s role changed to ${user.role} by ${auth.session.user?.email ?? "unknown"}.`,
      userId: auth.session.user?.id,
    },
  });

  return NextResponse.json({ user });
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireRoleResponse("ADMIN");
  if ("response" in auth) return auth.response;

  const { id } = await params;
  if (id === auth.session.user?.id) {
    return NextResponse.json({ error: "you cannot remove your own account" }, { status: 400 });
  }

  const target = await prisma.user.findUnique({ where: { id } });
  if (!target) {
    return NextResponse.json({ error: "user not found" }, { status: 404 });
  }
  if (target.role === "ADMIN") {
    const adminCount = await prisma.user.count({ where: { role: "ADMIN" } });
    if (adminCount <= 1) {
      return NextResponse.json({ error: "cannot remove the last remaining admin" }, { status: 409 });
    }
  }

  await prisma.user.delete({ where: { id } });
  await prisma.event.create({
    data: {
      category: "AUDIT",
      type: "USER_REMOVED",
      severity: "WARNING",
      message: `User ${target.email} removed by ${auth.session.user?.email ?? "unknown"}.`,
    },
  });
  return new NextResponse(null, { status: 204 });
}
