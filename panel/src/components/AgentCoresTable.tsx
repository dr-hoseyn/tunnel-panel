"use client";

import { useEffect, useState } from "react";
import { ConfirmButton } from "@/components/ConfirmButton";

interface CoreReport {
  core: string;
  path: string;
  status: string;
  has_previous: boolean;
}

type RowAction = "Verify" | "Reinstall" | "Rollback";

/** Shows which tunnel cores (backhaul/rathole/gost/hysteria2) this agent
 * build supports and whether each one's binary is actually installed and
 * healthy on the box -- fetched once on mount (core installs rarely change,
 * so this isn't worth polling every few seconds the way metrics/tunnels
 * are) plus a manual refresh button.
 *
 * Per-row actions: Verify (re-check just this core, any authenticated
 * role), and Reinstall/Rollback (ADMIN-only, mutate the core's binary --
 * see the panel routes under agent-cores/[core]/* and the agent's own
 * tunnels.ReinstallCore/RollbackCore for what these do and, importantly,
 * do NOT do: neither restarts any tunnel already using this core). */
export function AgentCoresTable({ id, isAdmin }: { id: string; isAdmin: boolean }) {
  const [cores, setCores] = useState<CoreReport[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // Bumped by the manual "Refresh" button to re-trigger the effect below --
  // core installs rarely change, so this isn't worth polling on an
  // interval the way ServerDetail's metrics/tunnels are.
  const [reloadIndex, setReloadIndex] = useState(0);
  // Per-row action state, keyed by core name -- lets one row's Verify/
  // Reinstall/Rollback be in flight without disabling every other row's
  // buttons or the table's own refresh.
  const [rowBusy, setRowBusy] = useState<Record<string, RowAction | undefined>>({});
  const [rowError, setRowError] = useState<Record<string, string | undefined>>({});

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

  function patchRow(core: string, report: CoreReport) {
    setCores((prev) => (prev ? prev.map((c) => (c.core === core ? report : c)) : prev));
  }

  async function runRowAction(core: string, action: RowAction, url: string, method: "GET" | "POST") {
    setRowBusy((prev) => ({ ...prev, [core]: action }));
    setRowError((prev) => ({ ...prev, [core]: undefined }));
    try {
      const res = await fetch(url, { method, cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        setRowError((prev) => ({ ...prev, [core]: data.error ?? `Failed to ${action.toLowerCase()} this core.` }));
        return;
      }
      if (data.report) patchRow(core, data.report as CoreReport);
    } catch {
      setRowError((prev) => ({ ...prev, [core]: "Network error while contacting the panel API" }));
    } finally {
      setRowBusy((prev) => ({ ...prev, [core]: undefined }));
    }
  }

  const verify = (core: string) =>
    runRowAction(core, "Verify", `/api/v1/servers/${id}/agent-cores/${encodeURIComponent(core)}/verify`, "GET");
  const reinstall = (core: string) =>
    runRowAction(core, "Reinstall", `/api/v1/servers/${id}/agent-cores/${encodeURIComponent(core)}/reinstall`, "POST");
  const rollback = (core: string) =>
    runRowAction(core, "Rollback", `/api/v1/servers/${id}/agent-cores/${encodeURIComponent(core)}/rollback`, "POST");

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
                <th className="px-4 py-2 font-normal">Actions</th>
              </tr>
            </thead>
            <tbody>
              {cores.map((c) => {
                const busy = rowBusy[c.core];
                return (
                  <tr key={c.core} className="border-t border-neutral-800 align-top">
                    <td className="px-4 py-2 text-neutral-300">{c.core}</td>
                    <td className="px-4 py-2">
                      <span className={statusClass(c.status)}>{c.status}</span>
                    </td>
                    <td className="px-4 py-2 font-mono text-xs text-neutral-500">{c.path}</td>
                    <td className="px-4 py-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          onClick={() => verify(c.core)}
                          disabled={!!busy}
                          className="rounded border border-neutral-700 px-2 py-1 text-xs font-medium text-neutral-300 hover:bg-neutral-800 disabled:opacity-50"
                        >
                          {busy === "Verify" ? "Verifying..." : "Verify"}
                        </button>
                        {isAdmin && (
                          <>
                            <ConfirmButton
                              onConfirm={() => reinstall(c.core)}
                              label="Reinstall"
                              confirmLabel="Force reinstall"
                              pendingLabel="Reinstalling..."
                              variant="danger"
                              disabled={!!busy}
                            />
                            <ConfirmButton
                              onConfirm={() => rollback(c.core)}
                              label="Rollback"
                              confirmLabel="Roll back"
                              pendingLabel="Rolling back..."
                              variant="danger"
                              disabled={!c.has_previous || !!busy}
                            />
                          </>
                        )}
                      </div>
                      {isAdmin && !c.has_previous && (
                        <p className="mt-1 text-xs text-neutral-600">No previous version to roll back to.</p>
                      )}
                      {rowError[c.core] && <p className="mt-1 text-xs text-red-400">{rowError[c.core]}</p>}
                    </td>
                  </tr>
                );
              })}
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
