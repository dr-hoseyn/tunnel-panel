import { prisma } from "@/lib/db";
import { getSettings } from "@/lib/settings";
import { createTunnelBackup } from "@/lib/backups";
import { TunnelStatus } from "@/generated/prisma/enums";

/**
 * Optional scheduled-backup cycle: for every RUNNING tunnel, if its most
 * recent TunnelBackup (if any) is older than settings.backupScheduleHours,
 * take a new one via the same createTunnelBackup() the manual "Backup"
 * button uses. Disabled entirely (backupScheduleHours === 0, the default)
 * -- most installs don't want automatic backups piling up with no cleanup
 * policy, so this is opt-in via the Settings page, not on by default.
 *
 * Runs every 30 minutes (its own cadence, not tied to the health sampler's
 * configurable interval -- backups are cheap DB rows checked on an hours-
 * to-days cadence, not something that needs sub-minute responsiveness).
 */
const CYCLE_INTERVAL_MS = 30 * 60 * 1000;

let started = false;

export function startBackupScheduler(): void {
  if (started) return;
  started = true;
  setInterval(() => {
    runBackupScheduleCycle().catch((err) => console.error("[backup-scheduler] cycle failed:", err));
  }, CYCLE_INTERVAL_MS);
}

export async function runBackupScheduleCycle(): Promise<void> {
  const settings = await getSettings();
  if (settings.backupScheduleHours <= 0) return;

  const intervalMs = settings.backupScheduleHours * 60 * 60 * 1000;
  const tunnels = await prisma.tunnel.findMany({
    where: { status: TunnelStatus.RUNNING },
    select: { id: true },
  });

  for (const tunnel of tunnels) {
    try {
      const latest = await prisma.tunnelBackup.findFirst({
        where: { tunnelId: tunnel.id },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true },
      });
      const due = !latest || Date.now() - latest.createdAt.getTime() >= intervalMs;
      if (!due) continue;

      await createTunnelBackup(tunnel.id, "Scheduled backup");
    } catch (err) {
      console.error(`[backup-scheduler] backing up tunnel ${tunnel.id} failed:`, err);
    }
  }
}
