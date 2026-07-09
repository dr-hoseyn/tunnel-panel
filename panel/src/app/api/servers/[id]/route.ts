import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireRoleResponse } from "@/lib/rbac";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireRoleResponse("VIEWER");
  if ("response" in auth) return auth.response;

  const { id } = await params;
  const server = await prisma.server.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      host: true,
      agentPort: true,
      location: true,
      agentOs: true,
      agentArch: true,
      agentVersion: true,
      lastSeenAt: true,
      createdAt: true,
    },
  });
  if (!server) {
    return NextResponse.json({ error: "server not found" }, { status: 404 });
  }
  return NextResponse.json({ server });
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireRoleResponse("OPERATOR");
  if ("response" in auth) return auth.response;

  const { id } = await params;
  const body = await request.json().catch(() => null);
  const name = typeof body?.name === "string" ? body.name.trim() : undefined;
  const location = typeof body?.location === "string" ? body.location.trim() : undefined;

  if (name !== undefined && name.length === 0) {
    return NextResponse.json({ error: "name must not be empty" }, { status: 400 });
  }

  const server = await prisma.server.update({
    where: { id },
    data: { ...(name !== undefined ? { name } : {}), ...(location !== undefined ? { location } : {}) },
    select: { id: true, name: true, host: true, location: true },
  });
  return NextResponse.json({ server });
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireRoleResponse("OPERATOR");
  if ("response" in auth) return auth.response;

  const { id } = await params;
  const tunnelCount = await prisma.tunnel.count({
    where: { OR: [{ sourceServerId: id }, { destServerId: id }] },
  });
  if (tunnelCount > 0) {
    return NextResponse.json(
      { error: `this server still has ${tunnelCount} tunnel(s) -- delete those first` },
      { status: 409 },
    );
  }

  await prisma.server.delete({ where: { id } });
  return new NextResponse(null, { status: 204 });
}
