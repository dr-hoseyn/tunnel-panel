import { beforeEach, describe, expect, it, vi } from "vitest";

interface Row {
  id: string;
  [key: string]: unknown;
}

function createFakePrisma() {
  const events: Row[] = [];
  const notifications: Row[] = [];
  const servers: Row[] = [];
  let counter = 0;

  // Minimal where-clause interpreter, matching health-sampler.test.ts's own
  // approach: only the specific patterns notification-sampler.ts actually
  // queries with, not a general Prisma emulation.
  return {
    event: {
      findMany: vi.fn(async ({ where }: { where?: { createdAt?: { gte?: Date } } } = {}) => {
        const gte = where?.createdAt?.gte;
        return events.filter((e) => !gte || (e.createdAt as Date) >= gte);
      }),
    },
    notification: {
      findMany: vi.fn(async ({ where }: { where?: { sourceEventId?: { in?: string[] } } } = {}) => {
        const ids = new Set(where?.sourceEventId?.in ?? []);
        return notifications.filter((n) => ids.has(n.sourceEventId as string)).map((n) => ({ sourceEventId: n.sourceEventId }));
      }),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `notif-${++counter}`, read: false, ...data };
        notifications.push(row);
        return row;
      }),
    },
    server: {
      findMany: vi.fn(async () => servers),
    },
    __events: events,
    __notifications: notifications,
    __servers: servers,
  };
}

const fakePrisma = createFakePrisma();
vi.mock("@/lib/db", () => ({ prisma: fakePrisma }));

const { runNotificationSampleCycle, shouldNotify } = await import("./notification-sampler");

function seedEvent(overrides: Partial<Row> & { id: string }) {
  fakePrisma.__events.push({
    type: "SOMETHING",
    severity: "INFO",
    message: "default message",
    serverId: null,
    tunnelId: null,
    createdAt: new Date(),
    ...overrides,
  });
}

function seedServer(overrides: Partial<Row> & { id: string }) {
  fakePrisma.__servers.push({ name: `Server ${overrides.id}`, lastSeenAt: new Date(), ...overrides });
}

beforeEach(() => {
  fakePrisma.__events.length = 0;
  fakePrisma.__notifications.length = 0;
  fakePrisma.__servers.length = 0;
  fakePrisma.event.findMany.mockClear();
  fakePrisma.notification.findMany.mockClear();
  fakePrisma.notification.create.mockClear();
  fakePrisma.server.findMany.mockClear();
});

describe("shouldNotify", () => {
  it("is true for any ERROR-severity event regardless of type", () => {
    expect(shouldNotify({ severity: "ERROR", type: "ANYTHING" })).toBe(true);
  });

  it("is true for specific WARNING/INFO types worth surfacing", () => {
    expect(shouldNotify({ severity: "INFO", type: "TOKEN_ROTATED" })).toBe(true);
    expect(shouldNotify({ severity: "WARNING", type: "TUNNEL_AUTO_RESTART" })).toBe(true);
    expect(shouldNotify({ severity: "WARNING", type: "TUNNEL_DELETE_CLEANUP_INCOMPLETE" })).toBe(true);
  });

  it("is false for ordinary INFO/WARNING events not on the allow-list", () => {
    expect(shouldNotify({ severity: "INFO", type: "TUNNEL_CREATED" })).toBe(false);
    expect(shouldNotify({ severity: "WARNING", type: "TUNNEL_HEALTH_WARNING" })).toBe(false);
  });
});

describe("deriving Notifications from Event rows", () => {
  it("converts a worthy (ERROR) event into a Notification carrying its context", async () => {
    seedEvent({
      id: "evt-1",
      type: "TUNNEL_HEALTH_FAILED",
      severity: "ERROR",
      message: 'Tunnel "X" failed health checks.',
      tunnelId: "t-1",
    });

    await runNotificationSampleCycle();

    expect(fakePrisma.__notifications).toHaveLength(1);
    const n = fakePrisma.__notifications[0];
    expect(n.sourceEventId).toBe("evt-1");
    expect(n.severity).toBe("ERROR");
    expect(n.tunnelId).toBe("t-1");
    expect(n.message).toBe('Tunnel "X" failed health checks.');
    expect(n.title).toBe("Tunnel health check failed");
  });

  it("converts an INFO-severity but allow-listed event type (TOKEN_ROTATED)", async () => {
    seedEvent({ id: "evt-2", type: "TOKEN_ROTATED", severity: "INFO", message: "token rotated", serverId: "s-1" });

    await runNotificationSampleCycle();

    expect(fakePrisma.__notifications).toHaveLength(1);
    expect(fakePrisma.__notifications[0].sourceEventId).toBe("evt-2");
  });

  it("does not convert an ordinary WARNING event outside the allow-list", async () => {
    seedEvent({ id: "evt-3", type: "TUNNEL_HEALTH_WARNING", severity: "WARNING", message: "degraded" });

    await runNotificationSampleCycle();

    expect(fakePrisma.__notifications).toHaveLength(0);
  });

  it("is idempotent: re-running the cycle over the same event never creates a duplicate", async () => {
    seedEvent({ id: "evt-4", type: "TUNNEL_HEALTH_FAILED", severity: "ERROR", message: "failed" });

    await runNotificationSampleCycle();
    await runNotificationSampleCycle();
    await runNotificationSampleCycle();

    expect(fakePrisma.__notifications).toHaveLength(1);
    expect(fakePrisma.notification.create).toHaveBeenCalledTimes(1);
  });

  it("ignores events older than the lookback window", async () => {
    seedEvent({
      id: "evt-old",
      type: "TUNNEL_HEALTH_FAILED",
      severity: "ERROR",
      message: "ancient",
      createdAt: new Date(Date.now() - 60 * 60 * 1000), // 1 hour ago
    });

    await runNotificationSampleCycle();

    expect(fakePrisma.__notifications).toHaveLength(0);
  });
});

describe("deriving a Notification from a server going stale", () => {
  it("flags a server whose lastSeenAt is null as offline", async () => {
    seedServer({ id: "srv-1", lastSeenAt: null });

    await runNotificationSampleCycle();

    expect(fakePrisma.__notifications).toHaveLength(1);
    expect(fakePrisma.__notifications[0].type).toBe("SERVER_OFFLINE");
    expect(fakePrisma.__notifications[0].serverId).toBe("srv-1");
  });

  it("flags a server whose lastSeenAt is well past the stale threshold", async () => {
    seedServer({ id: "srv-2", lastSeenAt: new Date(Date.now() - 5 * 60 * 1000) });

    await runNotificationSampleCycle();

    expect(fakePrisma.__notifications.some((n) => n.serverId === "srv-2" && n.type === "SERVER_OFFLINE")).toBe(true);
  });

  it("does not flag a server with a fresh lastSeenAt", async () => {
    seedServer({ id: "srv-3", lastSeenAt: new Date() });

    await runNotificationSampleCycle();

    expect(fakePrisma.__notifications).toHaveLength(0);
  });

  it("does not re-notify for the same ongoing offline streak on later cycles", async () => {
    seedServer({ id: "srv-4", lastSeenAt: null });

    await runNotificationSampleCycle();
    await runNotificationSampleCycle();
    await runNotificationSampleCycle();

    expect(fakePrisma.__notifications.filter((n) => n.serverId === "srv-4")).toHaveLength(1);
  });

  it("notifies again once a server recovers and then goes stale a second time", async () => {
    const server = { id: "srv-5", name: "Server srv-5", lastSeenAt: null as Date | null };
    fakePrisma.__servers.push(server);

    await runNotificationSampleCycle(); // first outage -> notified
    expect(fakePrisma.__notifications.filter((n) => n.serverId === "srv-5")).toHaveLength(1);

    server.lastSeenAt = new Date(); // recovers
    await runNotificationSampleCycle();

    server.lastSeenAt = null; // goes stale again
    await runNotificationSampleCycle();

    expect(fakePrisma.__notifications.filter((n) => n.serverId === "srv-5")).toHaveLength(2);
  });
});
