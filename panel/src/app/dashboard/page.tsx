import { prisma } from "@/lib/db";
import { AddServerForm } from "@/components/AddServerForm";
import { ServerCard } from "@/components/ServerCard";

export default async function DashboardPage() {
  const servers = await prisma.server.findMany({
    select: { id: true, name: true, host: true },
    orderBy: { createdAt: "asc" },
  });

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-lg font-semibold">Servers</h1>
        <AddServerForm />
      </div>

      {servers.length === 0 ? (
        <p className="text-sm text-neutral-500">
          No servers registered yet. Install the agent on a VPS and add it above.
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {servers.map((s) => (
            <ServerCard key={s.id} id={s.id} name={s.name} host={s.host} />
          ))}
        </div>
      )}
    </div>
  );
}
