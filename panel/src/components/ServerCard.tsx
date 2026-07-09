"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Cpu, MemoryStick, Network, Cable } from "lucide-react";

interface Metrics {
  hostname: string;
  cpu_percent: string;
  memory: { used_mb: string; total_mb: string; percent: string };
  network: { interface: string; rx_kbps: string; tx_kbps: string };
}

export function ServerCard({
  id,
  name,
  host,
  location,
  agentOs,
  agentVersion,
  activeTunnels,
}: {
  id: string;
  name: string;
  host: string;
  location: string | null;
  agentOs: string | null;
  agentVersion: string | null;
  activeTunnels: number;
}) {
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

  const reachable = !errored && !!metrics;

  return (
    <Link
      href={`/servers/${id}`}
      className="block rounded-lg border border-neutral-800 bg-neutral-900 p-5 transition hover:border-neutral-700"
    >
      <div className="mb-1 flex items-center justify-between">
        <span className="font-medium text-neutral-100">{name}</span>
        <StatusDot ok={reachable} />
      </div>
      <p className="mb-3 text-xs text-neutral-500">
        {host}
        {location ? ` · ${location}` : ""}
        {agentOs ? ` · ${agentOs}` : ""}
      </p>

      {errored && <p className="text-xs text-red-400">Agent unreachable</p>}
      {!errored && !metrics && <p className="text-xs text-neutral-500">Loading...</p>}
      {metrics && (
        <div className="grid grid-cols-3 gap-2 text-xs text-neutral-300">
          <Stat icon={Cpu} label="CPU" value={fmt(metrics.cpu_percent, "%")} />
          <Stat icon={MemoryStick} label="RAM" value={fmt(metrics.memory.percent, "%")} />
          <Stat
            icon={Network}
            label="Net"
            value={
              metrics.network.rx_kbps === "NA"
                ? "NA"
                : `${metrics.network.rx_kbps}/${metrics.network.tx_kbps} KB/s`
            }
          />
        </div>
      )}

      <div className="mt-3 flex items-center gap-1.5 border-t border-neutral-800 pt-3 text-xs text-neutral-500">
        <Cable className="h-3.5 w-3.5" aria-hidden="true" />
        {activeTunnels} active {activeTunnels === 1 ? "tunnel" : "tunnels"}
        {agentVersion && <span className="ml-auto">agent {agentVersion}</span>}
      </div>
    </Link>
  );
}

function Stat({
  icon: Icon,
  label,
  value,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <Icon className="h-3.5 w-3.5 text-neutral-500" aria-hidden="true" />
      <div>
        <div className="text-neutral-500">{label}</div>
        <div className="font-medium text-neutral-200">{value}</div>
      </div>
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
