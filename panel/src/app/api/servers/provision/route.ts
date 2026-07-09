import { NextResponse } from "next/server";
import { provisionAgentViaSsh, ProvisionError } from "@/lib/ssh-provision";
import { registerServer, RegisterServerError } from "@/lib/register-server";
import { requireRoleResponse } from "@/lib/rbac";

export async function POST(request: Request) {
  // SSH-provisioning installs software on an arbitrary host using
  // credentials in the request body -- OPERATOR minimum, same as manual
  // registration (see the sibling route.ts's POST for why this was missing).
  const auth = await requireRoleResponse("OPERATOR");
  if ("response" in auth) return auth.response;

  const body = await request.json().catch(() => null);
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const host = typeof body?.host === "string" ? body.host.trim() : "";
  const sshPort = Number.isInteger(body?.sshPort) ? body.sshPort : 22;
  const sshUsername = typeof body?.sshUsername === "string" ? body.sshUsername.trim() : "root";
  const sshPassword = typeof body?.sshPassword === "string" ? body.sshPassword : undefined;
  const sshPrivateKey = typeof body?.sshPrivateKey === "string" ? body.sshPrivateKey : undefined;
  const agentPort = Number.isInteger(body?.agentPort) ? body.agentPort : 8443;
  const resetExisting = body?.resetExisting === true;
  const installTunnelManager = body?.installTunnelManager === true;

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
      resetExisting,
      installTunnelManager,
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
      const code = err instanceof ProvisionError ? err.code : undefined;
      return NextResponse.json({ error: err.message, code }, { status });
    }
    throw err;
  }
}
