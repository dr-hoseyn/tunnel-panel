import Link from "next/link";
import { prisma } from "@/lib/db";
import { TunnelsTable } from "@/components/TunnelsTable";
import { Cable, Plus } from "lucide-react";

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
        <TunnelsTable
          tunnels={tunnels.map((t) => ({
            id: t.id,
            name: t.name,
            sourceServerName: t.sourceServer.name,
            destServerName: t.destServer.name,
            core: t.core,
            status: t.status,
            rxBytes: Number(t.stats[0]?.rxBytes ?? 0),
            txBytes: Number(t.stats[0]?.txBytes ?? 0),
            createdAt: t.createdAt.toISOString(),
            lastCheckedAt: t.lastCheckedAt ? t.lastCheckedAt.toISOString() : null,
          }))}
        />
      )}
    </div>
  );
}
