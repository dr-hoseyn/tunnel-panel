"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { ConfirmButton } from "@/components/ConfirmButton";

export function RestoreBackupButton({ id }: { id: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  async function restore() {
    setError(null);
    const res = await fetch(`/api/v1/backups/${id}/restore`, { method: "POST" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(data.error ?? "Failed to restore backup");
      return;
    }
    router.push(`/tunnels/${data.tunnel.id}`);
  }

  return (
    <div>
      <ConfirmButton
        onConfirm={restore}
        label="Restore as new tunnel"
        confirmLabel="Restore"
        pendingLabel="Deploying..."
        variant="default"
      />
      {error && <p className="mt-1 text-xs text-red-400">{error}</p>}
    </div>
  );
}
