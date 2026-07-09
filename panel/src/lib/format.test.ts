import { describe, expect, it, vi } from "vitest";
import { formatBytes, formatUptime } from "./format";

describe("formatBytes", () => {
  it("formats 0/null/undefined as '0 B'", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(null)).toBe("0 B");
    expect(formatBytes(undefined)).toBe("0 B");
  });

  it("formats bytes in the right unit", () => {
    expect(formatBytes(500)).toBe("500.0 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });

  it("accepts a bigint", () => {
    expect(formatBytes(BigInt(1024))).toBe("1.0 KB");
  });
});

describe("formatUptime", () => {
  it("returns an em-dash for a non-RUNNING tunnel", () => {
    expect(formatUptime(new Date(), "STOPPED")).toBe("—");
  });

  it("formats a running tunnel's age in hours/minutes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T02:30:00Z"));
    const createdAt = new Date("2026-01-01T00:00:00Z");
    expect(formatUptime(createdAt, "RUNNING")).toBe("2h 30m");
    vi.useRealTimers();
  });

  it("formats a running tunnel's age in days/hours once over a day old", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-03T05:00:00Z"));
    const createdAt = new Date("2026-01-01T00:00:00Z");
    expect(formatUptime(createdAt, "RUNNING")).toBe("2d 5h");
    vi.useRealTimers();
  });

  it("accepts an ISO string as well as a Date", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T01:00:00Z"));
    expect(formatUptime("2026-01-01T00:00:00Z", "RUNNING")).toBe("1h 0m");
    vi.useRealTimers();
  });
});
