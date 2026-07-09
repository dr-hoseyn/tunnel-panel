import Link from "next/link";
import { prisma } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import type { EventCategory, Severity } from "@/generated/prisma/enums";

const CATEGORIES = ["ALL", "AUDIT", "DEPLOYMENT", "RUNTIME"] as const;
const SEVERITIES = ["ALL", "INFO", "WARNING", "ERROR"] as const;

const SEVERITY_STYLE: Record<string, string> = {
  INFO: "text-blue-400",
  WARNING: "text-yellow-400",
  ERROR: "text-red-400",
};

export default async function LogsPage({
  searchParams,
}: {
  searchParams: Promise<{ category?: string; severity?: string }>;
}) {
  const { category = "ALL", severity = "ALL" } = await searchParams;

  const where: Prisma.EventWhereInput = {};
  if (category !== "ALL") where.category = category as EventCategory;
  if (severity !== "ALL") where.severity = severity as Severity;

  const events = await prisma.event.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: 200,
    include: { server: { select: { name: true } }, tunnel: { select: { name: true } }, user: { select: { email: true } } },
  });

  function filterUrl(next: { category?: string; severity?: string }) {
    const params = new URLSearchParams({
      category: next.category ?? category,
      severity: next.severity ?? severity,
    });
    return `/logs?${params.toString()}`;
  }

  return (
    <div>
      <h1 className="mb-6 text-lg font-semibold">Logs</h1>

      <div className="mb-4 flex flex-wrap items-center gap-4">
        <FilterGroup label="Category">
          {CATEGORIES.map((c) => (
            <FilterLink key={c} href={filterUrl({ category: c })} active={category === c}>
              {c === "ALL" ? "All" : c.charAt(0) + c.slice(1).toLowerCase()}
            </FilterLink>
          ))}
        </FilterGroup>
        <FilterGroup label="Severity">
          {SEVERITIES.map((s) => (
            <FilterLink key={s} href={filterUrl({ severity: s })} active={severity === s}>
              {s === "ALL" ? "All" : s.charAt(0) + s.slice(1).toLowerCase()}
            </FilterLink>
          ))}
        </FilterGroup>
      </div>

      {events.length === 0 ? (
        <p className="rounded-lg border border-dashed border-neutral-800 py-16 text-center text-sm text-neutral-500">
          No events match this filter.
        </p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-neutral-800">
          <table className="w-full text-sm">
            <thead className="bg-neutral-900 text-left text-neutral-400">
              <tr>
                <th className="px-4 py-2 font-normal">Time</th>
                <th className="px-4 py-2 font-normal">Category</th>
                <th className="px-4 py-2 font-normal">Severity</th>
                <th className="px-4 py-2 font-normal">Message</th>
                <th className="px-4 py-2 font-normal">Context</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.id} className="border-t border-neutral-800 align-top">
                  <td className="whitespace-nowrap px-4 py-2 text-neutral-500">{e.createdAt.toLocaleString()}</td>
                  <td className="px-4 py-2 text-neutral-400">{e.category}</td>
                  <td className={`px-4 py-2 font-medium ${SEVERITY_STYLE[e.severity] ?? ""}`}>{e.severity}</td>
                  <td className="px-4 py-2 text-neutral-200">{e.message}</td>
                  <td className="px-4 py-2 text-xs text-neutral-500">
                    {e.server?.name && <div>server: {e.server.name}</div>}
                    {e.tunnel?.name && <div>tunnel: {e.tunnel.name}</div>}
                    {e.user?.email && <div>user: {e.user.email}</div>}
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

function FilterGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-1.5 text-xs">
      <span className="text-neutral-500">{label}:</span>
      {children}
    </div>
  );
}

function FilterLink({ href, active, children }: { href: string; active: boolean; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className={`rounded-full border px-2.5 py-1 ${
        active ? "border-neutral-100 bg-neutral-100 text-neutral-900" : "border-neutral-700 text-neutral-400 hover:bg-neutral-800"
      }`}
    >
      {children}
    </Link>
  );
}
