"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { ConfirmButton } from "@/components/ConfirmButton";

export function TunnelRowActions({ id, status }: { id: string; status: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function del() {
    setError(null);
    try {
      const res = await fetch(`/api/v1/tunnels/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? "Failed to delete");
        return;
      }
      router.refresh();
    } catch {
      setError("Network error while contacting the panel API");
    }
  }

  async function retry() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/v1/tunnels/${id}/retry`, { method: "POST" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? "Failed to retry");
        return;
      }
      router.refresh();
    } catch {
      setError("Network error while contacting the panel API");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center justify-end gap-2">
      {status === "FAILED" && (
        <button
          onClick={retry}
          disabled={busy}
          className="rounded border border-neutral-700 px-2.5 py-1 text-xs text-neutral-300 hover:bg-neutral-800 disabled:opacity-50"
        >
          {busy ? "Retrying..." : "Retry"}
        </button>
      )}
      <ConfirmButton
        onConfirm={del}
        label="Delete"
        confirmLabel="Delete"
        pendingLabel="Deleting..."
        className="rounded border border-red-900 px-2.5 py-1 text-xs text-red-400 hover:bg-red-950"
      />
      {error && <span className="text-xs text-red-400">{error}</span>}
    </div>
  );
}
