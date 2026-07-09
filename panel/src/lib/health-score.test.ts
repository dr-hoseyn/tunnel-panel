import { describe, expect, it } from "vitest";
import { computeHealthScore } from "./health-score";

function stat(latencyMs: number | null, reconnectCount: number) {
  return { timestamp: new Date().toISOString(), latencyMs, reconnectCount };
}

describe("computeHealthScore", () => {
  it("gives a RUNNING tunnel with no issues a perfect score", () => {
    const result = computeHealthScore("RUNNING", [stat(20, 0), stat(25, 0)]);
    expect(result.score).toBe(100);
    expect(result.label).toBe("Excellent");
    expect(result.reasons).toHaveLength(0);
  });

  it("penalizes non-RUNNING status", () => {
    const result = computeHealthScore("WARNING", []);
    expect(result.score).toBeLessThan(100);
    expect(result.reasons).toContain("Status is WARNING");
  });

  it("penalizes high average latency", () => {
    const result = computeHealthScore("RUNNING", [stat(1200, 0), stat(1300, 0)]);
    expect(result.score).toBeLessThan(100);
    expect(result.reasons.some((r) => r.includes("High latency"))).toBe(true);
  });

  it("does not penalize latency when no samples report it", () => {
    const result = computeHealthScore("RUNNING", [stat(null, 0), stat(null, 0)]);
    expect(result.score).toBe(100);
  });

  it("penalizes recent restarts (reconnectCount delta across the window)", () => {
    const result = computeHealthScore("RUNNING", [stat(20, 2), stat(20, 5)]);
    expect(result.score).toBeLessThan(100);
    expect(result.reasons.some((r) => r.includes("restart"))).toBe(true);
  });

  it("does not penalize a flat (non-increasing) reconnect count", () => {
    const result = computeHealthScore("RUNNING", [stat(20, 3), stat(20, 3)]);
    expect(result.score).toBe(100);
  });

  it("clamps the score to a 0-100 range even with a FAILED status and many restarts", () => {
    const result = computeHealthScore("FAILED", [stat(2000, 0), stat(2000, 20)]);
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
    expect(result.label).toBe("Poor");
  });

  it("labels an empty-history DEPLOYING tunnel as Unknown rather than falsely Excellent/Poor", () => {
    const result = computeHealthScore("DEPLOYING", []);
    expect(result.label).toBe("Unknown");
  });

  it("falls back to the UNKNOWN base score for an unrecognized status string", () => {
    const result = computeHealthScore("SOME_FUTURE_STATUS", []);
    expect(result.score).toBe(40);
  });
});
