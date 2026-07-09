/** Shared formatting helpers for byte counts and tunnel uptime -- used by
 * both the Tunnels list and anywhere else that needs the same display
 * conventions (previously duplicated inline in tunnels/page.tsx). */

export function formatBytes(rx: bigint | number | null | undefined): string {
  if (!rx) return "0 B";
  const value = Number(rx);
  const units = ["B", "KB", "MB", "GB", "TB"];
  let n = value;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(1)} ${units[i]}`;
}

export function formatUptime(createdAt: Date | string, status: string): string {
  if (status !== "RUNNING") return "—";
  const createdMs = typeof createdAt === "string" ? new Date(createdAt).getTime() : createdAt.getTime();
  const ms = Date.now() - createdMs;
  const days = Math.floor(ms / 86_400_000);
  const hours = Math.floor((ms % 86_400_000) / 3_600_000);
  if (days > 0) return `${days}d ${hours}h`;
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  return `${hours}h ${minutes}m`;
}
