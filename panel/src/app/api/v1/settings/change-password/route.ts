import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireRoleResponse } from "@/lib/rbac";

const schema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8, "new password must be at least 8 characters"),
});

export async function POST(request: Request) {
  const auth = await requireRoleResponse("VIEWER");
  if ("response" in auth) return auth.response;

  const body = await request.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues.map((i) => i.message).join("; ") }, { status: 400 });
  }

  const userId = auth.session.user?.id;
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    return NextResponse.json({ error: "user not found" }, { status: 404 });
  }

  const valid = await bcrypt.compare(parsed.data.currentPassword, user.passwordHash);
  if (!valid) {
    return NextResponse.json({ error: "current password is incorrect" }, { status: 401 });
  }

  const passwordHash = await bcrypt.hash(parsed.data.newPassword, 12);
  await prisma.user.update({ where: { id: userId }, data: { passwordHash } });
  await prisma.event.create({
    data: {
      category: "AUDIT",
      type: "PASSWORD_CHANGED",
      severity: "INFO",
      message: `${user.email} changed their password.`,
      userId: user.id,
    },
  });

  return NextResponse.json({ ok: true });
}
