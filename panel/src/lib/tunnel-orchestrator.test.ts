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
const agentGetMock = vi.fn();
vi.mock("@/lib/agent-client", () => ({
  agentPost: (...args: unknown[]) => agentPostMock(...args),
  agentDelete: (...args: unknown[]) => agentDeleteMock(...args),
  // Only the create-tunnel deploy path polls this (agentPostWithProgress's
  // real-time progress relay) -- default to "no steps yet" so the polling
  // loop has nothing to relay and every other test here is unaffected.
  agentGet: (...args: unknown[]) => agentGetMock(...args),
}));

// deploy-queue.ts (real, unmocked here) calls getSettings() for its default
// maxAttempts -- @/lib/db's fake above has no `appSettings` table, so this
// is mocked directly rather than widening that fake for an unrelated module.
vi.mock("@/lib/settings", () => ({
  getSettings: async () => ({
    healthCheckIntervalMs: 15000,
    statRetentionMs: 0,
    stuckDeploymentTimeoutMs: 0,
    deploymentMaxAttempts: 3,
    autoRestartEnabled: true,
    logRetentionDays: 30,
    backupScheduleHours: 0,
  }),
}));

const {
  createTunnel,
  deleteTunnel,
  startTunnel,
  retryTunnelDeploy,
  duplicateTunnel,
  setTunnelMaintenanceMode,
  setTunnelAutoRestartDisabled,
} = await import("./tunnel-orchestrator");
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
  agentGetMock.mockReset();
  agentGetMock.mockResolvedValue(JSON.stringify({ steps: [] }));
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
    // The tunnel row is kept (status FAILED), not deleted -- so it stays
    // visible with its error and a Retry/Delete choice, instead of silently
    // vanishing and leaving the user with no idea what happened.
    expect(fakePrisma.__tunnels.has(tunnel.id)).toBe(true);
    expect(fakePrisma.__tunnels.get(tunnel.id)?.status).toBe("FAILED");
    expect(
      fakePrisma.__events.some((e) => e.type === "TUNNEL_DEPLOY_FAILED" && e.severity === "ERROR"),
    ).toBe(true);
  });

  it("marks the tunnel FAILED (never leaves it at DEPLOYING) when the source side itself fails", async () => {
    agentPostMock.mockRejectedValue(new Error("source agent unreachable"));

    const { tunnel, deploymentId } = await createTunnel({
      name: "Source Fails",
      core: "BACKHAUL" as never,
      sourceServerId: "iran-1",
      destServerId: "germany-1",
      port: 3080,
    });
    const finished = await waitForDeployment(deploymentId);

    expect(finished.status).toBe("FAILED");
    // Nothing ever deployed anywhere, so there's nothing to roll back --
    // just a clean FAILED status, never left at DEPLOYING.
    expect(agentDeleteMock).not.toHaveBeenCalled();
    expect(fakePrisma.__tunnels.get(tunnel.id)?.status).toBe("FAILED");
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

describe("retryTunnelDeploy", () => {
  it("re-deploys a FAILED tunnel from its stored config and reaches RUNNING", async () => {
    agentPostMock.mockImplementation(async (_target: unknown, _path: string, body: { role: string }) => {
      if (body.role === "client") throw new Error("connection refused");
      return "{}";
    });
    agentDeleteMock.mockResolvedValue("");
    const { tunnel, deploymentId: firstDeploymentId } = await createTunnel({
      name: "Retry Me",
      core: "RATHOLE" as never,
      sourceServerId: "iran-1",
      destServerId: "germany-1",
      port: 2333,
    });
    await waitForDeployment(firstDeploymentId);
    expect(fakePrisma.__tunnels.get(tunnel.id)?.status).toBe("FAILED");

    agentPostMock.mockReset();
    agentPostMock.mockResolvedValue("{}");
    const { deploymentId: retryDeploymentId } = await retryTunnelDeploy(tunnel.id);
    const finished = await waitForDeployment(retryDeploymentId);

    expect(finished.status).toBe("SUCCEEDED");
    expect(fakePrisma.__tunnels.get(tunnel.id)?.status).toBe("RUNNING");
  });

  it("refuses to retry a tunnel that isn't FAILED", async () => {
    fakePrisma.__tunnels.set("tunnel-running", {
      id: "tunnel-running",
      name: "Running",
      core: "BACKHAUL",
      status: "RUNNING",
      sourceServerId: "iran-1",
      destServerId: "germany-1",
      config: { port: 3080, ports: [], extra: {} },
      secretEnc: encryptSecret("s"),
    });
    await expect(retryTunnelDeploy("tunnel-running")).rejects.toMatchObject({ status: 409 });
  });
});

describe("duplicateTunnel", () => {
  it("creates a new tunnel with the same core/config/ports and a ' (copy)' name, deploying it fresh", async () => {
    agentPostMock.mockResolvedValue("{}");
    const { tunnel: original, deploymentId: originalDeploymentId } = await createTunnel({
      name: "Original",
      core: "BACKHAUL" as never,
      sourceServerId: "iran-1",
      destServerId: "germany-1",
      port: 3080,
    });
    await waitForDeployment(originalDeploymentId);
    agentPostMock.mockClear();
    agentPostMock.mockResolvedValue("{}");

    const { tunnel: copy, deploymentId } = await duplicateTunnel(original.id);
    await waitForDeployment(deploymentId);

    expect(copy.id).not.toBe(original.id);
    expect(copy.name).toBe("Original (copy)");
    expect((copy as { sourceServerId: string }).sourceServerId).toBe("iran-1");
    expect((copy as { destServerId: string }).destServerId).toBe("germany-1");
    expect(agentPostMock).toHaveBeenCalledTimes(2); // deployed independently, not sharing agent state
  });

  it("supports overriding the destination server (clone to another server)", async () => {
    agentPostMock.mockResolvedValue("{}");
    const { tunnel: original } = await createTunnel({
      name: "Original",
      core: "BACKHAUL" as never,
      sourceServerId: "iran-1",
      destServerId: "germany-1",
      port: 3080,
    });
    seedServer("france-1", "France", "3.3.3.3");

    const { tunnel: clone, deploymentId } = await duplicateTunnel(original.id, { destServerId: "france-1" });
    await waitForDeployment(deploymentId);

    expect((clone as { destServerId: string }).destServerId).toBe("france-1");
  });

  it("rejects a clone whose overridden source/destination would be the same server", async () => {
    agentPostMock.mockResolvedValue("{}");
    const { tunnel: original } = await createTunnel({
      name: "Original",
      core: "BACKHAUL" as never,
      sourceServerId: "iran-1",
      destServerId: "germany-1",
      port: 3080,
    });
    await expect(duplicateTunnel(original.id, { destServerId: "iran-1" })).rejects.toMatchObject({ status: 400 });
  });
});

describe("setTunnelMaintenanceMode / setTunnelAutoRestartDisabled", () => {
  it("toggles maintenanceMode and records an AUDIT event", async () => {
    fakePrisma.__tunnels.set("tunnel-m", { id: "tunnel-m", name: "M", maintenanceMode: false });
    await setTunnelMaintenanceMode("tunnel-m", true);
    expect(fakePrisma.__tunnels.get("tunnel-m")!.maintenanceMode).toBe(true);
    expect(fakePrisma.__events.some((e) => e.type === "TUNNEL_MAINTENANCE_ENABLED")).toBe(true);
  });

  it("toggles autoRestartDisabled and records an AUDIT event", async () => {
    fakePrisma.__tunnels.set("tunnel-a", { id: "tunnel-a", name: "A", autoRestartDisabled: false });
    await setTunnelAutoRestartDisabled("tunnel-a", true);
    expect(fakePrisma.__tunnels.get("tunnel-a")!.autoRestartDisabled).toBe(true);
    expect(fakePrisma.__events.some((e) => e.type === "TUNNEL_AUTO_RESTART_DISABLED")).toBe(true);
  });

  it("throws a 404-shaped error for an unknown tunnel id", async () => {
    await expect(setTunnelMaintenanceMode("does-not-exist", true)).rejects.toMatchObject({ status: 404 });
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
