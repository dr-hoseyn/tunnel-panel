import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireRoleResponse } from "@/lib/rbac";

export async function GET() {
  const auth = await requireRoleResponse("ADMIN");
  if ("response" in auth) return auth.response;

  const users = await prisma.user.findMany({
    select: { id: true, email: true, role: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });
  return NextResponse.json({ users });
}

const createUserSchema = z.object({
  email: z.email(),
  password: z.string().min(8, "password must be at least 8 characters"),
  role: z.enum(["ADMIN", "OPERATOR", "VIEWER"]),
});

export async function POST(request: Request) {
  const auth = await requireRoleResponse("ADMIN");
  if ("response" in auth) return auth.response;

  const body = await request.json().catch(() => null);
  const parsed = createUserSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues.map((i) => i.message).join("; ") },
      { status: 400 },
    );
  }

  const existing = await prisma.user.findUnique({ where: { email: parsed.data.email } });
  if (existing) {
    return NextResponse.json({ error: "a user with this email already exists" }, { status: 409 });
  }

  const passwordHash = await bcrypt.hash(parsed.data.password, 12);
  const user = await prisma.user.create({
    data: { email: parsed.data.email, passwordHash, role: parsed.data.role },
    select: { id: true, email: true, role: true, createdAt: true },
  });

  await prisma.event.create({
    data: {
      category: "AUDIT",
      type: "USER_CREATED",
      severity: "INFO",
      message: `User ${user.email} created with role ${user.role} by ${auth.session.user?.email ?? "unknown"}.`,
      userId: auth.session.user?.id,
    },
  });

  return NextResponse.json({ user }, { status: 201 });
}
