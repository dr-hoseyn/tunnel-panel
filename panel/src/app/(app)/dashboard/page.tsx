import Link from "next/link";
import { prisma } from "@/lib/db";
import { Server, Cable, CheckCircle2, XCircle, AlertTriangle } from "lucide-react";

const ONLINE_THRESHOLD_MS = 60_000;

// Plain helper (not a component/hook) so the `Date.now()` call inside it
// doesn't trip React's render-purity lint rule, which -- for a Server
// Component that legitimately reads wall-clock time once per request --
// doesn't apply the same way it does to a client render function.
function isRecentlySeen(lastSeenAt: Date | null): boolean {
  return !!lastSeenAt && Date.now() - lastSeenAt.getTime() < ONLINE_THRESHOLD_MS;
}

export default async function DashboardPage() {
  const [servers, tunnelCounts, recentEvents] = await Promise.all([
    prisma.server.findMany({ select: { id: true, lastSeenAt: true } }),
    prisma.tunnel.groupBy({ by: ["status"], _count: { status: true } }),
    prisma.event.findMany({ orderBy: { createdAt: "desc" }, take: 12 }),
  ]);

  const onlineServers = servers.filter((s) => isRecentlySeen(s.lastSeenAt)).length;

  const totalTunnels = tunnelCounts.reduce((sum, c) => sum + c._count.status, 0);
  const running = tunnelCounts.find((c) => c.status === "RUNNING")?._count.status ?? 0;
  const failed = tunnelCounts.find((c) => c.status === "FAILED")?._count.status ?? 0;
  const warning = tunnelCounts.find((c) => c.status === "WARNING")?._count.status ?? 0;

  return (
    <div>
      <h1 className="mb-6 text-lg font-semibold">Dashboard</h1>

      <div className="mb-8 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
        <StatTile icon={Server} label="Servers" value={servers.length} href="/servers" />
        <StatTile icon={CheckCircle2} label="Online" value={onlineServers} tone="green" href="/servers" />
        <StatTile icon={XCircle} label="Offline" value={servers.length - onlineServers} tone="red" href="/servers" />
        <StatTile icon={Cable} label="Tunnels" value={totalTunnels} href="/tunnels" />
        <StatTile icon={CheckCircle2} label="Running" value={running} tone="green" href="/tunnels" />
        <StatTile icon={AlertTriangle} label="Failed" value={failed + warning} tone={failed > 0 ? "red" : "yellow"} href="/tunnels" />
      </div>

      <section>
        <h2 className="mb-3 text-sm font-medium text-neutral-300">Recent events</h2>
        {recentEvents.length === 0 ? (
          <p className="text-sm text-neutral-500">No events recorded yet.</p>
        ) : (
          <ul className="divide-y divide-neutral-800 rounded-lg border border-neutral-800">
            {recentEvents.map((e) => (
              <li key={e.id} className="flex items-start gap-3 px-4 py-3 text-sm">
                <SeverityDot severity={e.severity} />
                <div className="min-w-0 flex-1">
                  <p className="text-neutral-200">{e.message}</p>
                  <p className="text-xs text-neutral-500">
                    {e.createdAt.toLocaleString()} · {e.category.toLowerCase()}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
        <Link href="/logs" className="mt-3 inline-block text-xs text-neutral-500 hover:text-neutral-300">
          View all logs &rarr;
        </Link>
      </section>
    </div>
  );
}

function StatTile({
  icon: Icon,
  label,
  value,
  tone,
  href,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: number;
  tone?: "green" | "red" | "yellow";
  href: string;
}) {
  const toneClass =
    tone === "green"
      ? "text-green-400"
      : tone === "red"
        ? "text-red-400"
        : tone === "yellow"
          ? "text-yellow-400"
          : "text-neutral-100";
  return (
    <Link
      href={href}
      className="rounded-lg border border-neutral-800 bg-neutral-900 p-4 transition hover:border-neutral-700"
    >
      <Icon className="mb-2 h-4 w-4 text-neutral-500" aria-hidden="true" />
      <div className={`text-2xl font-semibold ${toneClass}`}>{value}</div>
      <div className="text-xs text-neutral-500">{label}</div>
    </Link>
  );
}

function SeverityDot({ severity }: { severity: string }) {
  const color = severity === "ERROR" ? "bg-red-500" : severity === "WARNING" ? "bg-yellow-500" : "bg-blue-500";
  return <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${color}`} aria-hidden="true" />;
}
