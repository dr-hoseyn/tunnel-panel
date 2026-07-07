"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function AddServerForm() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    const form = new FormData(e.currentTarget);
    const body = {
      name: form.get("name"),
      host: form.get("host"),
      agentPort: Number(form.get("agentPort") || 8443),
      token: form.get("token"),
      fingerprint: form.get("fingerprint"),
    };
    try {
      const res = await fetch("/api/servers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Failed to register server");
        return;
      }
      setOpen(false);
      router.refresh();
    } catch {
      setError("Network error while contacting the panel API");
    } finally {
      setSubmitting(false);
    }
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="rounded bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-900 hover:bg-white"
      >
        + Add server
      </button>
    );
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="mb-6 space-y-3 rounded-lg border border-neutral-800 bg-neutral-900 p-6"
    >
      <h2 className="text-sm font-medium text-neutral-200">Register a new server</h2>
      <p className="text-xs text-neutral-500">
        Run the agent install script on the VPS first, then paste the token and fingerprint it
        prints here.
      </p>

      {error && (
        <p className="rounded border border-red-900 bg-red-950 px-3 py-2 text-xs text-red-300">
          {error}
        </p>
      )}

      <div className="grid grid-cols-2 gap-3">
        <Field label="Name" name="name" placeholder="iran-1" required />
        <Field label="Host / IP" name="host" placeholder="203.0.113.10" required />
        <Field label="Agent port" name="agentPort" placeholder="8443" defaultValue="8443" />
        <Field label="Bearer token" name="token" placeholder="from agent -init" required />
      </div>
      <Field
        label="TLS fingerprint"
        name="fingerprint"
        placeholder="from agent -fingerprint (AA:BB:CC:...)"
        required
      />

      <div className="flex gap-2 pt-1">
        <button
          type="submit"
          disabled={submitting}
          className="rounded bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-900 hover:bg-white disabled:opacity-50"
        >
          {submitting ? "Verifying..." : "Register"}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded px-4 py-2 text-sm text-neutral-400 hover:text-neutral-100"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

function Field({
  label,
  name,
  placeholder,
  required,
  defaultValue,
}: {
  label: string;
  name: string;
  placeholder?: string;
  required?: boolean;
  defaultValue?: string;
}) {
  return (
    <div>
      <label htmlFor={name} className="mb-1 block text-xs text-neutral-400">
        {label}
      </label>
      <input
        id={name}
        name={name}
        placeholder={placeholder}
        required={required}
        defaultValue={defaultValue}
        className="w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1.5 text-sm text-neutral-100 focus:border-neutral-500 focus:outline-none"
      />
    </div>
  );
}
