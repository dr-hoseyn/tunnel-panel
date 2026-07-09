import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

beforeAll(() => {
  process.env.AGENT_TOKEN_ENC_KEY = Buffer.alloc(32).toString("base64");
});

// tunnel-orchestrator.ts (and the deploy-queue.ts it drives) talk to Prisma
// directly -- replaced here with a tiny in-memory fake covering exactly the
// calls both modules make, so this test proves the orchestrator's own
// sequencing/rollback logic without a real SQLite DB or Prisma client.
interface Row {
  id: string;
  [key: string]: unknown;
}

function createFakePrisma() {
  const servers = new Map<string, Row>();
  const tunnels = new Map<string, Row>();
  const deployments = new Map<string, Row>();
  const events: Row[] = [];
  let counter = 0;
  const nextId = (prefix: string) => `${prefix}-${++counter}`;

  return {
    server: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => servers.get(where.id) ?? null),
    },
    tunnel: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row: Row = { id: nextId("tunnel"), ...data };
        tunnels.set(row.id, row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = tunnels.get(where.id);
        if (!row) throw new Error("tunnel not found");
        Object.assign(row, data);
        return row;
      }),
      delete: vi.fn(async ({ where }: { where: { id: string } }) => {
        const row = tunnels.get(where.id);
        if (!row) throw new Error("tunnel not found");
        tunnels.delete(where.id);
        return row;
      }),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => tunnels.get(where.id) ?? null),
    },
    deployment: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row: Row = {
          id: nextId("deploy"),
          attempt: 1,
          startedAt: null,
          finishedAt: null,
          ...data,
        };
        deployments.set(row.id, row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = deployments.get(where.id);
        if (!row) throw new Error("deployment not found");
        Object.assign(row, data);
        return row;
      }),
      findUnique: vi.fn(
        async ({ where, select }: { where: { id: string }; select?: Record<string, boolean> }) => {
          const row = deployments.get(where.id);
          if (!row) return null;
          if (!select) return row;
          const picked: Row = { id: row.id };
          for (const key of Object.keys(select)) picked[key] = row[key];
          return picked;
        },
      ),
    },
    event: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row: Row = { id: nextId("event"), ...data };
        events.push(row);
        return row;
      }),
    },
    __servers: servers,
    __tunnels: tunnels,
    __deployments: deployments,
    __events: events,
  };
}

const fakePrisma = createFakePrisma();
vi.mock("@/lib/db", () => ({ prisma: fakePrisma }));

const agentPostMock = vi.fn();
const agentDeleteMock = vi.fn();
vi.mock("@/lib/agent-client", () => ({
  agentPost: (...args: unknown[]) => agentPostMock(...args),
  agentDelete: (...args: unknown[]) => agentDeleteMock(...args),
}));

const { createTunnel, deleteTunnel, startTunnel } = await import("./tunnel-orchestrator");
const { encryptSecret } = await import("./crypto");

function seedServer(id: string, name: string, host: string) {
  fakePrisma.__servers.set(id, {
    id,
    name,
    host,
    agentPort: 8443,
    agentTokenEnc: encryptSecret("agent-token"),
    tlsFingerprint: "AA:BB",
  });
}

beforeEach(() => {
  fakePrisma.__servers.clear();
  fakePrisma.__tunnels.clear();
  fakePrisma.__deployments.clear();
  fakePrisma.__events.length = 0;
  agentPostMock.mockReset();
  agentDeleteMock.mockReset();
  seedServer("iran-1", "Iran", "1.1.1.1");
  seedServer("germany-1", "Germany", "2.2.2.2");
});

async function waitForDeployment(deploymentId: string) {
  for (let i = 0; i < 200; i++) {
    const row = fakePrisma.__deployments.get(deploymentId);
    if (row && (row.status === "SUCCEEDED" || row.status === "FAILED" || row.status === "CANCELLED")) {
      return row;
    }
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("deployment did not finish in time");
}

describe("createTunnel", () => {
  it("deploys the source (server role) then the destination (client role), and marks the tunnel RUNNING", async () => {
    agentPostMock.mockResolvedValue("{}");
    const { tunnel, deploymentId } = await createTunnel({
      name: "Iran-Germany",
      core: "BACKHAUL" as never,
      sourceServerId: "iran-1",
      destServerId: "germany-1",
      port: 3080,
    });
    await waitForDeployment(deploymentId);

    expect(agentPostMock).toHaveBeenCalledTimes(2);
    const [sourceCall, destCall] = agentPostMock.mock.calls;
    expect(sourceCall[2]).toMatchObject({ role: "server", core: "backhaul", port: 3080 });
    expect(destCall[2]).toMatchObject({ role: "client", core: "backhaul", peer: "1.1.1.1:3080" });

    const finalTunnel = fakePrisma.__tunnels.get(tunnel.id);
    expect(finalTunnel?.status).toBe("RUNNING");
    expect(fakePrisma.__events.some((e) => e.type === "TUNNEL_CREATED")).toBe(true);
  });

  it("rolls back the source side and deletes the tunnel row when the destination fails", async () => {
    agentPostMock.mockImplementation(async (_target: unknown, _path: string, body: { role: string }) => {
      if (body.role === "client") throw new Error("connection refused");
      return "{}";
    });
    agentDeleteMock.mockResolvedValue("");

    const { tunnel, deploymentId } = await createTunnel({
      name: "Will Fail",
      core: "RATHOLE" as never,
      sourceServerId: "iran-1",
      destServerId: "germany-1",
      port: 2333,
    });
    const finished = await waitForDeployment(deploymentId);

    expect(finished.status).toBe("FAILED");
    expect(agentDeleteMock).toHaveBeenCalledTimes(1);
    expect(fakePrisma.__tunnels.has(tunnel.id)).toBe(false);
    expect(
      fakePrisma.__events.some((e) => e.type === "TUNNEL_CREATE_ROLLED_BACK" && e.severity === "ERROR"),
    ).toBe(true);
  });

  it("routes forwarded ports to the correct side per core (hysteria2 -> client only)", async () => {
    agentPostMock.mockResolvedValue("{}");
    const { deploymentId } = await createTunnel({
      name: "H2 tunnel",
      core: "HYSTERIA2" as never,
      sourceServerId: "iran-1",
      destServerId: "germany-1",
      port: 36712,
      ports: [{ remote: 22, local: 2222 }],
    });
    await waitForDeployment(deploymentId);

    const [sourceCall, destCall] = agentPostMock.mock.calls;
    expect((sourceCall[2] as { ports?: unknown }).ports).toBeUndefined();
    expect((destCall[2] as { ports?: unknown[] }).ports).toEqual([{ remote: 22, local: 2222 }]);
  });
});

describe("deleteTunnel", () => {
  it("removes both sides and deletes the tunnel row even if one side errors", async () => {
    fakePrisma.__tunnels.set("tunnel-x", {
      id: "tunnel-x",
      name: "X",
      sourceServerId: "iran-1",
      destServerId: "germany-1",
    });
    agentDeleteMock.mockImplementation(async (target: { host: string }) => {
      if (target.host === "2.2.2.2") throw new Error("agent unreachable");
      return "";
    });

    const { deploymentId } = await deleteTunnel("tunnel-x");
    const finished = await waitForDeployment(deploymentId);

    expect(finished.status).toBe("SUCCEEDED");
    expect(agentDeleteMock).toHaveBeenCalledTimes(2);
    expect(fakePrisma.__tunnels.has("tunnel-x")).toBe(false);
  });
});

describe("startTunnel", () => {
  it("posts /start to both agents and marks the tunnel RUNNING", async () => {
    fakePrisma.__tunnels.set("tunnel-y", {
      id: "tunnel-y",
      name: "Y",
      sourceServerId: "iran-1",
      destServerId: "germany-1",
    });
    agentPostMock.mockResolvedValue("{}");

    const { deploymentId } = await startTunnel("tunnel-y");
    await waitForDeployment(deploymentId);

    expect(agentPostMock).toHaveBeenCalledTimes(2);
    for (const call of agentPostMock.mock.calls) {
      expect(call[1]).toBe("/api/v1/managed-tunnels/tunnel-y/start");
    }
    expect(fakePrisma.__tunnels.get("tunnel-y")?.status).toBe("RUNNING");
  });
});
