import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireRoleResponse } from "@/lib/rbac";

/** Downloads a backup as a standalone JSON file for offsite storage.
 * secretEnc travels as-is (still AES-256-GCM ciphertext, never decrypted
 * here) -- downloading the file never exposes the plaintext secret, only
 * someone with this panel's AGENT_TOKEN_ENC_KEY could ever decrypt it. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireRoleResponse("OPERATOR");
  if ("response" in auth) return auth.response;

  const { id } = await params;
  const backup = await prisma.tunnelBackup.findUnique({
    where: { id },
    include: { tunnel: { select: { name: true, core: true } } },
  });
  if (!backup) {
    return NextResponse.json({ error: "backup not found" }, { status: 404 });
  }

  const file = {
    formatVersion: 1,
    tunnelName: backup.tunnel.name,
    core: backup.tunnel.core,
    configSnapshot: backup.configSnapshot,
    serviceUnitSnapshot: backup.serviceUnitSnapshot,
    secretEnc: backup.secretEnc,
    driverVersion: backup.driverVersion,
    note: backup.note,
    createdAt: backup.createdAt.toISOString(),
  };

  const filename = `${backup.tunnel.name.replace(/[^a-zA-Z0-9_-]+/g, "_")}-backup-${backup.id}.json`;
  return new NextResponse(JSON.stringify(file, null, 2), {
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
