"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { ConfirmButton } from "@/components/ConfirmButton";

interface Props {
  id: string;
  name: string;
  location: string | null;
  isAdmin: boolean;
}

interface AgentInfo {
  version: string;
  commit: string;
  build_date: string;
  os: string;
  arch: string;
  go_version: string;
  uptime_seconds: number;
  supported_drivers: string[];
}

interface UpdateCheck {
  currentVersion: string | null;
  latestVersion: string | null;
  updateAvailable: boolean;
  checkedAt: string | null;
  fromCache: boolean;
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const parts: string[] = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes || parts.length === 0) parts.push(`${minutes}m`);
  return parts.join(" ");
}

export function ServerActions({ id, name, location, isAdmin }: Props) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [agentInfo, setAgentInfo] = useState<AgentInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [updateCheck, setUpdateCheck] = useState<UpdateCheck | null>(null);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [downloadingLogs, setDownloadingLogs] = useState(false);

  async function testConnection() {
    setBusy(true);
    setTestResult(null);
    setError(null);
    try {
      const res = await fetch(`/api/v1/servers/${id}/test-connection`, { method: "POST" });
      const data = await res.json();
      if (data.ok) {
        setAgentInfo(data.info as AgentInfo);
        setTestResult(`Reachable (${data.latencyMs}ms)`);
        router.refresh();
      } else {
        setAgentInfo(null);
        setError(data.error ?? "Connection test failed");
      }
    } catch {
      setError("Network error while contacting the panel API");
    } finally {
      setBusy(false);
    }
  }

  async function restartAgent() {
    setError(null);
    try {
      const res = await fetch(`/api/v1/servers/${id}/restart-agent`, { method: "POST" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? "Failed to restart the agent");
        return;
      }
      setTestResult("Agent restart requested.");
    } catch {
      setError("Network error while contacting the panel API");
    }
  }

  async function rotateToken() {
    setError(null);
    try {
      const res = await fetch(`/api/v1/servers/${id}/rotate-token`, { method: "POST" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? "Failed to rotate the token");
        return;
      }
      setTestResult("Agent token rotated.");
    } catch {
      setError("Network error while contacting the panel API");
    }
  }

  async function stopAgent() {
    setError(null);
    try {
      const res = await fetch(`/api/v1/servers/${id}/agent-stop`, { method: "POST" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? "Failed to stop the agent");
        return;
      }
      setTestResult("Agent stop requested. It will not come back on its own -- it needs to be started again on the box (or a reboot).");
    } catch {
      setError("Network error while contacting the panel API");
    }
  }

  async function updateAgent() {
    setError(null);
    try {
      const res = await fetch(`/api/v1/servers/${id}/agent-update`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? "Failed to update the agent");
        return;
      }
      if (data.status === "updated") {
        setTestResult(`Agent updated: ${data.previous_version ?? "?"} -> ${data.new_version ?? "?"}. Restarting...`);
        setUpdateCheck(null);
        router.refresh();
      } else if (data.status === "already up to date") {
        setTestResult(`Agent is already up to date (${data.current_version}).`);
      } else {
        setTestResult(`Update: ${data.status ?? "requested"}`);
      }
    } catch {
      setError("Network error while contacting the panel API");
    }
  }

  async function checkForUpdates() {
    setCheckingUpdate(true);
    setError(null);
    try {
      const res = await fetch(`/api/v1/servers/${id}/check-agent-update`, { method: "POST" });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setError(data.error ?? "Failed to check for updates");
        return;
      }
      setUpdateCheck({
        currentVersion: data.currentVersion,
        latestVersion: data.latestVersion,
        updateAvailable: data.updateAvailable,
        checkedAt: data.checkedAt,
        fromCache: data.fromCache,
      });
    } catch {
      setError("Network error while contacting the panel API");
    } finally {
      setCheckingUpdate(false);
    }
  }

  async function downloadLogs() {
    setDownloadingLogs(true);
    setError(null);
    try {
      const res = await fetch(`/api/v1/servers/${id}/agent-logs?lines=1000`);
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setError(data.error ?? "Failed to fetch agent logs");
        return;
      }
      const lines: string[] = data.lines ?? [];
      const blob = new Blob([lines.join("\n") + "\n"], { type: "text/plain" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${name.replace(/[^a-z0-9-_]+/gi, "_")}-agent-logs.txt`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      setError("Network error while contacting the panel API");
    } finally {
      setDownloadingLogs(false);
    }
  }

  async function removeServer() {
    setError(null);
    try {
      const res = await fetch(`/api/servers/${id}`, { method: "DELETE" });
      if (res.status === 204) {
        router.push("/servers");
        router.refresh();
        return;
      }
      const data = await res.json().catch(() => ({}));
      setError(data.error ?? "Failed to remove server");
    } catch {
      setError("Network error while contacting the panel API");
    }
  }

  async function saveEdit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const form = new FormData(e.currentTarget);
    const res = await fetch(`/api/servers/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: form.get("name"), location: form.get("location") }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.error ?? "Failed to save changes");
      return;
    }
    setEditing(false);
    router.refresh();
  }

  if (editing) {
    return (
      <form onSubmit={saveEdit} className="mb-4 flex flex-wrap items-end gap-2 rounded-lg border border-neutral-800 bg-neutral-900 p-3">
        <div>
          <label className="mb-1 block text-xs text-neutral-400">Name</label>
          <input
            name="name"
            defaultValue={name}
            required
            className="rounded border border-neutral-700 bg-neutral-950 px-2 py-1.5 text-sm text-neutral-100 focus:border-neutral-500 focus:outline-none"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs text-neutral-400">Location</label>
          <input
            name="location"
            defaultValue={location ?? ""}
            placeholder="e.g. Germany"
            className="rounded border border-neutral-700 bg-neutral-950 px-2 py-1.5 text-sm text-neutral-100 focus:border-neutral-500 focus:outline-none"
          />
        </div>
        <button type="submit" className="rounded bg-neutral-100 px-3 py-1.5 text-xs font-medium text-neutral-900 hover:bg-white">
          Save
        </button>
        <button type="button" onClick={() => setEditing(false)} className="text-xs text-neutral-500 hover:text-neutral-300">
          Cancel
        </button>
      </form>
    );
  }

  return (
    <div className="mb-4 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={testConnection}
          disabled={busy}
          className="rounded border border-neutral-700 px-3 py-1.5 text-xs font-medium text-neutral-300 hover:bg-neutral-800 disabled:opacity-50"
        >
          {busy ? "Testing..." : "Test connection"}
        </button>
        <button
          onClick={() => setEditing(true)}
          className="rounded border border-neutral-700 px-3 py-1.5 text-xs font-medium text-neutral-300 hover:bg-neutral-800"
        >
          Edit
        </button>
        <button
          onClick={downloadLogs}
          disabled={downloadingLogs}
          className="rounded border border-neutral-700 px-3 py-1.5 text-xs font-medium text-neutral-300 hover:bg-neutral-800 disabled:opacity-50"
        >
          {downloadingLogs ? "Downloading..." : "Download agent logs"}
        </button>
        <button
          onClick={checkForUpdates}
          disabled={checkingUpdate}
          className="rounded border border-neutral-700 px-3 py-1.5 text-xs font-medium text-neutral-300 hover:bg-neutral-800 disabled:opacity-50"
        >
          {checkingUpdate ? "Checking..." : "Check for updates"}
        </button>
        {isAdmin && (
          <>
            <ConfirmButton
              onConfirm={restartAgent}
              label="Restart agent"
              confirmLabel="Restart"
              pendingLabel="Restarting..."
              variant="default"
            />
            <ConfirmButton
              onConfirm={stopAgent}
              label="Stop agent"
              confirmLabel="Stop (won't self-restart)"
              pendingLabel="Stopping..."
              variant="danger"
            />
            <ConfirmButton
              onConfirm={updateAgent}
              label={updateCheck?.updateAvailable ? `Update agent (${updateCheck.latestVersion} available)` : "Update agent"}
              confirmLabel="Download & install"
              pendingLabel="Updating..."
              variant={updateCheck?.updateAvailable ? "danger" : "default"}
            />
            <ConfirmButton
              onConfirm={rotateToken}
              label="Rotate token"
              confirmLabel="Rotate"
              pendingLabel="Rotating..."
              variant="default"
            />
          </>
        )}
        <ConfirmButton onConfirm={removeServer} label="Remove" confirmLabel="Delete server" pendingLabel="Removing..." />
      </div>

      {updateCheck && (
        <p className="text-xs text-neutral-500">
          {updateCheck.updateAvailable
            ? `Update available: ${updateCheck.currentVersion ?? "unknown"} -> ${updateCheck.latestVersion}`
            : `Up to date (${updateCheck.currentVersion ?? "unknown"}).`}{" "}
          {updateCheck.fromCache && "(cached result)"}
        </p>
      )}

      {agentInfo && (
        <div className="grid grid-cols-2 gap-x-6 gap-y-1 rounded-lg border border-neutral-800 bg-neutral-900 p-3 text-xs text-neutral-400 sm:grid-cols-4">
          <div>
            <div className="text-neutral-500">Version</div>
            <div className="text-neutral-200">{agentInfo.version}</div>
          </div>
          <div>
            <div className="text-neutral-500">Commit</div>
            <div className="text-neutral-200">{agentInfo.commit}</div>
          </div>
          <div>
            <div className="text-neutral-500">Build date</div>
            <div className="text-neutral-200">{agentInfo.build_date}</div>
          </div>
          <div>
            <div className="text-neutral-500">OS / Arch</div>
            <div className="text-neutral-200">
              {agentInfo.os}/{agentInfo.arch}
            </div>
          </div>
          <div>
            <div className="text-neutral-500">Go version</div>
            <div className="text-neutral-200">{agentInfo.go_version}</div>
          </div>
          <div>
            <div className="text-neutral-500">Uptime</div>
            <div className="text-neutral-200">{formatUptime(agentInfo.uptime_seconds)}</div>
          </div>
          <div className="col-span-2 sm:col-span-2">
            <div className="text-neutral-500">Supported drivers</div>
            <div className="text-neutral-200">{agentInfo.supported_drivers.join(", ") || "none"}</div>
          </div>
        </div>
      )}

      {testResult && <p className="text-xs text-green-400">{testResult}</p>}
      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  );
}
