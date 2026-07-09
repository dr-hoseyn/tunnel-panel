import Link from "next/link";
import { prisma } from "@/lib/db";
import { TunnelWizard } from "@/components/TunnelWizard";

export default async function NewTunnelPage() {
  const servers = await prisma.server.findMany({
    select: { id: true, name: true, host: true },
    orderBy: { name: "asc" },
  });

  return (
    <div className="mx-auto max-w-2xl">
      <Link href="/tunnels" className="mb-4 inline-block text-sm text-neutral-400 hover:text-neutral-100">
        &larr; Tunnels
      </Link>
      <h1 className="mb-6 text-lg font-semibold">Create tunnel</h1>

      {servers.length < 2 ? (
        <div className="rounded-lg border border-dashed border-neutral-800 p-8 text-center text-sm text-neutral-500">
          You need at least two registered servers to create a tunnel.{" "}
          <Link href="/servers" className="text-neutral-300 underline hover:text-neutral-100">
            Add a server
          </Link>{" "}
          first.
        </div>
      ) : (
        <TunnelWizard servers={servers} />
      )}
    </div>
  );
}
