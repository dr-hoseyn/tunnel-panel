import { beforeEach, describe, expect, it, vi } from "vitest";

interface Row {
  id: string;
  [key: string]: unknown;
}

function createFakePrisma() {
  const tunnels = new Map<string, Row>();
  const events: Row[] = [];
  const stats: Row[] = [];

  // Minimal where-clause interpreter: only the specific patterns
  // health-sampler.ts actually queries with (status notIn/in, updatedAt lt)
  // -- not a general Prisma emulation.
  function matchesWhere(row: Row, where: Record<string, unknown> | undefined): boolean {
    if (!where) return true;
    if (where.status && typeof where.status === "object") {
      const statusFilter = where.status as { notIn?: string[]; in?: string[] };
      if (statusFilter.notIn && statusFilter.notIn.includes(row.status as string)) return false;
      if (statusFilter.in && !statusFilter.in.includes(row.status as string)) return false;
    }
    if (where.updatedAt && typeof where.updatedAt === "object") {
      const updatedFilter = where.updatedAt as { lt?: Date };
      const rowUpdatedAt = (row.updatedAt as Date) ?? new Date(0);
      if (updatedFilter.lt && !(rowUpdatedAt < updatedFilter.lt)) return false;
    }
    if (where.tunnelId && row.tunnelId !== where.tunnelId) return false;
    return true;
  }

  return {
    server: {
      update: vi.fn(async () => ({})),
      findMany: vi.fn(async () => []),
    },
    tunnel: {
      findMany: vi.fn(async ({ where }: { where?: Record<string, unknown> } = {}) =>
        Array.from(tunnels.values()).filter((row) => matchesWhere(row, where)),
      ),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = tunnels.get(where.id);
        if (!row) throw new Error("not found");
        Object.assign(row, data);
        return row;
      }),
    },
    deployment: {
      findFirst: vi.fn(async () => null),
    },
    tunnelStat: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        stats.push({ id: `stat-${stats.length}`, ...data });
      }),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
    event: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        events.push({ id: `event-${events.length}`, ...data });
      }),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
    __tunnels: tunnels,
    __events: events,
    __stats: stats,
  };
}

const fakePrisma = createFakePrisma();
vi.mock("@/lib/db", () => ({ prisma: fakePrisma }));

const agentGetMock = vi.fn();
vi.mock("@/lib/agent-client", () => ({ agentGet: (...args: unknown[]) => agentGetMock(...args) }));

vi.mock("@/lib/crypto", () => ({ decryptSecret: (v: string) => v }));

const restartTunnelMock = vi.fn();
vi.mock("@/lib/tunnel-orchestrator", () => ({ restartTunnel: (...args: unknown[]) => restartTunnelMock(...args) }));

let currentSettings = {
  healthCheckIntervalMs: 15000,
  statRetentionMs: 7 * 24 * 60 * 60 * 1000,
  stuckDeploymentTimeoutMs: 10 * 60 * 1000,
  deploymentMaxAttempts: 3,
  autoRestartEnabled: true,
  logRetentionDays: 30,
};
vi.mock("@/lib/settings", () => ({ getSettings: () => Promise.resolve(currentSettings) }));

const { runSampleCycle, __resetHealthSamplerStateForTests } = await import("./health-sampler");

const serverStub = (host: string) => ({
  host,
  agentPort: 8443,
  agentTokenEnc: "tok",
  tlsFingerprint: "AA",
});

function seedTunnel(id: string, status = "RUNNING") {
  fakePrisma.__tunnels.set(id, {
    id,
    name: `Tunnel ${id}`,
    status,
    sourceServer: serverStub("1.1.1.1"),
    destServer: serverStub("2.2.2.2"),
  });
}

function healthyResponse() {
  return JSON.stringify({ process: "running", port_open: true, traffic_active: true, rx_bytes: 100, tx_bytes: 50 });
}

function unhealthyResponse() {
  return JSON.stringify({ process: "stopped", port_open: false, traffic_active: false, rx_bytes: 0, tx_bytes: 0 });
}

function healthyResponseWithRuntimeStats(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    process: "running",
    port_open: true,
    traffic_active: true,
    rx_bytes: 100,
    tx_bytes: 50,
    latency_ms: 12.5,
    has_latency: true,
    connections: 3,
    reconnect_count: 2,
    cpu_percent: 1.5,
    ram_percent: 4.2,
    has_proc_stats: true,
    ...overrides,
  });
}

beforeEach(() => {
  fakePrisma.__tunnels.clear();
  fakePrisma.__events.length = 0;
  fakePrisma.__stats.length = 0;
  agentGetMock.mockReset();
  restartTunnelMock.mockReset();
  fakePrisma.server.update.mockClear();
  fakePrisma.server.findMany.mockReset();
  fakePrisma.server.findMany.mockResolvedValue([]);
  fakePrisma.tunnelStat.deleteMany.mockClear();
  fakePrisma.event.deleteMany.mockClear();
  __resetHealthSamplerStateForTests();
  currentSettings = {
    healthCheckIntervalMs: 15000,
    statRetentionMs: 7 * 24 * 60 * 60 * 1000,
    stuckDeploymentTimeoutMs: 10 * 60 * 1000,
    deploymentMaxAttempts: 3,
    autoRestartEnabled: true,
    logRetentionDays: 30,
  };
});

describe("health-sampler state machine", () => {
  it("keeps a healthy tunnel RUNNING and records a stat sample", async () => {
    seedTunnel("t-healthy");
    agentGetMock.mockResolvedValue(healthyResponse());

    await runSampleCycle();

    expect(fakePrisma.__tunnels.get("t-healthy")!.status).toBe("RUNNING");
    expect(fakePrisma.__stats).toHaveLength(1);
  });

  it("marks a first failure as WARNING without restarting", async () => {
    seedTunnel("t-warn");
    agentGetMock.mockResolvedValue(unhealthyResponse());

    await runSampleCycle();

    expect(fakePrisma.__tunnels.get("t-warn")!.status).toBe("WARNING");
    expect(restartTunnelMock).not.toHaveBeenCalled();
    expect(fakePrisma.__events.some((e) => e.type === "TUNNEL_HEALTH_WARNING")).toBe(true);
  });

  it("attempts exactly one automatic restart on the second consecutive failure", async () => {
    seedTunnel("t-restart");
    agentGetMock.mockResolvedValue(unhealthyResponse());

    await runSampleCycle(); // failure 1 -> WARNING
    await runSampleCycle(); // failure 2 -> auto-restart

    expect(restartTunnelMock).toHaveBeenCalledTimes(1);
    expect(restartTunnelMock).toHaveBeenCalledWith("t-restart");
    expect(fakePrisma.__events.some((e) => e.type === "TUNNEL_AUTO_RESTART")).toBe(true);
  });

  it("flags FAILED after a third consecutive failure and does not restart again", async () => {
    seedTunnel("t-failed");
    agentGetMock.mockResolvedValue(unhealthyResponse());

    await runSampleCycle(); // 1 -> WARNING
    await runSampleCycle(); // 2 -> restart attempted
    await runSampleCycle(); // 3 -> FAILED, no second restart

    expect(fakePrisma.__tunnels.get("t-failed")!.status).toBe("FAILED");
    expect(restartTunnelMock).toHaveBeenCalledTimes(1);
    expect(fakePrisma.__events.some((e) => e.type === "TUNNEL_HEALTH_FAILED")).toBe(true);
  });

  it("never auto-restarts when settings.autoRestartEnabled is false, and still reaches FAILED", async () => {
    currentSettings.autoRestartEnabled = false;
    seedTunnel("t-no-auto-restart");
    agentGetMock.mockResolvedValue(unhealthyResponse());

    await runSampleCycle(); // 1 -> WARNING
    await runSampleCycle(); // 2 -> would restart if enabled, but it's not

    expect(restartTunnelMock).not.toHaveBeenCalled();
    expect(fakePrisma.__tunnels.get("t-no-auto-restart")!.status).toBe("FAILED");
    const failedEvent = fakePrisma.__events.find((e) => e.type === "TUNNEL_HEALTH_FAILED");
    expect(failedEvent).toBeTruthy();
    expect(failedEvent!.message).toContain("disabled");
  });

  it("logs the FAILED event exactly once per failure streak, not every cycle it stays FAILED", async () => {
    seedTunnel("t-log-once");
    agentGetMock.mockResolvedValue(unhealthyResponse());

    await runSampleCycle(); // 1 -> WARNING
    await runSampleCycle(); // 2 -> restart attempted
    await runSampleCycle(); // 3 -> FAILED, logged
    await runSampleCycle(); // 4 -> still FAILED, must not log again

    const failedEvents = fakePrisma.__events.filter((e) => e.type === "TUNNEL_HEALTH_FAILED");
    expect(failedEvents).toHaveLength(1);
  });

  it("aggregates real runtime stats (latency/connections/reconnects/cpu/ram) from both sides into one TunnelStat row", async () => {
    seedTunnel("t-stats");
    agentGetMock
      .mockResolvedValueOnce(healthyResponseWithRuntimeStats({ latency_ms: 10, connections: 2, reconnect_count: 1, cpu_percent: 1, ram_percent: 2 }))
      .mockResolvedValueOnce(healthyResponseWithRuntimeStats({ latency_ms: 20, connections: 3, reconnect_count: 4, cpu_percent: 3, ram_percent: 6 }));

    await runSampleCycle();

    const stat = fakePrisma.__stats[0];
    expect(stat.latencyMs).toBe(15); // average of 10 and 20
    expect(stat.connections).toBe(5); // sum of 2 and 3
    expect(stat.reconnectCount).toBe(5); // sum of 1 and 4
    expect(stat.cpuPercent).toBe(2); // average of 1 and 3
    expect(stat.ramPercent).toBe(4); // average of 2 and 6
  });

  it("leaves latency/cpu/ram null (not 0) when neither side reports them", async () => {
    seedTunnel("t-no-runtime-stats");
    agentGetMock.mockResolvedValue(healthyResponse()); // no latency_ms/cpu_percent/ram_percent fields at all

    await runSampleCycle();

    const stat = fakePrisma.__stats[0];
    expect(stat.latencyMs).toBeNull();
    expect(stat.cpuPercent).toBeNull();
    expect(stat.ramPercent).toBeNull();
    expect(stat.connections).toBe(0);
    expect(stat.reconnectCount).toBe(0);
  });

  it("recovers back to RUNNING once health checks succeed again", async () => {
    seedTunnel("t-recover");
    agentGetMock.mockResolvedValue(unhealthyResponse());
    await runSampleCycle(); // WARNING

    agentGetMock.mockResolvedValue(healthyResponse());
    await runSampleCycle(); // healthy again

    expect(fakePrisma.__tunnels.get("t-recover")!.status).toBe("RUNNING");
  });
});

describe("pingAllServers (server reachability independent of tunnels)", () => {
  it("updates lastSeenAt for every registered server on a successful ping, even with no tunnels", async () => {
    seedTunnel("t-unrelated"); // any tunnel present shouldn't matter to server pinging
    agentGetMock.mockResolvedValue(healthyResponse());
    fakePrisma.server.findMany.mockResolvedValueOnce([
      { id: "srv-a", host: "1.1.1.1", agentPort: 8443, agentTokenEnc: "tok", tlsFingerprint: "AA" },
      { id: "srv-b", host: "2.2.2.2", agentPort: 8443, agentTokenEnc: "tok", tlsFingerprint: "BB" },
    ]);

    await runSampleCycle();

    const updatedIds = fakePrisma.server.update.mock.calls.map((c: [{ where: { id: string } }]) => c[0].where.id);
    expect(updatedIds).toEqual(expect.arrayContaining(["srv-a", "srv-b"]));
  });

  it("does not update lastSeenAt for a server whose agent is unreachable", async () => {
    agentGetMock.mockRejectedValue(new Error("connection refused"));
    fakePrisma.server.findMany.mockResolvedValueOnce([
      { id: "srv-c", host: "3.3.3.3", agentPort: 8443, agentTokenEnc: "tok", tlsFingerprint: "CC" },
    ]);

    await runSampleCycle();

    expect(fakePrisma.server.update).not.toHaveBeenCalled();
  });
});

describe("sweepStuckDeployments (defense in depth for the DEPLOYING-forever bug)", () => {
  it("force-fails a tunnel stuck at DEPLOYING past the timeout with no active deployment", async () => {
    const staleDate = new Date(Date.now() - 15 * 60 * 1000); // 15 minutes ago
    fakePrisma.__tunnels.set("t-stuck", {
      id: "t-stuck",
      name: "Stuck Tunnel",
      status: "DEPLOYING",
      updatedAt: staleDate,
      sourceServer: serverStub("1.1.1.1"),
      destServer: serverStub("2.2.2.2"),
    });
    agentGetMock.mockResolvedValue(healthyResponse());

    await runSampleCycle();

    expect(fakePrisma.__tunnels.get("t-stuck")!.status).toBe("FAILED");
    expect(fakePrisma.__events.some((e) => e.type === "TUNNEL_DEPLOY_TIMED_OUT")).toBe(true);
  });

  it("leaves a recently-started DEPLOYING tunnel alone (not old enough to be considered stuck)", async () => {
    fakePrisma.__tunnels.set("t-fresh-deploy", {
      id: "t-fresh-deploy",
      name: "Fresh Deploy",
      status: "DEPLOYING",
      updatedAt: new Date(),
      sourceServer: serverStub("1.1.1.1"),
      destServer: serverStub("2.2.2.2"),
    });

    await runSampleCycle();

    expect(fakePrisma.__tunnels.get("t-fresh-deploy")!.status).toBe("DEPLOYING");
  });

  it("honors a shorter settings.stuckDeploymentTimeoutMs -- a tunnel too fresh for the default timeout can still be swept", async () => {
    currentSettings.stuckDeploymentTimeoutMs = 60 * 1000; // 1 minute, instead of the 10-minute default
    fakePrisma.__tunnels.set("t-short-timeout", {
      id: "t-short-timeout",
      name: "Short Timeout",
      status: "DEPLOYING",
      updatedAt: new Date(Date.now() - 2 * 60 * 1000), // 2 minutes ago
      sourceServer: serverStub("1.1.1.1"),
      destServer: serverStub("2.2.2.2"),
    });

    await runSampleCycle();

    expect(fakePrisma.__tunnels.get("t-short-timeout")!.status).toBe("FAILED");
  });
});

describe("stat/log retention (every 20th cycle)", () => {
  it("prunes old TunnelStat and Event rows using settings.statRetentionMs/logRetentionDays", async () => {
    for (let i = 0; i < 20; i++) {
      await runSampleCycle();
    }
    expect(fakePrisma.tunnelStat.deleteMany).toHaveBeenCalledTimes(1);
    expect(fakePrisma.event.deleteMany).toHaveBeenCalledTimes(1);
  });

  it("does not prune before the 20th cycle", async () => {
    for (let i = 0; i < 19; i++) {
      await runSampleCycle();
    }
    expect(fakePrisma.tunnelStat.deleteMany).not.toHaveBeenCalled();
    expect(fakePrisma.event.deleteMany).not.toHaveBeenCalled();
  });
});
