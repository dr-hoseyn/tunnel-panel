"use client";

import { useState } from "react";

export function ChangePasswordForm() {
  const [message, setMessage] = useState<{ type: "ok" | "error"; text: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSubmitting(true);
    setMessage(null);
    const form = new FormData(e.currentTarget);
    const res = await fetch("/api/v1/settings/change-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        currentPassword: form.get("currentPassword"),
        newPassword: form.get("newPassword"),
      }),
    });
    const data = await res.json().catch(() => ({}));
    setSubmitting(false);
    if (!res.ok) {
      setMessage({ type: "error", text: data.error ?? "Failed to change password" });
      return;
    }
    setMessage({ type: "ok", text: "Password updated." });
    (e.target as HTMLFormElement).reset();
  }

  return (
    <form onSubmit={submit} className="max-w-sm space-y-3">
      <div>
        <label className="mb-1 block text-xs text-neutral-400">Current password</label>
        <input
          name="currentPassword"
          type="password"
          required
          className="w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1.5 text-sm text-neutral-100 focus:border-neutral-500 focus:outline-none"
        />
      </div>
      <div>
        <label className="mb-1 block text-xs text-neutral-400">New password</label>
        <input
          name="newPassword"
          type="password"
          required
          minLength={8}
          className="w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1.5 text-sm text-neutral-100 focus:border-neutral-500 focus:outline-none"
        />
      </div>
      <button
        type="submit"
        disabled={submitting}
        className="rounded bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-900 hover:bg-white disabled:opacity-50"
      >
        {submitting ? "Saving..." : "Change password"}
      </button>
      {message && (
        <p className={`text-xs ${message.type === "ok" ? "text-green-400" : "text-red-400"}`}>{message.text}</p>
      )}
    </form>
  );
}
