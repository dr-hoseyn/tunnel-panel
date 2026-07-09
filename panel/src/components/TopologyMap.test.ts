import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clampZoom, computeLayout, filterTopology, serverOnlineStatus } from "./TopologyMap";

describe("serverOnlineStatus", () => {
  const NOW = new Date("2026-07-09T12:00:00.000Z").getTime();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("is unknown when the server has never checked in", () => {
    expect(serverOnlineStatus(null)).toBe("unknown");
  });

  it("is online when lastSeenAt is within the last minute", () => {
    const recent = new Date(NOW - 30_000).toISOString();
    expect(serverOnlineStatus(recent)).toBe("online");
  });

  it("is offline when lastSeenAt is older than a minute", () => {
    const stale = new Date(NOW - 90_000).toISOString();
    expect(serverOnlineStatus(stale)).toBe("offline");
  });

  it("treats the threshold boundary as no-longer-recent", () => {
    const exactlyAtThreshold = new Date(NOW - 60_000).toISOString();
    expect(serverOnlineStatus(exactlyAtThreshold)).toBe("offline");
  });
});

describe("computeLayout", () => {
  it("places a single node at the center", () => {
    const positions = computeLayout(["a"], 640);
    expect(positions.get("a")).toEqual({ x: 320, y: 320 });
  });

  it("returns an empty map for no nodes", () => {
    expect(computeLayout([], 640).size).toBe(0);
  });

  it("places every node the same distance from the center", () => {
    const size = 640;
    const positions = computeLayout(["a", "b", "c", "d"], size);
    const center = size / 2;
    for (const [, pos] of positions) {
      const dist = Math.hypot(pos.x - center, pos.y - center);
      expect(dist).toBeCloseTo(size / 2 - 90, 5);
    }
  });

  it("is deterministic for the same id list", () => {
    const a = computeLayout(["x", "y", "z"], 640);
    const b = computeLayout(["x", "y", "z"], 640);
    expect(Array.from(a.entries())).toEqual(Array.from(b.entries()));
  });
});

describe("clampZoom", () => {
  it("clamps below the minimum", () => {
    expect(clampZoom(0.01)).toBe(0.5);
  });

  it("clamps above the maximum", () => {
    expect(clampZoom(100)).toBe(4);
  });

  it("passes through in-range values", () => {
    expect(clampZoom(1.5)).toBe(1.5);
  });
});

describe("filterTopology", () => {
  const nodes = [
    { id: "s1", name: "Germany-1" },
    { id: "s2", name: "Iran-1" },
  ];
  const edges = [
    { id: "e1", name: "de-to-ir", sourceId: "s1", destId: "s2" },
    { id: "e2", name: "unrelated", sourceId: "s2", destId: "s2" },
  ];

  it("matches everything when the query is empty", () => {
    const { matchedNodeIds, matchedEdgeIds } = filterTopology(nodes, edges, "");
    expect(matchedNodeIds).toEqual(new Set(["s1", "s2"]));
    expect(matchedEdgeIds).toEqual(new Set(["e1", "e2"]));
  });

  it("matches everything for a whitespace-only query", () => {
    const { matchedNodeIds } = filterTopology(nodes, edges, "   ");
    expect(matchedNodeIds).toEqual(new Set(["s1", "s2"]));
  });

  it("matches nodes case-insensitively by substring", () => {
    const { matchedNodeIds } = filterTopology(nodes, edges, "germany");
    expect(matchedNodeIds).toEqual(new Set(["s1"]));
  });

  it("matches edges by their own name", () => {
    const { matchedEdgeIds } = filterTopology(nodes, edges, "unrelated");
    expect(matchedEdgeIds).toEqual(new Set(["e2"]));
  });

  it("also matches edges touching a matched node, even if the edge name itself doesn't match", () => {
    const { matchedEdgeIds } = filterTopology(nodes, edges, "germany");
    // e1 touches s1 (Germany-1); e2 doesn't touch s1 and its own name doesn't match either.
    expect(matchedEdgeIds).toEqual(new Set(["e1"]));
  });

  it("matches nothing when the query matches no name", () => {
    const { matchedNodeIds, matchedEdgeIds } = filterTopology(nodes, edges, "nonexistent");
    expect(matchedNodeIds.size).toBe(0);
    expect(matchedEdgeIds.size).toBe(0);
  });
});
