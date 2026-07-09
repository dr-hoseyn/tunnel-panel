"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, XCircle, Loader2, ArrowRight, ArrowLeft, Plus, X } from "lucide-react";

interface ServerOption {
  id: string;
  name: string;
  host: string;
}

interface ExtraField {
  key: string;
  label: string;
  type: "text" | "password" | "select";
  options?: string[];
  placeholder?: string;
  defaultValue?: string;
}

interface CoreDescriptor {
  core: string;
  label: string;
  description: string;
  portsOn: "server" | "client" | "both";
  defaultPort: number;
  firewallProto: string;
  extraFields: ExtraField[];
}

interface PortMapping {
  remote: string;
  local: string;
}

interface StepLog {
  step: string;
  status: "started" | "ok" | "failed";
  message?: string;
  timestamp: string;
}

const STEPS = ["Servers", "Core", "Configure", "Deploy"] as const;

export function TunnelWizard({ servers }: { servers: ServerOption[] }) {
  const router = useRouter();
  const [step, setStep] = useState(0);

  const [name, setName] = useState("");
  const [sourceServerId, setSourceServerId] = useState(servers[0]?.id ?? "");
  const [destServerId, setDestServerId] = useState(servers[1]?.id ?? "");

  const [cores, setCores] = useState<CoreDescriptor[] | null>(null);
  const [coreId, setCoreId] = useState<string>("");

  const [port, setPort] = useState<string>("");
  const [ports, setPorts] = useState<PortMapping[]>([]);
  const [extra, setExtra] = useState<Record<string, string>>({});

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [deploymentId, setDeploymentId] = useState<string | null>(null);
  const [tunnelId, setTunnelId] = useState<string | null>(null);
  const [deployStatus, setDeployStatus] = useState<string>("QUEUED");
  const [deploySteps, setDeploySteps] = useState<StepLog[]>([]);

  useEffect(() => {
    fetch("/api/v1/cores")
      .then((r) => r.json())
      .then((data: { cores: CoreDescriptor[] }) => {
        setCores(data.cores);
        if (data.cores[0]) {
          setCoreId(data.cores[0].core);
          setPort(String(data.cores[0].defaultPort));
        }
      })
      .catch(() => setCores([]));
  }, []);

  const selectedCore = useMemo(() => cores?.find((c) => c.core === coreId) ?? null, [cores, coreId]);

  useEffect(() => {
    if (!deploymentId) return;
    const source = new EventSource(`/api/v1/deployments/${deploymentId}/stream`);
    source.addEventListener("update", (e) => {
      const data = JSON.parse((e as MessageEvent).data) as { status: string; steps: StepLog[] };
      setDeployStatus(data.status);
      setDeploySteps(data.steps);
    });
    source.addEventListener("done", (e) => {
      const data = JSON.parse((e as MessageEvent).data) as { status: string };
      setDeployStatus(data.status);
      source.close();
      if (data.status === "SUCCEEDED" && tunnelId) {
        router.refresh();
      }
    });
    source.addEventListener("error", () => {
      source.close();
    });
    return () => source.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deploymentId]);

  function selectCore(id: string) {
    setCoreId(id);
    const descriptor = cores?.find((c) => c.core === id);
    if (descriptor) {
      setPort(String(descriptor.defaultPort));
      const defaults: Record<string, string> = {};
      for (const f of descriptor.extraFields) {
        if (f.defaultValue) defaults[f.key] = f.defaultValue;
      }
      setExtra(defaults);
    }
  }

  function addPortMapping() {
    setPorts((prev) => [...prev, { remote: "", local: "" }]);
  }
  function updatePortMapping(index: number, field: "remote" | "local", value: string) {
    setPorts((prev) => prev.map((p, i) => (i === index ? { ...p, [field]: value } : p)));
  }
  function removePortMapping(index: number) {
    setPorts((prev) => prev.filter((_, i) => i !== index));
  }

  async function deploy() {
    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await fetch("/api/v1/tunnels", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          core: coreId,
          sourceServerId,
          destServerId,
          port: Number(port),
          ports: ports
            .filter((p) => p.remote && p.local)
            .map((p) => ({ remote: Number(p.remote), local: Number(p.local) })),
          extra,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setSubmitError(data.error ?? "Failed to create tunnel");
        setSubmitting(false);
        return;
      }
      setTunnelId(data.tunnel.id);
      setDeploymentId(data.deploymentId);
      setStep(3);
    } catch {
      setSubmitError("Network error while contacting the panel API");
    } finally {
      setSubmitting(false);
    }
  }

  const canProceedStep0 = name.trim().length > 0 && sourceServerId && destServerId && sourceServerId !== destServerId;
  const canProceedStep1 = !!coreId;
  const canProceedStep2 = Number(port) > 0;

  return (
    <div>
      <ol className="mb-8 flex items-center gap-2 text-xs">
        {STEPS.map((label, i) => (
          <li key={label} className="flex items-center gap-2">
            <span
              className={`flex h-6 w-6 items-center justify-center rounded-full border ${
                i === step
                  ? "border-neutral-100 bg-neutral-100 text-neutral-900"
                  : i < step
                    ? "border-green-700 bg-green-950 text-green-400"
                    : "border-neutral-700 text-neutral-500"
              }`}
            >
              {i < step ? <CheckCircle2 className="h-3.5 w-3.5" /> : i + 1}
            </span>
            <span className={i === step ? "text-neutral-100" : "text-neutral-500"}>{label}</span>
            {i < STEPS.length - 1 && <ArrowRight className="h-3 w-3 text-neutral-700" aria-hidden="true" />}
          </li>
        ))}
      </ol>

      {step === 0 && (
        <div className="space-y-4">
          <Field label="Tunnel name">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Iran-Germany"
              className="w-full rounded border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 focus:border-neutral-500 focus:outline-none"
            />
          </Field>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Source server">
              <select
                value={sourceServerId}
                onChange={(e) => setSourceServerId(e.target.value)}
                className="w-full rounded border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 focus:border-neutral-500 focus:outline-none"
              >
                {servers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({s.host})
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Destination server">
              <select
                value={destServerId}
                onChange={(e) => setDestServerId(e.target.value)}
                className="w-full rounded border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 focus:border-neutral-500 focus:outline-none"
              >
                {servers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({s.host})
                  </option>
                ))}
              </select>
            </Field>
          </div>
          {sourceServerId === destServerId && (
            <p className="text-xs text-red-400">Source and destination must be different servers.</p>
          )}
          <WizardNav onNext={() => setStep(1)} nextDisabled={!canProceedStep0} />
        </div>
      )}

      {step === 1 && (
        <div className="space-y-4">
          {cores === null && <p className="text-sm text-neutral-500">Loading cores...</p>}
          {cores && (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {cores.map((c) => (
                <button
                  key={c.core}
                  type="button"
                  onClick={() => selectCore(c.core)}
                  className={`rounded-lg border p-4 text-left transition ${
                    coreId === c.core
                      ? "border-neutral-100 bg-neutral-900"
                      : "border-neutral-800 hover:border-neutral-600"
                  }`}
                >
                  <div className="mb-1 font-medium text-neutral-100">{c.label}</div>
                  <p className="text-xs text-neutral-500">{c.description}</p>
                </button>
              ))}
            </div>
          )}
          <WizardNav onBack={() => setStep(0)} onNext={() => setStep(2)} nextDisabled={!canProceedStep1} />
        </div>
      )}

      {step === 2 && selectedCore && (
        <div className="space-y-4">
          <Field label={`Bind port (${selectedCore.label} on the source server)`}>
            <input
              type="number"
              value={port}
              onChange={(e) => setPort(e.target.value)}
              className="w-full rounded border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 focus:border-neutral-500 focus:outline-none"
            />
          </Field>

          {selectedCore.extraFields.map((f) => (
            <Field key={f.key} label={f.label}>
              {f.type === "select" ? (
                <select
                  value={extra[f.key] ?? f.defaultValue ?? ""}
                  onChange={(e) => setExtra((prev) => ({ ...prev, [f.key]: e.target.value }))}
                  className="w-full rounded border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 focus:border-neutral-500 focus:outline-none"
                >
                  {f.options?.map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  type={f.type}
                  value={extra[f.key] ?? ""}
                  onChange={(e) => setExtra((prev) => ({ ...prev, [f.key]: e.target.value }))}
                  placeholder={f.placeholder}
                  className="w-full rounded border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 focus:border-neutral-500 focus:outline-none"
                />
              )}
            </Field>
          ))}

          <div>
            <div className="mb-1 flex items-center justify-between">
              <span className="block text-xs text-neutral-400">
                Forwarded ports (optional -- applies to the {selectedCore.portsOn === "both" ? "server and client" : selectedCore.portsOn} side)
              </span>
              <button
                type="button"
                onClick={addPortMapping}
                className="flex items-center gap-1 text-xs text-neutral-400 hover:text-neutral-200"
              >
                <Plus className="h-3.5 w-3.5" /> Add port
              </button>
            </div>
            {ports.map((p, i) => (
              <div key={i} className="mb-2 flex items-center gap-2">
                <input
                  placeholder="remote port"
                  value={p.remote}
                  onChange={(e) => updatePortMapping(i, "remote", e.target.value)}
                  className="w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1.5 text-sm text-neutral-100 focus:border-neutral-500 focus:outline-none"
                />
                <span className="text-neutral-600">=</span>
                <input
                  placeholder="local port"
                  value={p.local}
                  onChange={(e) => updatePortMapping(i, "local", e.target.value)}
                  className="w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1.5 text-sm text-neutral-100 focus:border-neutral-500 focus:outline-none"
                />
                <button type="button" onClick={() => removePortMapping(i)} className="text-neutral-500 hover:text-red-400">
                  <X className="h-4 w-4" />
                </button>
              </div>
            ))}
          </div>

          {submitError && <p className="text-xs text-red-400">{submitError}</p>}

          <WizardNav
            onBack={() => setStep(1)}
            onNext={deploy}
            nextLabel={submitting ? "Deploying..." : "Deploy"}
            nextDisabled={!canProceedStep2 || submitting}
          />
        </div>
      )}

      {step === 3 && (
        <div className="space-y-4">
          <div className="flex items-center gap-2 text-sm">
            {deployStatus === "SUCCEEDED" && <CheckCircle2 className="h-5 w-5 text-green-400" />}
            {deployStatus === "FAILED" && <XCircle className="h-5 w-5 text-red-400" />}
            {(deployStatus === "QUEUED" || deployStatus === "RUNNING") && (
              <Loader2 className="h-5 w-5 animate-spin text-neutral-400" />
            )}
            <span className="font-medium text-neutral-100">
              {deployStatus === "SUCCEEDED"
                ? "Tunnel deployed"
                : deployStatus === "FAILED"
                  ? "Deployment failed"
                  : "Deploying..."}
            </span>
          </div>

          <ul className="space-y-1 rounded-lg border border-neutral-800 bg-neutral-900 p-4 font-mono text-xs">
            {deploySteps.map((s, i) => (
              <li key={i} className="flex items-start gap-2">
                {s.status === "ok" && <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0 text-green-400" />}
                {s.status === "failed" && <XCircle className="mt-0.5 h-3 w-3 shrink-0 text-red-400" />}
                {s.status === "started" && <Loader2 className="mt-0.5 h-3 w-3 shrink-0 animate-spin text-neutral-500" />}
                <span className="text-neutral-300">
                  {s.step}
                  {s.message ? `: ${s.message}` : ""}
                </span>
              </li>
            ))}
            {deploySteps.length === 0 && <li className="text-neutral-600">Waiting for the deployment to start...</li>}
          </ul>

          {deployStatus === "SUCCEEDED" && tunnelId && (
            <a href={`/tunnels/${tunnelId}`} className="inline-block text-sm text-neutral-300 underline hover:text-neutral-100">
              View tunnel &rarr;
            </a>
          )}
          {deployStatus === "FAILED" && (
            <button
              type="button"
              onClick={() => {
                setStep(2);
                setDeploymentId(null);
                setDeploySteps([]);
                setDeployStatus("QUEUED");
              }}
              className="flex items-center gap-1 text-sm text-neutral-300 hover:text-neutral-100"
            >
              <ArrowLeft className="h-4 w-4" /> Back to configuration
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-xs text-neutral-400">{label}</label>
      {children}
    </div>
  );
}

function WizardNav({
  onBack,
  onNext,
  nextDisabled,
  nextLabel = "Next",
}: {
  onBack?: () => void;
  onNext: () => void;
  nextDisabled?: boolean;
  nextLabel?: string;
}) {
  return (
    <div className="flex items-center justify-between pt-2">
      {onBack ? (
        <button type="button" onClick={onBack} className="flex items-center gap-1 text-sm text-neutral-400 hover:text-neutral-200">
          <ArrowLeft className="h-4 w-4" /> Back
        </button>
      ) : (
        <span />
      )}
      <button
        type="button"
        onClick={onNext}
        disabled={nextDisabled}
        className="flex items-center gap-1 rounded bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-900 hover:bg-white disabled:opacity-50"
      >
        {nextLabel} <ArrowRight className="h-4 w-4" />
      </button>
    </div>
  );
}
