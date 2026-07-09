"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { TunnelStatusBadge } from "@/components/TunnelStatusBadge";
import { TunnelRowActions } from "@/components/TunnelRowActions";
import { formatBytes, formatUptime } from "@/lib/format";

export interface TunnelRow {
  id: string;
  name: string;
  sourceServerName: string;
  destServerName: string;
  core: string;
  status: string;
  rxBytes: number;
  txBytes: number;
  createdAt: string;
  lastCheckedAt: string | null;
}

type BulkAction = "start" | "stop" | "restart" | "delete";

/** Client component so multi-select + a bulk action bar can exist above a
 * server-rendered list -- tunnels are still fetched server-side in
 * page.tsx and passed in as plain data, this component only owns
 * selection state and the bulk-action requests themselves. Each bulk
 * action reuses the exact same per-tunnel API routes the row-level
 * actions already call (POST .../start|stop|restart, DELETE ...), fired
 * concurrently via Promise.allSettled so one tunnel's failure doesn't
 * block the others. */
export function TunnelsTable({ tunnels }: { tunnels: TunnelRow[] }) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState<BulkAction | null>(null);
  const [result, setResult] = useState<{ ok: number; failed: number } | null>(null);

  const allSelected = tunnels.length > 0 && selected.size === tunnels.length;
  const someSelected = selected.size > 0;

  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(tunnels.map((t) => t.id)));
  }

  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const selectedIds = useMemo(() => Array.from(selected), [selected]);

  async function runBulk(action: BulkAction) {
    setPending(action);
    setResult(null);
    const outcomes = await Promise.allSettled(
      selectedIds.map((id) =>
        action === "delete"
          ? fetch(`/api/v1/tunnels/${id}`, { method: "DELETE" })
          : fetch(`/api/v1/tunnels/${id}/${action}`, { method: "POST" }),
      ),
    );
    const ok = outcomes.filter((o) => o.status === "fulfilled" && o.value.ok).length;
    setResult({ ok, failed: outcomes.length - ok });
    setPending(null);
    setSelected(new Set());
    router.refresh();
  }

  return (
    <div>
      {someSelected && (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-neutral-700 bg-neutral-900 px-4 py-2.5 text-sm">
          <span className="text-neutral-300">{selected.size} selected</span>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <BulkButton label="Start" action="start" pending={pending} onRun={runBulk} />
            <BulkButton label="Stop" action="stop" pending={pending} onRun={runBulk} />
            <BulkButton label="Restart" action="restart" pending={pending} onRun={runBulk} />
            <BulkButton label="Delete" action="delete" pending={pending} onRun={runBulk} danger />
          </div>
        </div>
      )}
      {result && (
        <p className="mb-3 text-xs text-neutral-400">
          {result.ok} succeeded{result.failed > 0 ? `, ${result.failed} failed` : ""}.
        </p>
      )}

      <div className="overflow-x-auto rounded-lg border border-neutral-800">
        <table className="w-full min-w-[950px] text-sm">
          <thead className="bg-neutral-900 text-left text-neutral-400">
            <tr>
              <th className="w-10 px-4 py-2">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={toggleAll}
                  aria-label="Select all tunnels"
                  className="h-4 w-4 rounded border-neutral-700 bg-neutral-950"
                />
              </th>
              <th className="px-4 py-2 font-normal">Name</th>
              <th className="px-4 py-2 font-normal">Source</th>
              <th className="px-4 py-2 font-normal">Destination</th>
              <th className="px-4 py-2 font-normal">Core</th>
              <th className="px-4 py-2 font-normal">Status</th>
              <th className="px-4 py-2 font-normal">RX</th>
              <th className="px-4 py-2 font-normal">TX</th>
              <th className="px-4 py-2 font-normal">Uptime</th>
              <th className="px-4 py-2 font-normal">Last check</th>
              <th className="px-4 py-2 font-normal text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {tunnels.map((t) => (
              <tr key={t.id} className="border-t border-neutral-800 hover:bg-neutral-900/50">
                <td className="px-4 py-3">
                  <input
                    type="checkbox"
                    checked={selected.has(t.id)}
                    onChange={() => toggleOne(t.id)}
                    aria-label={`Select ${t.name}`}
                    className="h-4 w-4 rounded border-neutral-700 bg-neutral-950"
                  />
                </td>
                <td className="px-4 py-3">
                  <Link href={`/tunnels/${t.id}`} className="font-medium text-neutral-100 hover:underline">
                    {t.name}
                  </Link>
                </td>
                <td className="px-4 py-3 text-neutral-400">{t.sourceServerName}</td>
                <td className="px-4 py-3 text-neutral-400">{t.destServerName}</td>
                <td className="px-4 py-3 text-neutral-400">{t.core}</td>
                <td className="px-4 py-3">
                  <TunnelStatusBadge status={t.status} />
                </td>
                <td className="px-4 py-3 text-neutral-400">{formatBytes(t.rxBytes)}</td>
                <td className="px-4 py-3 text-neutral-400">{formatBytes(t.txBytes)}</td>
                <td className="px-4 py-3 text-neutral-400">{formatUptime(t.createdAt, t.status)}</td>
                <td className="px-4 py-3 text-neutral-500">
                  {t.lastCheckedAt ? new Date(t.lastCheckedAt).toLocaleTimeString() : "—"}
                </td>
                <td className="px-4 py-3">
                  <TunnelRowActions id={t.id} status={t.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function BulkButton({
  label,
  action,
  pending,
  onRun,
  danger,
}: {
  label: string;
  action: BulkAction;
  pending: BulkAction | null;
  onRun: (action: BulkAction) => void;
  danger?: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  const isPending = pending === action;

  if (danger && !confirming) {
    return (
      <button
        onClick={() => setConfirming(true)}
        disabled={pending !== null}
        className="rounded border border-red-900 px-2.5 py-1 text-xs text-red-400 hover:bg-red-950 disabled:opacity-50"
      >
        {label}
      </button>
    );
  }

  return (
    <button
      onClick={() => {
        setConfirming(false);
        onRun(action);
      }}
      disabled={pending !== null}
      className={`rounded border px-2.5 py-1 text-xs disabled:opacity-50 ${
        danger
          ? "border-red-800 bg-red-950 text-red-300 hover:bg-red-900"
          : "border-neutral-700 text-neutral-300 hover:bg-neutral-800"
      }`}
    >
      {isPending ? "Working..." : danger ? "Confirm delete" : label}
    </button>
  );
}
