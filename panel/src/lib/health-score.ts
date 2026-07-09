/**
 * Per-tunnel health score: a single 0-100 heuristic summarizing status,
 * latency, and restart frequency into one number the UI can badge/sort/
 * color by, so "is this tunnel actually okay" doesn't require reading a
 * table of raw stats. Deliberately documented as a heuristic composite, not
 * an SLA measurement -- every input is a real, agent-measured signal
 * (health-sampler.ts's TunnelStat rows), but the weights combining them are
 * a judgment call, not a standard.
 */

export interface HealthScoreStat {
  timestamp: string | Date;
  latencyMs: number | null;
  reconnectCount: number;
}

export interface HealthScoreResult {
  score: number; // 0-100, higher is healthier
  label: "Excellent" | "Good" | "Degraded" | "Poor" | "Unknown";
  reasons: string[]; // human-readable deductions, empty when score is 100
}

const STATUS_BASE: Record<string, number> = {
  RUNNING: 100,
  WARNING: 60,
  DEPLOYING: 50,
  REMOVING: 50,
  STOPPED: 30,
  FAILED: 10,
  UNKNOWN: 40,
};

/** How far back "recent" restarts count against the score -- roughly the
 * last 5 minutes at the sampler's ~15s interval. */
const RECENT_WINDOW_SAMPLES = 20;

export function computeHealthScore(status: string, recentStats: HealthScoreStat[]): HealthScoreResult {
  const reasons: string[] = [];
  let score = STATUS_BASE[status] ?? STATUS_BASE.UNKNOWN;

  if (status !== "RUNNING") {
    reasons.push(`Status is ${status}`);
  }

  const withLatency = recentStats.filter((s) => s.latencyMs !== null);
  if (withLatency.length > 0) {
    const avgLatency = withLatency.reduce((a, s) => a + (s.latencyMs ?? 0), 0) / withLatency.length;
    if (avgLatency > 1000) {
      score -= 25;
      reasons.push(`High latency (avg ${Math.round(avgLatency)}ms)`);
    } else if (avgLatency > 500) {
      score -= 15;
      reasons.push(`Elevated latency (avg ${Math.round(avgLatency)}ms)`);
    } else if (avgLatency > 200) {
      score -= 5;
      reasons.push(`Slightly elevated latency (avg ${Math.round(avgLatency)}ms)`);
    }
  }

  const window = recentStats.slice(-RECENT_WINDOW_SAMPLES);
  if (window.length >= 2) {
    const delta = window[window.length - 1].reconnectCount - window[0].reconnectCount;
    if (delta > 0) {
      const penalty = Math.min(30, delta * 8);
      score -= penalty;
      reasons.push(`${delta} restart${delta === 1 ? "" : "s"} in the recent window`);
    }
  }

  score = Math.max(0, Math.min(100, Math.round(score)));

  let label: HealthScoreResult["label"];
  if (recentStats.length === 0 && status === "DEPLOYING") {
    label = "Unknown";
  } else if (score >= 90) {
    label = "Excellent";
  } else if (score >= 70) {
    label = "Good";
  } else if (score >= 40) {
    label = "Degraded";
  } else {
    label = "Poor";
  }

  return { score, label, reasons };
}
