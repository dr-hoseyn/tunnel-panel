import { prisma } from "@/lib/db";
import { TunnelStatusBadge } from "@/components/TunnelStatusBadge";
import { TrafficChart } from "@/components/TrafficChart";

function formatBytes(value: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let n = value;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(1)} ${units[i]}`;
}

function startOfDay(daysAgo: number): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - daysAgo);
  return d;
}

// Plain helper (not a component/hook) so the `Date.now()` call inside it
// doesn't trip React's render-purity lint rule -- see the same pattern in
// dashboard/page.tsx.
function isRecentlySeen(lastSeenAt: Date | null): boolean {
  return !!lastSeenAt && Date.now() - lastSeenAt.getTime() < 60_000;
}

export default async function MonitoringPage() {
  const [tunnels, servers, todayAgg, yesterdayAgg, recentSamples] = await Promise.all([
    prisma.tunnel.findMany({
      include: {
        sourceServer: { select: { name: true } },
        destServer: { select: { name: true } },
        stats: { orderBy: { timestamp: "desc" }, take: 1 },
      },
      orderBy: { name: "asc" },
    }),
    prisma.server.findMany({ select: { id: true, name: true, lastSeenAt: true } }),
    prisma.tunnelStat.aggregate({
      _sum: { rxBytes: true, txBytes: true },
      where: { timestamp: { gte: startOfDay(0) } },
    }),
    prisma.tunnelStat.aggregate({
      _sum: { rxBytes: true, txBytes: true },
      where: { timestamp: { gte: startOfDay(1), lt: startOfDay(0) } },
    }),
    prisma.tunnelStat.findMany({
      orderBy: { timestamp: "asc" },
      take: 500,
    }),
  ]);

  const onlineServers = servers.filter((s) => isRecentlySeen(s.lastSeenAt)).length;

  const totalRx = tunnels.reduce((sum, t) => sum + Number(t.stats[0]?.rxBytes ?? 0), 0);
  const totalTx = tunnels.reduce((sum, t) => sum + Number(t.stats[0]?.txBytes ?? 0), 0);

  // Bucket every tunnel's samples into one fleet-wide series by timestamp
  // (rounded to the minute) so multiple tunnels' traffic overlays into one
  // total-bandwidth-over-time line rather than needing a chart per tunnel.
  const buckets = new Map<string, { rx: number; tx: number }>();
  for (const s of recentSamples) {
    const key = new Date(Math.floor(s.timestamp.getTime() / 60_000) * 60_000).toISOString();
    const bucket = buckets.get(key) ?? { rx: 0, tx: 0 };
    bucket.rx += Number(s.rxBytes);
    bucket.tx += Number(s.txBytes);
    buckets.set(key, bucket);
  }
  const fleetSeries = Array.from(buckets.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([timestamp, v]) => ({ timestamp, rxBytes: v.rx, txBytes: v.tx }));

  const topByBandwidth = [...tunnels]
    .sort((a, b) => {
      const aTotal = Number(a.stats[0]?.rxBytes ?? 0) + Number(a.stats[0]?.txBytes ?? 0);
      const bTotal = Number(b.stats[0]?.rxBytes ?? 0) + Number(b.stats[0]?.txBytes ?? 0);
      return bTotal - aTotal;
    })
    .slice(0, 5);

  return (
    <div>
      <h1 className="mb-6 text-lg font-semibold">Monitoring</h1>

      <div className="mb-8 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <StatTile label="Servers online" value={`${onlineServers}/${servers.length}`} />
        <StatTile label="Total bandwidth (latest)" value={`${formatBytes(totalRx)} / ${formatBytes(totalTx)}`} sub="RX / TX" />
        <StatTile
          label="Today's traffic"
          value={formatBytes(Number(todayAgg._sum.rxBytes ?? 0) + Number(todayAgg._sum.txBytes ?? 0))}
        />
        <StatTile
          label="Yesterday's traffic"
          value={formatBytes(Number(yesterdayAgg._sum.rxBytes ?? 0) + Number(yesterdayAgg._sum.txBytes ?? 0))}
        />
      </div>

      <section className="mb-8">
        <h2 className="mb-3 text-sm font-medium text-neutral-300">Fleet-wide traffic (sampled every ~15s)</h2>
        <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-4">
          <TrafficChart samples={fleetSeries} />
        </div>
      </section>

      <section className="mb-8">
        <h2 className="mb-3 text-sm font-medium text-neutral-300">Top tunnels by bandwidth</h2>
        {topByBandwidth.length === 0 ? (
          <p className="text-sm text-neutral-500">No traffic samples yet.</p>
        ) : (
          <div className="overflow-hidden rounded-lg border border-neutral-800">
            <table className="w-full text-sm">
              <thead className="bg-neutral-900 text-left text-neutral-400">
                <tr>
                  <th className="px-4 py-2 font-normal">Tunnel</th>
                  <th className="px-4 py-2 font-normal">Path</th>
                  <th className="px-4 py-2 font-normal">Status</th>
                  <th className="px-4 py-2 font-normal">RX</th>
                  <th className="px-4 py-2 font-normal">TX</th>
                </tr>
              </thead>
              <tbody>
                {topByBandwidth.map((t) => (
                  <tr key={t.id} className="border-t border-neutral-800">
                    <td className="px-4 py-2 text-neutral-200">{t.name}</td>
                    <td className="px-4 py-2 text-neutral-500">
                      {t.sourceServer.name} &rarr; {t.destServer.name}
                    </td>
                    <td className="px-4 py-2">
                      <TunnelStatusBadge status={t.status} />
                    </td>
                    <td className="px-4 py-2 text-neutral-400">{formatBytes(Number(t.stats[0]?.rxBytes ?? 0))}</td>
                    <td className="px-4 py-2 text-neutral-400">{formatBytes(Number(t.stats[0]?.txBytes ?? 0))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-3 text-sm font-medium text-neutral-300">Servers</h2>
        <div className="overflow-hidden rounded-lg border border-neutral-800">
          <table className="w-full text-sm">
            <thead className="bg-neutral-900 text-left text-neutral-400">
              <tr>
                <th className="px-4 py-2 font-normal">Server</th>
                <th className="px-4 py-2 font-normal">Status</th>
                <th className="px-4 py-2 font-normal">Last seen</th>
              </tr>
            </thead>
            <tbody>
              {servers.map((s) => {
                const online = isRecentlySeen(s.lastSeenAt);
                return (
                  <tr key={s.id} className="border-t border-neutral-800">
                    <td className="px-4 py-2 text-neutral-200">{s.name}</td>
                    <td className="px-4 py-2">
                      <span className={online ? "text-green-400" : "text-red-400"}>{online ? "Online" : "Offline"}</span>
                    </td>
                    <td className="px-4 py-2 text-neutral-500">{s.lastSeenAt ? s.lastSeenAt.toLocaleString() : "never"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function StatTile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-4">
      <div className="text-xl font-semibold text-neutral-100">{value}</div>
      <div className="text-xs text-neutral-500">{label}</div>
      {sub && <div className="text-xs text-neutral-600">{sub}</div>}
    </div>
  );
}
