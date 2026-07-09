import { beforeEach, describe, expect, it, vi } from "vitest";

interface Row {
  id: string;
  [key: string]: unknown;
}

function createFakePrisma() {
  const tunnels = new Map<string, Row>();
  const events: Row[] = [];
  const stats: Row[] = [];

  return {
    server: {
      update: vi.fn(async () => ({})),
    },
    tunnel: {
      findMany: vi.fn(async () => Array.from(tunnels.values())),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = tunnels.get(where.id);
        if (!row) throw new Error("not found");
        Object.assign(row, data);
        return row;
      }),
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

const { runSampleCycle } = await import("./health-sampler");

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

beforeEach(() => {
  fakePrisma.__tunnels.clear();
  fakePrisma.__events.length = 0;
  fakePrisma.__stats.length = 0;
  agentGetMock.mockReset();
  restartTunnelMock.mockReset();
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

  it("recovers back to RUNNING once health checks succeed again", async () => {
    seedTunnel("t-recover");
    agentGetMock.mockResolvedValue(unhealthyResponse());
    await runSampleCycle(); // WARNING

    agentGetMock.mockResolvedValue(healthyResponse());
    await runSampleCycle(); // healthy again

    expect(fakePrisma.__tunnels.get("t-recover")!.status).toBe("RUNNING");
  });
});
