const STYLES: Record<string, string> = {
  RUNNING: "bg-green-950 text-green-400 border-green-900",
  DEPLOYING: "bg-blue-950 text-blue-400 border-blue-900",
  WARNING: "bg-yellow-950 text-yellow-400 border-yellow-900",
  FAILED: "bg-red-950 text-red-400 border-red-900",
  STOPPED: "bg-neutral-900 text-neutral-400 border-neutral-700",
  REMOVING: "bg-neutral-900 text-neutral-400 border-neutral-700",
  UNKNOWN: "bg-neutral-900 text-neutral-500 border-neutral-700",
};

const DOT: Record<string, string> = {
  RUNNING: "bg-green-500",
  DEPLOYING: "bg-blue-500 animate-pulse",
  WARNING: "bg-yellow-500",
  FAILED: "bg-red-500",
  STOPPED: "bg-neutral-500",
  REMOVING: "bg-neutral-500 animate-pulse",
  UNKNOWN: "bg-neutral-600",
};

export function TunnelStatusBadge({ status }: { status: string }) {
  const style = STYLES[status] ?? STYLES.UNKNOWN;
  const dot = DOT[status] ?? DOT.UNKNOWN;
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium ${style}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${dot}`} aria-hidden="true" />
      {status.charAt(0) + status.slice(1).toLowerCase()}
    </span>
  );
}
