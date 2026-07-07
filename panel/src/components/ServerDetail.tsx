"use client";

import { useEffect, useState } from "react";

interface Metrics {
  hostname: string;
  cpu_percent: string;
  memory: { used_mb: string; total_mb: string; percent: string };
  network: { interface: string; rx_kbps: string; tx_kbps: string };
  timestamp: string;
}

interface Tunnel {
  engine: string;
  name: string;
  role: string;
  active: boolean;
}

interface TunnelsResponse {
  hostname: string;
  tunnels: Tunnel[];
  gost: { active: boolean; entities: number };
}

export function ServerDetail({ id }: { id: string }) {
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [tunnels, setTunnels] = useState<TunnelsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      try {
        const [metricsRes, tunnelsRes] = await Promise.all([
          fetch(`/api/servers/${id}/metrics`, { cache: "no-store" }),
          fetch(`/api/servers/${id}/tunnels`, { cache: "no-store" }),
        ]);
        if (!metricsRes.ok || !tunnelsRes.ok) throw new Error();
        const metricsData = (await metricsRes.json()) as Metrics;
        const tunnelsData = (await tunnelsRes.json()) as TunnelsResponse;
        if (!cancelled) {
          setMetrics(metricsData);
          setTunnels(tunnelsData);
          setError(null);
        }
      } catch {
        if (!cancelled) setError("Could not reach this server's agent.");
      }
    }

    poll();
    const interval = setInterval(poll, 5000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [id]);

  if (error) {
    return <p className="text-sm text-red-400">{error}</p>;
  }
  if (!metrics || !tunnels) {
    return <p className="text-sm text-neutral-500">Loading...</p>;
  }

  return (
    <div className="space-y-6">
      <section className="grid grid-cols-3 gap-4">
        <MetricCard label="CPU" value={fmt(metrics.cpu_percent, "%")} />
        <MetricCard
          label="RAM"
          value={fmt(metrics.memory.percent, "%")}
          sub={`${metrics.memory.used_mb}/${metrics.memory.total_mb} MB`}
        />
        <MetricCard
          label={`Network (${metrics.network.interface})`}
          value={
            metrics.network.rx_kbps === "NA"
              ? "NA"
              : `${metrics.network.rx_kbps} / ${metrics.network.tx_kbps} KB/s`
          }
        />
      </section>

      <section>
        <h2 className="mb-3 text-sm font-medium text-neutral-300">Tunnels</h2>
        {tunnels.tunnels.length === 0 ? (
          <p className="text-sm text-neutral-500">No tunnels configured on this server.</p>
        ) : (
          <div className="overflow-hidden rounded-lg border border-neutral-800">
            <table className="w-full text-sm">
              <thead className="bg-neutral-900 text-left text-neutral-400">
                <tr>
                  <th className="px-4 py-2 font-normal">Engine</th>
                  <th className="px-4 py-2 font-normal">Name</th>
                  <th className="px-4 py-2 font-normal">Role</th>
                  <th className="px-4 py-2 font-normal">Status</th>
                </tr>
              </thead>
              <tbody>
                {tunnels.tunnels.map((t) => (
                  <tr key={`${t.engine}-${t.name}`} className="border-t border-neutral-800">
                    <td className="px-4 py-2 text-neutral-300">{t.engine}</td>
                    <td className="px-4 py-2 text-neutral-300">{t.name}</td>
                    <td className="px-4 py-2 text-neutral-300">{t.role}</td>
                    <td className="px-4 py-2">
                      <span className={t.active ? "text-green-400" : "text-red-400"}>
                        {t.active ? "active" : "inactive"}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-3 text-xs text-neutral-500">
          GOST: {tunnels.gost.active ? "active" : "inactive"} ({tunnels.gost.entities} services +
          chains configured)
        </p>
      </section>
    </div>
  );
}

function MetricCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-4">
      <div className="text-xs text-neutral-500">{label}</div>
      <div className="mt-1 text-xl font-semibold text-neutral-100">{value}</div>
      {sub && <div className="mt-0.5 text-xs text-neutral-500">{sub}</div>}
    </div>
  );
}

function fmt(value: string, suffix: string) {
  return value === "NA" ? "NA" : `${value}${suffix}`;
}
