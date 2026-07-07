"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

interface Metrics {
  hostname: string;
  cpu_percent: string;
  memory: { used_mb: string; total_mb: string; percent: string };
  network: { interface: string; rx_kbps: string; tx_kbps: string };
}

export function ServerCard({ id, name, host }: { id: string; name: string; host: string }) {
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [errored, setErrored] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      try {
        const res = await fetch(`/api/servers/${id}/metrics`, { cache: "no-store" });
        if (!res.ok) throw new Error();
        const data = (await res.json()) as Metrics;
        if (!cancelled) {
          setMetrics(data);
          setErrored(false);
        }
      } catch {
        if (!cancelled) setErrored(true);
      }
    }

    poll();
    const interval = setInterval(poll, 5000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [id]);

  return (
    <Link
      href={`/servers/${id}`}
      className="block rounded-lg border border-neutral-800 bg-neutral-900 p-5 transition hover:border-neutral-700"
    >
      <div className="mb-3 flex items-center justify-between">
        <span className="font-medium text-neutral-100">{name}</span>
        <StatusDot ok={!errored && !!metrics} />
      </div>
      <p className="mb-3 text-xs text-neutral-500">{host}</p>

      {errored && <p className="text-xs text-red-400">Agent unreachable</p>}
      {!errored && !metrics && <p className="text-xs text-neutral-500">Loading...</p>}
      {metrics && (
        <div className="grid grid-cols-3 gap-2 text-xs text-neutral-300">
          <Stat label="CPU" value={fmt(metrics.cpu_percent, "%")} />
          <Stat label="RAM" value={fmt(metrics.memory.percent, "%")} />
          <Stat
            label="Net"
            value={
              metrics.network.rx_kbps === "NA"
                ? "NA"
                : `${metrics.network.rx_kbps}/${metrics.network.tx_kbps} KB/s`
            }
          />
        </div>
      )}
    </Link>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-neutral-500">{label}</div>
      <div className="font-medium text-neutral-200">{value}</div>
    </div>
  );
}

function StatusDot({ ok }: { ok: boolean }) {
  return (
    <span
      className={`h-2 w-2 rounded-full ${ok ? "bg-green-500" : "bg-red-500"}`}
      title={ok ? "Reachable" : "Unreachable"}
    />
  );
}

function fmt(value: string, suffix: string) {
  return value === "NA" ? "NA" : `${value}${suffix}`;
}
