import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireRoleResponse } from "@/lib/rbac";

/**
 * Read-only fleet-wide status snapshot backing the topology map's polling
 * refresh (see TopologyMap.tsx). Servers/tunnels don't change status often
 * enough to justify a new SSE stream the way a single tunnel's live log tail
 * does (health-sampler itself only ticks every ~15s) -- a plain interval
 * poll of this route is simpler and still comfortably within this project's
 * "avoid unnecessary polling, but plain polling is fine where sub-few-second
 * freshness isn't required" principle.
 *
 * orderBy matches the initial server-rendered query in topology/page.tsx so
 * node positions (computed client-side from array order) stay stable across
 * refreshes instead of reshuffling every poll.
 */
export async function GET() {
  const auth = await requireRoleResponse("VIEWER");
  if ("response" in auth) return auth.response;

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

  return NextResponse.json({
    servers: servers.map((s) => ({ ...s, lastSeenAt: s.lastSeenAt ? s.lastSeenAt.toISOString() : null })),
    tunnels,
  });
}
