import { prisma } from "@/lib/db";
import { TopologyMap } from "@/components/TopologyMap";

export default async function TopologyPage() {
  // orderBy matches /api/v1/topology's queries exactly so the polling
  // refresh TopologyMap does client-side returns nodes/edges in the same
  // order this initial render used -- positions are derived from array
  // order, so a mismatch here would make the layout jump on the first poll.
  const [servers, tunnels] = await Promise.all([
    prisma.server.findMany({
      select: { id: true, name: true, location: true, lastSeenAt: true },
      orderBy: { createdAt: "asc" },
    }),
    prisma.tunnel.findMany({
      select: { id: true, name: true, core: true, status: true, sourceServerId: true, destServerId: true },
      orderBy: { createdAt: "asc" },
    }),
  ]);

  return (
    <div>
      <h1 className="mb-2 text-lg font-semibold">Network topology</h1>
      <p className="mb-6 text-sm text-neutral-500">
        Every registered server and the tunnels connecting them, colored by live status. Updates automatically every
        ~12s.
      </p>
      <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-6">
        <TopologyMap
          nodes={servers.map((s) => ({
            id: s.id,
            name: s.name,
            location: s.location,
            lastSeenAt: s.lastSeenAt ? s.lastSeenAt.toISOString() : null,
          }))}
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
