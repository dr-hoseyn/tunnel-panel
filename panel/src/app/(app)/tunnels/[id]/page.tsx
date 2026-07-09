import { notFound } from "next/navigation";
import Link from "next/link";
import { prisma } from "@/lib/db";
import { TunnelDetailView } from "@/components/TunnelDetailView";
import { computeHealthScore } from "@/lib/health-score";

export default async function TunnelDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const tunnel = await prisma.tunnel.findUnique({
    where: { id },
    include: {
      sourceServer: { select: { id: true, name: true, host: true } },
      destServer: { select: { id: true, name: true, host: true } },
      deployments: { orderBy: { createdAt: "desc" }, take: 1 },
    },
  });
  if (!tunnel) {
    notFound();
  }

  const latestDeployment = tunnel.deployments[0];
  let lastError: string | null = null;
  if (latestDeployment?.status === "FAILED" && Array.isArray(latestDeployment.steps)) {
    const steps = latestDeployment.steps as { step: string; status: string; message?: string }[];
    const failedStep = [...steps].reverse().find((s) => s.status === "failed");
    lastError = failedStep?.message ?? "Deployment failed (no further detail recorded).";
  }

  const stats = await prisma.tunnelStat.findMany({
    where: { tunnelId: id },
    orderBy: { timestamp: "asc" },
    take: 200,
    skip: Math.max(0, (await prisma.tunnelStat.count({ where: { tunnelId: id } })) - 200),
  });

  const healthScore = computeHealthScore(
    tunnel.status,
    stats.map((s) => ({ timestamp: s.timestamp, latencyMs: s.latencyMs, reconnectCount: s.reconnectCount })),
  );
  const latest = stats[stats.length - 1];

  return (
    <div>
      <Link href="/tunnels" className="mb-4 inline-block text-sm text-neutral-400 hover:text-neutral-100">
        &larr; Tunnels
      </Link>
      <TunnelDetailView
        tunnel={{
          id: tunnel.id,
          name: tunnel.name,
          core: tunnel.core,
          status: tunnel.status,
          createdAt: tunnel.createdAt.toISOString(),
          lastCheckedAt: tunnel.lastCheckedAt?.toISOString() ?? null,
          lastRestartAt: tunnel.lastRestartAt?.toISOString() ?? null,
          sourceServer: tunnel.sourceServer,
          destServer: tunnel.destServer,
          lastError,
        }}
        stats={stats.map((s) => ({
          timestamp: s.timestamp.toISOString(),
          rxBytes: Number(s.rxBytes),
          txBytes: Number(s.txBytes),
          latencyMs: s.latencyMs,
          connections: s.connections,
        }))}
        healthScore={healthScore}
        reconnectCount={latest?.reconnectCount ?? 0}
        cpuPercent={latest?.cpuPercent ?? null}
        ramPercent={latest?.ramPercent ?? null}
      />
    </div>
  );
}
