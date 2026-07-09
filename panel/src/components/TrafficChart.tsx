"use client";

interface Sample {
  timestamp: string;
  rxBytes: number;
  txBytes: number;
}

/** Minimal hand-rolled SVG line chart -- no charting dependency for two
 * lines over a bounded sample window. */
export function TrafficChart({ samples }: { samples: Sample[] }) {
  if (samples.length < 2) {
    return (
      <div className="flex h-40 items-center justify-center text-xs text-neutral-600">
        Not enough data yet -- check back in a minute.
      </div>
    );
  }

  const width = 640;
  const height = 160;
  const padding = 8;
  const max = Math.max(1, ...samples.map((s) => Math.max(s.rxBytes, s.txBytes)));

  const points = (key: "rxBytes" | "txBytes") =>
    samples
      .map((s, i) => {
        const x = padding + (i / (samples.length - 1)) * (width - padding * 2);
        const y = height - padding - (s[key] / max) * (height - padding * 2);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");

  return (
    <div>
      <svg viewBox={`0 0 ${width} ${height}`} className="h-40 w-full" preserveAspectRatio="none" role="img" aria-label="Traffic over time">
        <polyline points={points("rxBytes")} fill="none" stroke="#22c55e" strokeWidth="1.5" />
        <polyline points={points("txBytes")} fill="none" stroke="#3b82f6" strokeWidth="1.5" />
      </svg>
      <div className="mt-2 flex gap-4 text-xs text-neutral-500">
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-green-500" /> RX
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-blue-500" /> TX
        </span>
      </div>
    </div>
  );
}
