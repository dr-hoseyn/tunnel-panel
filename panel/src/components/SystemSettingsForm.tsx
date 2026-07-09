"use client";

import { useState } from "react";

interface SettingsValue {
  healthCheckIntervalMs: number;
  statRetentionMs: number;
  stuckDeploymentTimeoutMs: number;
  deploymentMaxAttempts: number;
  autoRestartEnabled: boolean;
  logRetentionDays: number;
  backupScheduleHours: number;
}

/** Operational knobs stored in ms/days on the backend, edited here in
 * friendlier units (seconds/minutes/days) -- converted at the form
 * boundary so the API stays precise and the UI stays readable. */
export function SystemSettingsForm({ initial }: { initial: SettingsValue }) {
  const [values, setValues] = useState(initial);
  const [message, setMessage] = useState<{ type: "ok" | "error"; text: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSubmitting(true);
    setMessage(null);
    try {
      const res = await fetch("/api/v1/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMessage({ type: "error", text: data.error ?? "Failed to save settings" });
        return;
      }
      setValues(data.settings);
      setMessage({ type: "ok", text: "Settings saved." });
    } catch {
      setMessage({ type: "error", text: "Network error while contacting the panel API" });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit} className="max-w-lg space-y-4">
      <NumberField
        label="Health-check interval"
        suffix="seconds"
        value={values.healthCheckIntervalMs / 1000}
        min={5}
        max={600}
        onChange={(v) => setValues({ ...values, healthCheckIntervalMs: v * 1000 })}
      />
      <NumberField
        label="Stat retention"
        suffix="days"
        value={values.statRetentionMs / (24 * 60 * 60 * 1000)}
        min={1}
        max={90}
        onChange={(v) => setValues({ ...values, statRetentionMs: v * 24 * 60 * 60 * 1000 })}
      />
      <NumberField
        label="Stuck-deployment timeout"
        suffix="minutes"
        value={values.stuckDeploymentTimeoutMs / 60000}
        min={1}
        max={60}
        onChange={(v) => setValues({ ...values, stuckDeploymentTimeoutMs: v * 60000 })}
      />
      <NumberField
        label="Deployment retry count"
        suffix="attempts"
        value={values.deploymentMaxAttempts}
        min={1}
        max={10}
        onChange={(v) => setValues({ ...values, deploymentMaxAttempts: v })}
      />
      <NumberField
        label="Event log retention"
        suffix="days"
        value={values.logRetentionDays}
        min={1}
        max={365}
        onChange={(v) => setValues({ ...values, logRetentionDays: v })}
      />
      <NumberField
        label="Scheduled backups"
        suffix="hours between backups (0 = disabled)"
        value={values.backupScheduleHours}
        min={0}
        max={720}
        onChange={(v) => setValues({ ...values, backupScheduleHours: v })}
      />
      <label className="flex items-center gap-2 text-sm text-neutral-300">
        <input
          type="checkbox"
          checked={values.autoRestartEnabled}
          onChange={(e) => setValues({ ...values, autoRestartEnabled: e.target.checked })}
          className="h-4 w-4 rounded border-neutral-700 bg-neutral-950"
        />
        Automatically restart a tunnel after 2 consecutive failed health checks
      </label>

      <button
        type="submit"
        disabled={submitting}
        className="rounded bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-900 hover:bg-white disabled:opacity-50"
      >
        {submitting ? "Saving..." : "Save settings"}
      </button>
      {message && (
        <p className={`text-xs ${message.type === "ok" ? "text-green-400" : "text-red-400"}`}>{message.text}</p>
      )}
    </form>
  );
}

function NumberField({
  label,
  suffix,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  suffix: string;
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
}) {
  return (
    <div>
      <label className="mb-1 block text-xs text-neutral-400">{label}</label>
      <div className="flex items-center gap-2">
        <input
          type="number"
          value={value}
          min={min}
          max={max}
          onChange={(e) => onChange(Number(e.target.value))}
          className="w-32 rounded border border-neutral-700 bg-neutral-950 px-2 py-1.5 text-sm text-neutral-100 focus:border-neutral-500 focus:outline-none"
        />
        <span className="text-xs text-neutral-500">{suffix}</span>
      </div>
    </div>
  );
}
