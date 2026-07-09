import { prisma } from "@/lib/db";
import { AddServerForm } from "@/components/AddServerForm";
import { ServerCard } from "@/components/ServerCard";
import { Server as ServerIcon } from "lucide-react";

export default async function ServersPage() {
  const servers = await prisma.server.findMany({
    select: {
      id: true,
      name: true,
      host: true,
      location: true,
      agentOs: true,
      agentVersion: true,
      _count: { select: { tunnelsAsSource: true, tunnelsAsDest: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-lg font-semibold">Servers</h1>
        <AddServerForm />
      </div>

      {servers.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-neutral-800 py-16 text-center">
          <ServerIcon className="h-8 w-8 text-neutral-600" aria-hidden="true" />
          <p className="text-sm text-neutral-500">
            No servers registered yet. Install the agent on a VPS and add it above.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {servers.map((s) => (
            <ServerCard
              key={s.id}
              id={s.id}
              name={s.name}
              host={s.host}
              location={s.location}
              agentOs={s.agentOs}
              agentVersion={s.agentVersion}
              activeTunnels={s._count.tunnelsAsSource + s._count.tunnelsAsDest}
            />
          ))}
        </div>
      )}
    </div>
  );
}
