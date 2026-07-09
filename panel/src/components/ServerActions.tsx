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

export function ServerActions({ id, name, location, isAdmin }: Props) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function testConnection() {
    setBusy(true);
    setTestResult(null);
    setError(null);
    try {
      const res = await fetch(`/api/v1/servers/${id}/test-connection`, { method: "POST" });
      const data = await res.json();
      if (data.ok) {
        setTestResult(`Reachable (${data.latencyMs}ms) -- agent ${data.info.version} on ${data.info.os}/${data.info.arch}`);
        router.refresh();
      } else {
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
    const res = await fetch(`/api/v1/servers/${id}/restart-agent`, { method: "POST" });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.error ?? "Failed to restart the agent");
      return;
    }
    setTestResult("Agent restart requested.");
  }

  async function rotateToken() {
    setError(null);
    const res = await fetch(`/api/v1/servers/${id}/rotate-token`, { method: "POST" });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.error ?? "Failed to rotate the token");
      return;
    }
    setTestResult("Agent token rotated.");
  }

  async function removeServer() {
    setError(null);
    const res = await fetch(`/api/servers/${id}`, { method: "DELETE" });
    if (res.status === 204) {
      router.push("/servers");
      router.refresh();
      return;
    }
    const data = await res.json().catch(() => ({}));
    setError(data.error ?? "Failed to remove server");
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
      {testResult && <p className="text-xs text-green-400">{testResult}</p>}
      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  );
}
