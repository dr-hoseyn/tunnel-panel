import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { registerServer, RegisterServerError } from "@/lib/register-server";
import { requireRoleResponse } from "@/lib/rbac";

export async function GET() {
  const auth = await requireRoleResponse("VIEWER");
  if ("response" in auth) return auth.response;

  const servers = await prisma.server.findMany({
    select: { id: true, name: true, host: true, agentPort: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });
  return NextResponse.json({ servers });
}

export async function POST(request: Request) {
  // Registering a server is a write action (and, via the SSH path in
  // provision/route.ts, can install software on a new box) -- this used to
  // only check "is logged in" at all, which let a VIEWER-role account
  // (meant to be read-only) register servers same as an OPERATOR.
  const auth = await requireRoleResponse("OPERATOR");
  if ("response" in auth) return auth.response;

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
