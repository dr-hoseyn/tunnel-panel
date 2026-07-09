import Link from "next/link";
import { prisma } from "@/lib/db";
import { RestoreBackupButton } from "@/components/RestoreBackupButton";

export default async function BackupsPage() {
  const backups = await prisma.tunnelBackup.findMany({
    orderBy: { createdAt: "desc" },
    include: { tunnel: { select: { id: true, name: true, core: true } } },
  });

  return (
    <div>
      <h1 className="mb-2 text-lg font-semibold">Backups</h1>
      <p className="mb-6 text-sm text-neutral-500">
        Config snapshots taken from a tunnel&rsquo;s detail page. Restoring deploys a brand-new
        tunnel from the snapshot rather than overwriting the original.
      </p>

      {backups.length === 0 ? (
        <p className="rounded-lg border border-dashed border-neutral-800 py-16 text-center text-sm text-neutral-500">
          No backups yet. Open a tunnel and use &ldquo;Backup&rdquo; to create one.
        </p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-neutral-800">
          <table className="w-full text-sm">
            <thead className="bg-neutral-900 text-left text-neutral-400">
              <tr>
                <th className="px-4 py-2 font-normal">Tunnel</th>
                <th className="px-4 py-2 font-normal">Core</th>
                <th className="px-4 py-2 font-normal">Created</th>
                <th className="px-4 py-2 font-normal">Note</th>
                <th className="px-4 py-2 font-normal">Actions</th>
              </tr>
            </thead>
            <tbody>
              {backups.map((b) => (
                <tr key={b.id} className="border-t border-neutral-800">
                  <td className="px-4 py-2">
                    <Link href={`/tunnels/${b.tunnel.id}`} className="text-neutral-200 hover:underline">
                      {b.tunnel.name}
                    </Link>
                  </td>
                  <td className="px-4 py-2 text-neutral-400">{b.tunnel.core}</td>
                  <td className="px-4 py-2 text-neutral-500">{b.createdAt.toLocaleString()}</td>
                  <td className="px-4 py-2 text-neutral-500">{b.note ?? "—"}</td>
                  <td className="px-4 py-2">
                    <RestoreBackupButton id={b.id} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
