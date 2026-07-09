import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireRoleResponse } from "@/lib/rbac";
import { createTunnelBackup } from "@/lib/backups";

/** Snapshots a tunnel's current config + secret (see src/lib/backups.ts,
 * shared with the scheduled-backup cycle). Restoring (see
 * /api/v1/backups/[id]/restore) creates a *new* tunnel from the snapshot
 * rather than mutating the original in place -- the agent has no
 * "update config on an existing tunnel" endpoint yet (only create/delete),
 * so an in-place restore would mean delete-then-recreate on both agents,
 * which is destructive if the redeploy fails partway. Spinning up a new
 * tunnel from the snapshot is the safe operation available today; note in
 * the systemUnitSnapshot field that unit file contents themselves live on
 * the agent, not here -- this panel never had a copy of them to snapshot. */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireRoleResponse("OPERATOR");
  if ("response" in auth) return auth.response;

  const { id } = await params;
  const result = await createTunnelBackup(id, `Manual backup by ${auth.session.user?.email ?? "unknown"}`);
  if (!result) {
    return NextResponse.json({ error: "tunnel not found" }, { status: 404 });
  }

  await prisma.event.create({
    data: {
      category: "AUDIT",
      type: "TUNNEL_BACKUP_CREATED",
      severity: "INFO",
      message: `Backup created for tunnel "${result.tunnelName}".`,
      tunnelId: id,
      userId: auth.session.user?.id,
    },
  });

  return NextResponse.json({ backupId: result.id }, { status: 201 });
}
