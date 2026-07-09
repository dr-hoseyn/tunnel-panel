import { prisma } from "@/lib/db";
import { TopologyMap } from "@/components/TopologyMap";

export default async function TopologyPage() {
  const [servers, tunnels] = await Promise.all([
    prisma.server.findMany({ select: { id: true, name: true, location: true } }),
    prisma.tunnel.findMany({
      select: { id: true, name: true, core: true, status: true, sourceServerId: true, destServerId: true },
    }),
  ]);

  return (
    <div>
      <h1 className="mb-2 text-lg font-semibold">Network topology</h1>
      <p className="mb-6 text-sm text-neutral-500">
        Every registered server and the tunnels connecting them, colored by live status.
      </p>
      <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-6">
        <TopologyMap
          nodes={servers}
          edges={tunnels.map((t) => ({
            id: t.id,
            name: t.name,
            core: t.core,
            status: t.status,
            sourceId: t.sourceServerId,
            destId: t.destServerId,
          }))}
        />
      </div>
    </div>
  );
}
