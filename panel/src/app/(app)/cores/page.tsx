import { prisma } from "@/lib/db";
import { listCoreDescriptors } from "@/lib/cores/registry";

export default async function CoresPage() {
  const [descriptors, counts, servers] = await Promise.all([
    listCoreDescriptors(),
    prisma.tunnel.groupBy({ by: ["core"], _count: { core: true } }),
    prisma.server.findMany({
      select: { id: true, name: true, agentVersion: true, agentOs: true, agentArch: true, lastSeenAt: true },
      orderBy: { name: "asc" },
    }),
  ]);

  const countByCore = new Map(counts.map((c) => [c.core, c._count.core]));

  return (
    <div>
      <h1 className="mb-2 text-lg font-semibold">Cores</h1>
      <p className="mb-6 text-sm text-neutral-500">
        Tunnel engines this panel can deploy natively via the agent -- see the agent&rsquo;s own
        driver registry for how to add a new one.
      </p>

      <div className="mb-8 grid grid-cols-1 gap-4 sm:grid-cols-2">
        {descriptors.map((d) => (
          <div key={d.core} className="rounded-lg border border-neutral-800 bg-neutral-900 p-4">
            <div className="mb-1 flex items-center justify-between">
              <span className="font-medium text-neutral-100">{d.label}</span>
              <span className="text-xs text-neutral-500">{countByCore.get(d.core) ?? 0} tunnel(s)</span>
            </div>
            <p className="mb-3 text-xs text-neutral-500">{d.description}</p>
            <div className="flex gap-4 text-xs text-neutral-400">
              <span>Firewall: {d.firewallProto}</span>
              <span>Default port: {d.defaultPort}</span>
              <span>Ports on: {d.portsOn}</span>
            </div>
          </div>
        ))}
      </div>

      <h2 className="mb-3 text-sm font-medium text-neutral-300">Agent versions per server</h2>
      <div className="overflow-hidden rounded-lg border border-neutral-800">
        <table className="w-full text-sm">
          <thead className="bg-neutral-900 text-left text-neutral-400">
            <tr>
              <th className="px-4 py-2 font-normal">Server</th>
              <th className="px-4 py-2 font-normal">Agent version</th>
              <th className="px-4 py-2 font-normal">OS/Arch</th>
              <th className="px-4 py-2 font-normal">Last confirmed</th>
            </tr>
          </thead>
          <tbody>
            {servers.map((s) => (
              <tr key={s.id} className="border-t border-neutral-800">
                <td className="px-4 py-2 text-neutral-200">{s.name}</td>
                <td className="px-4 py-2 text-neutral-400">{s.agentVersion ?? "unknown -- run Test connection"}</td>
                <td className="px-4 py-2 text-neutral-400">
                  {s.agentOs ? `${s.agentOs}/${s.agentArch}` : "—"}
                </td>
                <td className="px-4 py-2 text-neutral-500">
                  {s.lastSeenAt ? s.lastSeenAt.toLocaleString() : "never"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
