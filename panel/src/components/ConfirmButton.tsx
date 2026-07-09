"use client";

import { useState } from "react";

/**
 * A button that requires an explicit confirm step before firing `onConfirm`
 * -- shared by every destructive action across the app (remove server,
 * delete tunnel, stop tunnel, ...) so confirmation dialogs look and behave
 * consistently instead of each page rolling its own `window.confirm`.
 */
export function ConfirmButton({
  onConfirm,
  label,
  confirmLabel = "Confirm",
  pendingLabel = "Working...",
  className = "",
  variant = "danger",
  disabled,
}: {
  onConfirm: () => Promise<void> | void;
  label: string;
  confirmLabel?: string;
  pendingLabel?: string;
  className?: string;
  variant?: "danger" | "default";
  disabled?: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);

  const base =
    variant === "danger"
      ? "border-red-900 text-red-400 hover:bg-red-950"
      : "border-neutral-700 text-neutral-300 hover:bg-neutral-800";

  if (confirming) {
    return (
      <span className="inline-flex items-center gap-2">
        <button
          type="button"
          disabled={pending}
          onClick={async () => {
            setPending(true);
            try {
              await onConfirm();
            } finally {
              setPending(false);
              setConfirming(false);
            }
          }}
          className={`rounded border px-3 py-1.5 text-xs font-medium disabled:opacity-50 ${base}`}
        >
          {pending ? pendingLabel : confirmLabel}
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => setConfirming(false)}
          className="text-xs text-neutral-500 hover:text-neutral-300"
        >
          Cancel
        </button>
      </span>
    );
  }

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => setConfirming(true)}
      className={
        className ||
        `rounded border px-3 py-1.5 text-xs font-medium disabled:opacity-50 ${base}`
      }
    >
      {label}
    </button>
  );
}
