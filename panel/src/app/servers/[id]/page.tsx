import { notFound } from "next/navigation";
import Link from "next/link";
import { prisma } from "@/lib/db";
import { ServerDetail } from "@/components/ServerDetail";

export default async function ServerDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const server = await prisma.server.findUnique({
    select: { id: true, name: true, host: true },
    where: { id },
  });
  if (!server) {
    notFound();
  }

  return (
    <div>
      <Link href="/dashboard" className="mb-4 inline-block text-sm text-neutral-400 hover:text-neutral-100">
        &larr; Servers
      </Link>
      <h1 className="mb-1 text-lg font-semibold">{server.name}</h1>
      <p className="mb-6 text-sm text-neutral-500">{server.host}</p>
      <ServerDetail id={server.id} />
    </div>
  );
}
