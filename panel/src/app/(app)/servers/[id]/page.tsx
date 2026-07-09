import { notFound } from "next/navigation";
import Link from "next/link";
import { prisma } from "@/lib/db";
import { auth } from "@/auth";
import { ServerDetail } from "@/components/ServerDetail";
import { ServerActions } from "@/components/ServerActions";
import { AgentCoresTable } from "@/components/AgentCoresTable";
import { TunnelStatusBadge } from "@/components/TunnelStatusBadge";

export default async function ServerDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [server, session] = await Promise.all([
    prisma.server.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        host: true,
        location: true,
        agentOs: true,
        agentArch: true,
        agentVersion: true,
        lastSeenAt: true,
      },
    }),
    auth(),
  ]);
  if (!server) {
    notFound();
  }

  const tunnels = await prisma.tunnel.findMany({
    where: { OR: [{ sourceServerId: id }, { destServerId: id }] },
    include: { sourceServer: { select: { name: true } }, destServer: { select: { name: true } } },
    orderBy: { createdAt: "desc" },
  });

  return (
    <div>
      <Link href="/servers" className="mb-4 inline-block text-sm text-neutral-400 hover:text-neutral-100">
        &larr; Servers
      </Link>
      <h1 className="mb-1 text-lg font-semibold">{server.name}</h1>
      <p className="mb-1 text-sm text-neutral-500">
        {server.host}
        {server.location ? ` · ${server.location}` : ""}
        {server.agentOs ? ` · ${server.agentOs}/${server.agentArch}` : ""}
        {server.agentVersion ? ` · agent ${server.agentVersion}` : ""}
      </p>
      <p className="mb-6 text-xs text-neutral-600">
        {server.lastSeenAt ? `Last confirmed reachable ${server.lastSeenAt.toLocaleString()}` : "Never confirmed reachable yet -- try Test connection."}
      </p>

      <ServerActions
        id={server.id}
        name={server.name}
        location={server.location}
        isAdmin={session?.user?.role === "ADMIN"}
      />

      <ServerDetail id={server.id} />

      <section className="mt-8">
        <AgentCoresTable id={server.id} />
      </section>

      <section className="mt-8">
        <h2 className="mb-3 text-sm font-medium text-neutral-300">Tunnels on this server</h2>
        {tunnels.length === 0 ? (
          <p className="text-sm text-neutral-500">No panel-managed tunnels on this server yet.</p>
        ) : (
          <div className="overflow-hidden rounded-lg border border-neutral-800">
            <table className="w-full text-sm">
              <thead className="bg-neutral-900 text-left text-neutral-400">
                <tr>
                  <th className="px-4 py-2 font-normal">Name</th>
                  <th className="px-4 py-2 font-normal">Core</th>
                  <th className="px-4 py-2 font-normal">Path</th>
                  <th className="px-4 py-2 font-normal">Status</th>
                </tr>
              </thead>
              <tbody>
                {tunnels.map((t) => (
                  <tr key={t.id} className="border-t border-neutral-800">
                    <td className="px-4 py-2">
                      <Link href={`/tunnels/${t.id}`} className="text-neutral-200 hover:text-neutral-100 hover:underline">
                        {t.name}
                      </Link>
                    </td>
                    <td className="px-4 py-2 text-neutral-400">{t.core}</td>
                    <td className="px-4 py-2 text-neutral-400">
                      {t.sourceServer.name} &rarr; {t.destServer.name}
                    </td>
                    <td className="px-4 py-2">
                      <TunnelStatusBadge status={t.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
