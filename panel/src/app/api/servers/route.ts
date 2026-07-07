import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { agentFetchFingerprint, agentGet, AgentError } from "@/lib/agent-client";

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

  // Trust-on-first-use: fetch the cert the agent is actually presenting
  // right now, and require it to match what the operator copied from the
  // agent's own install output. This is the one point where we trust an
  // unpinned connection -- every request after registration is pinned.
  let liveFingerprint: string;
  try {
    liveFingerprint = await agentFetchFingerprint(host, agentPort);
  } catch (err) {
    const message = err instanceof AgentError ? err.message : "could not reach the agent";
    return NextResponse.json({ error: `Could not connect to the agent: ${message}` }, { status: 502 });
  }

  if (liveFingerprint !== expectedFingerprint) {
    return NextResponse.json(
      {
        error:
          "The certificate the agent is presenting does not match the fingerprint you entered. " +
          "Re-check it against the agent's install output before registering this server.",
      },
      { status: 409 },
    );
  }

  // Confirm the token actually works against the now-pinned connection
  // before persisting anything.
  try {
    await agentGet(
      { host, port: agentPort, token, tlsFingerprint: liveFingerprint },
      "/api/v1/metrics",
    );
  } catch (err) {
    const message = err instanceof AgentError ? err.message : "token check failed";
    return NextResponse.json(
      { error: `Certificate verified, but the token was rejected: ${message}` },
      { status: 401 },
    );
  }

  const server = await prisma.server.create({
    data: { name, host, agentPort, agentToken: token, tlsFingerprint: liveFingerprint },
    select: { id: true, name: true, host: true, agentPort: true, createdAt: true },
  });

  return NextResponse.json({ server }, { status: 201 });
}
