import { beforeEach, describe, expect, it, vi } from "vitest";

// deploy-queue.ts talks to Prisma directly -- a real SQLite DB isn't needed
// to prove the queue's own logic (serialization, retry/backoff, failure
// recording, cancellation), so `@/lib/db` is replaced with a tiny in-memory
// fake that implements just the calls the queue makes.
interface FakeDeploymentRow {
  id: string;
  tunnelId: string;
  kind: string;
  status: string;
  steps: unknown[];
  attempt: number;
  maxAttempts: number;
  startedAt: Date | null;
  finishedAt: Date | null;
}

function createFakePrisma() {
  const deployments = new Map<string, FakeDeploymentRow>();
  let counter = 0;

  return {
    deployment: {
      create: vi.fn(async ({ data }: { data: Partial<FakeDeploymentRow> }) => {
        const id = `deploy-${++counter}`;
        const row: FakeDeploymentRow = {
          id,
          tunnelId: data.tunnelId!,
          kind: data.kind as string,
          status: (data.status as string) ?? "QUEUED",
          steps: (data.steps as unknown[]) ?? [],
          attempt: data.attempt ?? 1,
          maxAttempts: data.maxAttempts ?? 3,
          startedAt: null,
          finishedAt: null,
        };
        deployments.set(id, row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<FakeDeploymentRow> }) => {
        const row = deployments.get(where.id);
        if (!row) throw new Error("not found");
        Object.assign(row, data);
        return row;
      }),
      findUnique: vi.fn(
        async ({ where, select }: { where: { id: string }; select?: Record<string, boolean> }) => {
          const row = deployments.get(where.id);
          if (!row) return null;
          if (!select) return row;
          const picked: Record<string, unknown> = {};
          for (const key of Object.keys(select)) picked[key] = (row as Record<string, unknown>)[key];
          return picked;
        },
      ),
    },
    __rows: deployments,
  };
}

const fakePrisma = createFakePrisma();
vi.mock("@/lib/db", () => ({ prisma: fakePrisma }));

// enqueue() falls back to settings.deploymentMaxAttempts when no explicit
// maxAttempts is passed -- most tests below pass one explicitly, but the
// module still needs a working @/lib/settings to import cleanly.
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

const { DeploymentQueue } = await import("./deploy-queue");

beforeEach(() => {
  fakePrisma.__rows.clear();
});

/** isRetryable() checks err.name === "AgentError" specifically, not just
 * "has a .status property" (OrchestratorError also has one, and so would
 * any accidental bug's thrown value) -- construct a real-shaped one instead
 * of a bare Error, so these tests actually exercise that check rather than
 * happening to pass some looser version of it. */
function agentError(message: string, status?: number): Error {
  const err = new Error(message);
  err.name = "AgentError";
  if (status !== undefined) (err as Error & { status?: number }).status = status;
  return err;
}

describe("DeploymentQueue", () => {
  it("runs a successful handler through to SUCCEEDED", async () => {
    const id = await DeploymentQueue.enqueue({
      tunnelId: "t1",
      kind: "START" as never,
      handler: async (ctx) => {
        await ctx.step("do-it", "started");
        await ctx.step("do-it", "ok");
      },
    });
    await flushQueue();
    expect(fakePrisma.__rows.get(id)!.status).toBe("SUCCEEDED");
    expect(fakePrisma.__rows.get(id)!.steps).toHaveLength(2);
  });

  it("defaults maxAttempts from settings.deploymentMaxAttempts when none is passed explicitly", async () => {
    const id = await DeploymentQueue.enqueue({
      tunnelId: "t1b",
      kind: "START" as never,
      handler: async () => {},
    });
    await flushQueue();
    expect(fakePrisma.__rows.get(id)!.maxAttempts).toBe(3); // from the @/lib/settings mock above
  });

  it("retries a retryable failure and eventually succeeds", async () => {
    let calls = 0;
    const id = await DeploymentQueue.enqueue({
      tunnelId: "t2",
      kind: "START" as never,
      maxAttempts: 3,
      handler: async () => {
        calls++;
        if (calls < 2) {
          throw agentError("agent unreachable"); // AgentError, no status -> retryable
        }
      },
    });
    // Real backoff before the retry (min 1s) -- worth the wall-clock cost to
    // exercise the actual production backoff path rather than faking it.
    await flushQueue(1500);
    expect(calls).toBe(2);
    expect(fakePrisma.__rows.get(id)!.status).toBe("SUCCEEDED");
  }, 10_000);

  it("does not retry a non-retryable (4xx-shaped AgentError) failure", async () => {
    let calls = 0;
    const id = await DeploymentQueue.enqueue({
      tunnelId: "t3",
      kind: "START" as never,
      maxAttempts: 3,
      handler: async () => {
        calls++;
        throw agentError("bad request", 400);
      },
    });
    await flushQueue();
    expect(calls).toBe(1);
    expect(fakePrisma.__rows.get(id)!.status).toBe("FAILED");
  });

  it("never retries a plain/programming error, even one with a .status field", async () => {
    let calls = 0;
    const id = await DeploymentQueue.enqueue({
      tunnelId: "t3b",
      kind: "START" as never,
      maxAttempts: 3,
      handler: async () => {
        calls++;
        throw Object.assign(new TypeError("cannot read property of undefined"), { status: 500 });
      },
    });
    await flushQueue();
    expect(calls).toBe(1);
    expect(fakePrisma.__rows.get(id)!.status).toBe("FAILED");
  });

  it("gives up after maxAttempts and marks the deployment FAILED", async () => {
    let calls = 0;
    const id = await DeploymentQueue.enqueue({
      tunnelId: "t4",
      kind: "START" as never,
      maxAttempts: 2,
      handler: async () => {
        calls++;
        throw agentError("agent unreachable");
      },
    });
    await flushQueue(1500);
    expect(calls).toBe(2);
    expect(fakePrisma.__rows.get(id)!.status).toBe("FAILED");
  }, 10_000);

  it("serializes jobs for the same tunnel id", async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      DeploymentQueue.enqueue({
        tunnelId: "same-tunnel",
        kind: "START" as never,
        handler: async () => {
          order.push("first-start");
          resolve();
          await new Promise<void>((r) => (releaseFirst = r));
          order.push("first-end");
        },
      });
    });
    await firstStarted;

    const secondDone = DeploymentQueue.enqueue({
      tunnelId: "same-tunnel",
      kind: "STOP" as never,
      handler: async () => {
        order.push("second-start");
      },
    });

    // second must not have started yet -- first hasn't released.
    await new Promise((r) => setTimeout(r, 20));
    expect(order).toEqual(["first-start"]);

    releaseFirst();
    await secondDone;
    await new Promise((r) => setTimeout(r, 20));
    expect(order).toEqual(["first-start", "first-end", "second-start"]);
  });

  it("does not serialize jobs for different tunnel ids", async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;
    await DeploymentQueue.enqueue({
      tunnelId: "tunnel-a",
      kind: "START" as never,
      handler: async () => {
        order.push("a-start");
        await new Promise<void>((r) => (releaseFirst = r));
        order.push("a-end");
      },
    });
    await new Promise((r) => setTimeout(r, 10));

    await DeploymentQueue.enqueue({
      tunnelId: "tunnel-b",
      kind: "START" as never,
      handler: async () => {
        order.push("b-start");
      },
    });
    await new Promise((r) => setTimeout(r, 20));

    // b must have run without waiting for a to release.
    expect(order).toContain("b-start");
    expect(order).not.toContain("a-end");
    releaseFirst();
  });

  it("cancel() aborts a job already in flight and marks it CANCELLED", async () => {
    let handlerStarted = false;
    let sawAbort = false;
    let resolveStarted!: () => void;
    const started = new Promise<void>((resolve) => (resolveStarted = resolve));

    const id = await DeploymentQueue.enqueue({
      tunnelId: "t5",
      kind: "START" as never,
      handler: async (ctx) => {
        handlerStarted = true;
        resolveStarted();
        // Poll for the abort instead of a fixed sleep, so this doesn't race
        // against when the test below actually calls cancel().
        for (let i = 0; i < 50 && !ctx.signal.aborted; i++) {
          await new Promise((r) => setTimeout(r, 5));
        }
        if (ctx.signal.aborted) {
          sawAbort = true;
          throw new Error("aborted");
        }
      },
    });

    await started;
    DeploymentQueue.cancel(id);
    await flushQueue(100);
    expect(handlerStarted).toBe(true);
    expect(sawAbort).toBe(true);
    expect(fakePrisma.__rows.get(id)!.status).toBe("CANCELLED");
  });

  it("cancel() on an already-queued job prevents its handler from running", async () => {
    let handlerRan = false;
    const id = await DeploymentQueue.enqueue({
      tunnelId: "t6",
      kind: "START" as never,
      handler: async () => {
        handlerRan = true;
      },
    });
    // Cancelled before the queue ever gets to run it (no prior job on this
    // tunnel id, so it would otherwise start on the next microtask).
    DeploymentQueue.cancel(id);
    await flushQueue(30);
    expect(handlerRan).toBe(false);
    expect(fakePrisma.__rows.get(id)!.status).toBe("CANCELLED");
  });
});

/** Deployment jobs run on their own promise chain, decoupled from the
 * enqueue() caller -- give pending timers/microtasks room to settle before
 * asserting on final state. */
async function flushQueue(ms = 10) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
