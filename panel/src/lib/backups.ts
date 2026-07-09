import { prisma } from "@/lib/db";

/**
 * Shared by the manual "Backup" button (POST /api/v1/tunnels/[id]/backup)
 * and the scheduled backup cycle (backup-scheduler.ts) -- one place that
 * knows how to snapshot a tunnel, so the two paths can never drift.
 */
export async function createTunnelBackup(
  tunnelId: string,
  note: string,
): Promise<{ id: string; tunnelName: string } | null> {
  const tunnel = await prisma.tunnel.findUnique({ where: { id: tunnelId } });
  if (!tunnel) return null;

  const backup = await prisma.tunnelBackup.create({
    data: {
      tunnelId,
      configSnapshot: tunnel.config as object,
      serviceUnitSnapshot: {
        note: "Generated systemd unit files live on each agent, not in the panel's database -- this snapshot captures the tunnel spec needed to redeploy, not the unit file text itself.",
      },
      secretEnc: tunnel.secretEnc,
      note,
    },
  });

  return { id: backup.id, tunnelName: tunnel.name };
}
