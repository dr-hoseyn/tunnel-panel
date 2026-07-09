"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Play, Square, RotateCw, ScrollText, Archive, RefreshCw, AlertTriangle, Loader2 } from "lucide-react";
import { TunnelStatusBadge } from "@/components/TunnelStatusBadge";
import { ConfirmButton } from "@/components/ConfirmButton";
import { TrafficChart } from "@/components/TrafficChart";

interface ServerRef {
  id: string;
  name: string;
  host: string;
}

interface TunnelData {
  id: string;
  name: string;
  core: string;
  status: string;
  createdAt: string;
  lastCheckedAt: string | null;
  lastRestartAt: string | null;
  sourceServer: ServerRef;
  destServer: ServerRef;
  lastError: string | null;
}

interface StatPoint {
  timestamp: string;
  rxBytes: number;
  txBytes: number;
  latencyMs: number | null;
  connections: number | null;
}

const TABS = ["Overview", "Performance", "Logs"] as const;
type Tab = (typeof TABS)[number];

export function TunnelDetailView({ tunnel, stats }: { tunnel: TunnelData; stats: StatPoint[] }) {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("Overview");
  const [status, setStatus] = useState(tunnel.status);
  const [lastCheckedAt, setLastCheckedAt] = useState(tunnel.lastCheckedAt);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [backupMessage, setBackupMessage] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);

  useEffect(() => {
    const source = new EventSource(`/api/v1/tunnels/${tunnel.id}/stream`);
    source.addEventListener("update", (e) => {
      const data = JSON.parse((e as MessageEvent).data) as { status: string; lastCheckedAt: string | null };
      setStatus(data.status);
      setLastCheckedAt(data.lastCheckedAt);
    });
    return () => source.close();
  }, [tunnel.id]);

  async function runAction(action: "start" | "stop" | "restart") {
    setPendingAction(action);
    setActionError(null);
    try {
      const res = await fetch(`/api/v1/tunnels/${tunnel.id}/${action}`, { method: "POST" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setActionError(data.error ?? `Failed to ${action} tunnel`);
        return;
      }
      setStatus(action === "stop" ? "STOPPED" : "DEPLOYING");
    } catch {
      setActionError("Network error while contacting the panel API");
    } finally {
      setPendingAction(null);
    }
  }

  async function retryDeploy() {
    setRetrying(true);
    setActionError(null);
    try {
      const res = await fetch(`/api/v1/tunnels/${tunnel.id}/retry`, { method: "POST" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setActionError(data.error ?? "Failed to retry deployment");
        return;
      }
      setStatus("DEPLOYING");
      router.refresh();
    } finally {
      setRetrying(false);
    }
  }

  async function createBackup() {
    setBackupMessage(null);
    const res = await fetch(`/api/v1/tunnels/${tunnel.id}/backup`, { method: "POST" });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setActionError(data.error ?? "Failed to create backup");
      return;
    }
    setBackupMessage("Backup created -- see the Backups page to restore it.");
  }

  async function deleteTunnel() {
    const res = await fetch(`/api/v1/tunnels/${tunnel.id}`, { method: "DELETE" });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setActionError(data.error ?? "Failed to delete tunnel");
      return;
    }
    router.push("/tunnels");
    router.refresh();
  }

  return (
    <div>
      <div className="mb-1 flex items-center gap-3">
        <h1 className="text-lg font-semibold">{tunnel.name}</h1>
        <TunnelStatusBadge status={status} />
      </div>
      <p className="mb-6 text-sm text-neutral-500">
        {tunnel.core} · {tunnel.sourceServer.name} &rarr; {tunnel.destServer.name} · created{" "}
        {new Date(tunnel.createdAt).toLocaleDateString()}
      </p>

      {status === "FAILED" && (
        <div className="mb-6 flex items-start gap-3 rounded-lg border border-red-900 bg-red-950/50 p-4">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-red-300">Deployment failed</p>
            <p className="mt-1 text-xs text-red-400/90">{tunnel.lastError ?? "See the Logs tab for detail."}</p>
          </div>
          <button
            onClick={retryDeploy}
            disabled={retrying}
            className="flex shrink-0 items-center gap-1.5 rounded border border-red-800 px-3 py-1.5 text-xs font-medium text-red-300 hover:bg-red-900 disabled:opacity-50"
          >
            <RefreshCw className="h-3.5 w-3.5" /> {retrying ? "Retrying..." : "Retry"}
          </button>
        </div>
      )}

      {status === "DEPLOYING" && (
        <div className="mb-6 flex items-center gap-2 rounded-lg border border-blue-900 bg-blue-950/40 px-4 py-3 text-xs text-blue-300">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Deploying -- if this doesn&rsquo;t resolve within a few minutes it will automatically be marked Failed so it can be
          retried.
        </div>
      )}

      <div className="mb-6 flex flex-wrap items-center gap-2">
        <ActionButton icon={Play} label="Start" onClick={() => runAction("start")} pending={pendingAction === "start"} />
        <ActionButton icon={Square} label="Stop" onClick={() => runAction("stop")} pending={pendingAction === "stop"} />
        <ActionButton icon={RotateCw} label="Restart" onClick={() => runAction("restart")} pending={pendingAction === "restart"} />
        <button
          onClick={() => setTab("Logs")}
          className="flex items-center gap-1.5 rounded border border-neutral-700 px-3 py-1.5 text-xs font-medium text-neutral-300 hover:bg-neutral-800"
        >
          <ScrollText className="h-3.5 w-3.5" /> View logs
        </button>
        <button
          onClick={createBackup}
          className="flex items-center gap-1.5 rounded border border-neutral-700 px-3 py-1.5 text-xs font-medium text-neutral-300 hover:bg-neutral-800"
        >
          <Archive className="h-3.5 w-3.5" /> Backup
        </button>
        <ConfirmButton
          onConfirm={deleteTunnel}
          label="Delete"
          confirmLabel="Delete tunnel"
          pendingLabel="Deleting..."
        />
      </div>
      {actionError && <p className="mb-4 text-xs text-red-400">{actionError}</p>}
      {backupMessage && <p className="mb-4 text-xs text-green-400">{backupMessage}</p>}

      <div className="mb-6 flex gap-1 border-b border-neutral-800 text-sm">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`border-b-2 px-3 py-2 ${
              tab === t ? "border-neutral-100 text-neutral-100" : "border-transparent text-neutral-500 hover:text-neutral-300"
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === "Overview" && (
        <dl className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-3">
          <Info label="Status" value={status} />
          <Info label="Core" value={tunnel.core} />
          <Info label="Source" value={`${tunnel.sourceServer.name} (${tunnel.sourceServer.host})`} link={`/servers/${tunnel.sourceServer.id}`} />
          <Info label="Destination" value={`${tunnel.destServer.name} (${tunnel.destServer.host})`} link={`/servers/${tunnel.destServer.id}`} />
          <Info label="Created" value={new Date(tunnel.createdAt).toLocaleString()} />
          <Info label="Last check" value={lastCheckedAt ? new Date(lastCheckedAt).toLocaleString() : "—"} />
          <Info label="Last restart" value={tunnel.lastRestartAt ? new Date(tunnel.lastRestartAt).toLocaleString() : "—"} />
        </dl>
      )}

      {tab === "Performance" && (
        <div>
          <TrafficChart samples={stats} />
          {stats.length > 0 && (
            <div className="mt-4 grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
              <Info label="Latest RX" value={formatBytes(stats[stats.length - 1].rxBytes)} />
              <Info label="Latest TX" value={formatBytes(stats[stats.length - 1].txBytes)} />
              <Info label="Latency" value={stats[stats.length - 1].latencyMs ? `${stats[stats.length - 1].latencyMs}ms` : "—"} />
              <Info label="Connections" value={stats[stats.length - 1].connections?.toString() ?? "—"} />
            </div>
          )}
        </div>
      )}

      {tab === "Logs" && <LogsTail tunnelId={tunnel.id} />}
    </div>
  );
}

function ActionButton({
  icon: Icon,
  label,
  onClick,
  pending,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  onClick: () => void;
  pending: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={pending}
      className="flex items-center gap-1.5 rounded border border-neutral-700 px-3 py-1.5 text-xs font-medium text-neutral-300 hover:bg-neutral-800 disabled:opacity-50"
    >
      <Icon className="h-3.5 w-3.5" /> {pending ? `${label}ing...` : label}
    </button>
  );
}

function Info({ label, value, link }: { label: string; value: string; link?: string }) {
  return (
    <div>
      <dt className="text-xs text-neutral-500">{label}</dt>
      <dd className="text-neutral-200">
        {link ? (
          <a href={link} className="hover:underline">
            {value}
          </a>
        ) : (
          value
        )}
      </dd>
    </div>
  );
}

function formatBytes(value: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let n = value;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(1)} ${units[i]}`;
}

interface LogLine {
  side: string;
  server: string;
  line: string;
}

function LogsTail({ tunnelId }: { tunnelId: string }) {
  const [lines, setLines] = useState<LogLine[]>([]);
  const [connected, setConnected] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const source = new EventSource(`/api/v1/tunnels/${tunnelId}/logs/stream`);
    source.addEventListener("line", (e) => {
      const data = JSON.parse((e as MessageEvent).data) as LogLine;
      setConnected(true);
      setLines((prev) => [...prev.slice(-500), data]);
    });
    source.addEventListener("side-error", (e) => {
      const data = JSON.parse((e as MessageEvent).data) as { side: string; server: string; message: string };
      setLines((prev) => [...prev.slice(-500), { side: data.side, server: data.server, line: `[error] ${data.message}` }]);
    });
    return () => source.close();
  }, [tunnelId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [lines]);

  return (
    <div>
      <p className="mb-2 text-xs text-neutral-500">{connected ? "Live -- polling both agents every ~1.5s." : "Connecting..."}</p>
      <div className="h-96 overflow-y-auto rounded-lg border border-neutral-800 bg-neutral-950 p-3 font-mono text-xs">
        {lines.length === 0 && <p className="text-neutral-600">No log lines yet.</p>}
        {lines.map((l, i) => (
          <div key={i} className="text-neutral-400">
            <span className="text-neutral-600">[{l.side === "source" ? l.server : l.server}]</span> {l.line}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
