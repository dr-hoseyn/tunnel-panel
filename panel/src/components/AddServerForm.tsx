"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

type Mode = "ssh" | "manual";

export function AddServerForm() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>("ssh");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(url: string, body: Record<string, unknown>) {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(url, {
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

  function handleSshSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const authMethod = form.get("authMethod");
    submit("/api/servers/provision", {
      name: form.get("name"),
      host: form.get("host"),
      sshPort: Number(form.get("sshPort") || 22),
      sshUsername: form.get("sshUsername") || "root",
      sshPassword: authMethod === "password" ? form.get("sshPassword") : undefined,
      sshPrivateKey: authMethod === "key" ? form.get("sshPrivateKey") : undefined,
      agentPort: Number(form.get("agentPort") || 8443),
    });
  }

  function handleManualSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    submit("/api/servers", {
      name: form.get("name"),
      host: form.get("host"),
      agentPort: Number(form.get("agentPort") || 8443),
      token: form.get("token"),
      fingerprint: form.get("fingerprint"),
    });
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
    <div className="mb-6 rounded-lg border border-neutral-800 bg-neutral-900 p-6">
      <h2 className="mb-1 text-sm font-medium text-neutral-200">Register a new server</h2>

      <div className="mb-4 flex gap-1 border-b border-neutral-800 text-sm">
        <TabButton active={mode === "ssh"} onClick={() => setMode("ssh")}>
          Automatic (SSH)
        </TabButton>
        <TabButton active={mode === "manual"} onClick={() => setMode("manual")}>
          Manual
        </TabButton>
      </div>

      {error && (
        <p className="mb-3 rounded border border-red-900 bg-red-950 px-3 py-2 text-xs text-red-300">
          {error}
        </p>
      )}

      {mode === "ssh" ? (
        <SshForm submitting={submitting} onSubmit={handleSshSubmit} onCancel={() => setOpen(false)} />
      ) : (
        <ManualForm
          submitting={submitting}
          onSubmit={handleManualSubmit}
          onCancel={() => setOpen(false)}
        />
      )}
    </div>
  );
}

function SshForm({
  submitting,
  onSubmit,
  onCancel,
}: {
  submitting: boolean;
  onSubmit: (e: React.FormEvent<HTMLFormElement>) => void;
  onCancel: () => void;
}) {
  const [authMethod, setAuthMethod] = useState<"password" | "key">("password");

  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <p className="text-xs text-neutral-500">
        Connects over SSH, installs the agent on the server for you, and registers it -- no
        manual steps on the VPS. Requires tunnel-manager already installed there. SSH credentials
        are used once for this and never stored.
      </p>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Name" name="name" placeholder="iran-1" required />
        <Field label="Host / IP" name="host" placeholder="203.0.113.10" required />
        <Field label="SSH port" name="sshPort" placeholder="22" defaultValue="22" />
        <Field label="SSH username" name="sshUsername" placeholder="root" defaultValue="root" />
      </div>

      <div>
        <div className="mb-1 flex gap-3 text-xs text-neutral-400">
          <label className="flex items-center gap-1">
            <input
              type="radio"
              name="authMethod"
              value="password"
              checked={authMethod === "password"}
              onChange={() => setAuthMethod("password")}
            />
            Password
          </label>
          <label className="flex items-center gap-1">
            <input
              type="radio"
              name="authMethod"
              value="key"
              checked={authMethod === "key"}
              onChange={() => setAuthMethod("key")}
            />
            Private key
          </label>
        </div>
        {authMethod === "password" ? (
          <input
            type="password"
            name="sshPassword"
            placeholder="SSH password"
            required
            className="w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1.5 text-sm text-neutral-100 focus:border-neutral-500 focus:outline-none"
          />
        ) : (
          <textarea
            name="sshPrivateKey"
            placeholder="-----BEGIN OPENSSH PRIVATE KEY-----..."
            required
            rows={4}
            className="w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1.5 font-mono text-xs text-neutral-100 focus:border-neutral-500 focus:outline-none"
          />
        )}
      </div>

      <details className="text-xs text-neutral-500">
        <summary className="cursor-pointer select-none">Advanced</summary>
        <div className="mt-2 max-w-[200px]">
          <Field label="Agent port" name="agentPort" placeholder="8443" defaultValue="8443" />
        </div>
      </details>

      <FormButtons submitting={submitting} submittingLabel="Provisioning... (can take a minute or two)" onCancel={onCancel} />
    </form>
  );
}

function ManualForm({
  submitting,
  onSubmit,
  onCancel,
}: {
  submitting: boolean;
  onSubmit: (e: React.FormEvent<HTMLFormElement>) => void;
  onCancel: () => void;
}) {
  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <p className="text-xs text-neutral-500">
        Run the agent install script on the VPS yourself first, then paste the token and
        fingerprint it prints.
      </p>

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

      <FormButtons submitting={submitting} submittingLabel="Verifying..." onCancel={onCancel} />
    </form>
  );
}

function FormButtons({
  submitting,
  submittingLabel,
  onCancel,
}: {
  submitting: boolean;
  submittingLabel: string;
  onCancel: () => void;
}) {
  return (
    <div className="flex items-center gap-2 pt-1">
      <button
        type="submit"
        disabled={submitting}
        className="rounded bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-900 hover:bg-white disabled:opacity-50"
      >
        {submitting ? submittingLabel : "Register"}
      </button>
      <button
        type="button"
        onClick={onCancel}
        disabled={submitting}
        className="rounded px-4 py-2 text-sm text-neutral-400 hover:text-neutral-100 disabled:opacity-50"
      >
        Cancel
      </button>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`border-b-2 px-3 py-2 ${
        active
          ? "border-neutral-100 text-neutral-100"
          : "border-transparent text-neutral-500 hover:text-neutral-300"
      }`}
    >
      {children}
    </button>
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
