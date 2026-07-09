import Link from "next/link";
import { prisma } from "@/lib/db";
import { TunnelStatusBadge } from "@/components/TunnelStatusBadge";
import { Cable, Plus } from "lucide-react";

function formatBytes(rx: bigint | null | undefined): string {
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

function formatUptime(createdAt: Date, status: string): string {
  if (status !== "RUNNING") return "—";
  const ms = Date.now() - createdAt.getTime();
  const days = Math.floor(ms / 86_400_000);
  const hours = Math.floor((ms % 86_400_000) / 3_600_000);
  if (days > 0) return `${days}d ${hours}h`;
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  return `${hours}h ${minutes}m`;
}

export default async function TunnelsPage() {
  const tunnels = await prisma.tunnel.findMany({
    orderBy: { createdAt: "desc" },
    include: {
      sourceServer: { select: { name: true } },
      destServer: { select: { name: true } },
      stats: { orderBy: { timestamp: "desc" }, take: 1 },
    },
  });

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-lg font-semibold">Tunnels</h1>
        <Link
          href="/tunnels/new"
          className="flex items-center gap-1.5 rounded bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-900 hover:bg-white"
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
          Create tunnel
        </Link>
      </div>

      {tunnels.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-neutral-800 py-16 text-center">
          <Cable className="h-8 w-8 text-neutral-600" aria-hidden="true" />
          <p className="text-sm text-neutral-500">
            No tunnels yet. Create one between two registered servers to get started.
          </p>
          <Link href="/tunnels/new" className="text-sm text-neutral-300 underline hover:text-neutral-100">
            Create your first tunnel
          </Link>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-neutral-800">
          <table className="w-full min-w-[900px] text-sm">
            <thead className="bg-neutral-900 text-left text-neutral-400">
              <tr>
                <th className="px-4 py-2 font-normal">Name</th>
                <th className="px-4 py-2 font-normal">Source</th>
                <th className="px-4 py-2 font-normal">Destination</th>
                <th className="px-4 py-2 font-normal">Core</th>
                <th className="px-4 py-2 font-normal">Status</th>
                <th className="px-4 py-2 font-normal">RX</th>
                <th className="px-4 py-2 font-normal">TX</th>
                <th className="px-4 py-2 font-normal">Uptime</th>
                <th className="px-4 py-2 font-normal">Last check</th>
              </tr>
            </thead>
            <tbody>
              {tunnels.map((t) => {
                const stat = t.stats[0];
                return (
                  <tr key={t.id} className="border-t border-neutral-800 hover:bg-neutral-900/50">
                    <td className="px-4 py-3">
                      <Link href={`/tunnels/${t.id}`} className="font-medium text-neutral-100 hover:underline">
                        {t.name}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-neutral-400">{t.sourceServer.name}</td>
                    <td className="px-4 py-3 text-neutral-400">{t.destServer.name}</td>
                    <td className="px-4 py-3 text-neutral-400">{t.core}</td>
                    <td className="px-4 py-3">
                      <TunnelStatusBadge status={t.status} />
                    </td>
                    <td className="px-4 py-3 text-neutral-400">{formatBytes(stat?.rxBytes)}</td>
                    <td className="px-4 py-3 text-neutral-400">{formatBytes(stat?.txBytes)}</td>
                    <td className="px-4 py-3 text-neutral-400">{formatUptime(t.createdAt, t.status)}</td>
                    <td className="px-4 py-3 text-neutral-500">
                      {t.lastCheckedAt ? t.lastCheckedAt.toLocaleTimeString() : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
