"use client";

import { useEffect, useState } from "react";

interface CoreReport {
  core: string;
  path: string;
  status: string;
}

/** Shows which tunnel cores (backhaul/rathole/gost/hysteria2) this agent
 * build supports and whether each one's binary is actually installed and
 * healthy on the box -- fetched once on mount (core installs rarely change,
 * so this isn't worth polling every few seconds the way metrics/tunnels
 * are) plus a manual refresh button. */
export function AgentCoresTable({ id }: { id: string }) {
  const [cores, setCores] = useState<CoreReport[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // Bumped by the manual "Refresh" button to re-trigger the effect below --
  // core installs rarely change, so this isn't worth polling on an
  // interval the way ServerDetail's metrics/tunnels are.
  const [reloadIndex, setReloadIndex] = useState(0);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`/api/v1/servers/${id}/agent-cores`, { cache: "no-store" });
        const data = await res.json();
        if (!res.ok || !data.ok) {
          if (!cancelled) setError(data.error ?? "Could not fetch installed core versions.");
          return;
        }
        if (!cancelled) setCores(data.cores as CoreReport[]);
      } catch {
        if (!cancelled) setError("Network error while contacting the panel API");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [id, reloadIndex]);

  return (
    <section>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-medium text-neutral-300">Tunnel cores</h2>
        <button
          onClick={() => setReloadIndex((n) => n + 1)}
          disabled={loading}
          className="rounded border border-neutral-700 px-2 py-1 text-xs font-medium text-neutral-300 hover:bg-neutral-800 disabled:opacity-50"
        >
          {loading ? "Refreshing..." : "Refresh"}
        </button>
      </div>
      {error && <p className="text-sm text-red-400">{error}</p>}
      {!error && !cores && <p className="text-sm text-neutral-500">Loading...</p>}
      {cores && cores.length === 0 && <p className="text-sm text-neutral-500">This agent build supports no cores.</p>}
      {cores && cores.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-neutral-800">
          <table className="w-full text-sm">
            <thead className="bg-neutral-900 text-left text-neutral-400">
              <tr>
                <th className="px-4 py-2 font-normal">Core</th>
                <th className="px-4 py-2 font-normal">Status</th>
                <th className="px-4 py-2 font-normal">Path</th>
              </tr>
            </thead>
            <tbody>
              {cores.map((c) => (
                <tr key={c.core} className="border-t border-neutral-800">
                  <td className="px-4 py-2 text-neutral-300">{c.core}</td>
                  <td className="px-4 py-2">
                    <span className={statusClass(c.status)}>{c.status}</span>
                  </td>
                  <td className="px-4 py-2 font-mono text-xs text-neutral-500">{c.path}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function statusClass(status: string): string {
  if (status === "installed and healthy") return "text-green-400";
  if (status === "installed but broken") return "text-yellow-400";
  return "text-neutral-500";
}
