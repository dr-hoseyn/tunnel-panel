import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { provisionAgentViaSsh, ProvisionError } from "@/lib/ssh-provision";
import { registerServer, RegisterServerError } from "@/lib/register-server";

export async function POST(request: Request) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const host = typeof body?.host === "string" ? body.host.trim() : "";
  const sshPort = Number.isInteger(body?.sshPort) ? body.sshPort : 22;
  const sshUsername = typeof body?.sshUsername === "string" ? body.sshUsername.trim() : "root";
  const sshPassword = typeof body?.sshPassword === "string" ? body.sshPassword : undefined;
  const sshPrivateKey = typeof body?.sshPrivateKey === "string" ? body.sshPrivateKey : undefined;
  const agentPort = Number.isInteger(body?.agentPort) ? body.agentPort : 8443;

  if (!name || !host || (!sshPassword && !sshPrivateKey)) {
    return NextResponse.json(
      { error: "name, host, and either an SSH password or private key are required" },
      { status: 400 },
    );
  }

  try {
    const provisioned = await provisionAgentViaSsh({
      host,
      sshPort,
      username: sshUsername,
      password: sshPassword,
      privateKey: sshPrivateKey,
    });

    const server = await registerServer({
      name,
      host,
      agentPort,
      token: provisioned.token,
      expectedFingerprint: provisioned.fingerprint,
    });

    return NextResponse.json({ server }, { status: 201 });
  } catch (err) {
    if (err instanceof ProvisionError || err instanceof RegisterServerError) {
      const status = err instanceof RegisterServerError ? err.status : 502;
      return NextResponse.json({ error: err.message }, { status });
    }
    throw err;
  }
}
