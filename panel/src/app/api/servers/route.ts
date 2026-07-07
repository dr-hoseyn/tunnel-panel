import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { registerServer, RegisterServerError } from "@/lib/register-server";

export async function GET() {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const servers = await prisma.server.findMany({
    select: { id: true, name: true, host: true, agentPort: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });
  return NextResponse.json({ servers });
}

export async function POST(request: Request) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const host = typeof body?.host === "string" ? body.host.trim() : "";
  const agentPort = Number.isInteger(body?.agentPort) ? body.agentPort : 8443;
  const token = typeof body?.token === "string" ? body.token.trim() : "";
  const expectedFingerprint =
    typeof body?.fingerprint === "string" ? body.fingerprint.trim().toUpperCase() : "";

  if (!name || !host || !token || !expectedFingerprint) {
    return NextResponse.json(
      { error: "name, host, token, and fingerprint are all required" },
      { status: 400 },
    );
  }

  try {
    const server = await registerServer({ name, host, agentPort, token, expectedFingerprint });
    return NextResponse.json({ server }, { status: 201 });
  } catch (err) {
    if (err instanceof RegisterServerError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
}
