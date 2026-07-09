import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * route.ts talks to Prisma directly -- replaced here with a tiny in-memory
 * fake covering exactly the shapes route.ts's own findMany calls use (same
 * pattern as tunnel-orchestrator.test.ts's fake). Each fake findMany
 * re-implements its filter the way the real SQLite-backed Prisma call would
 * behave, in particular case-insensitive `contains` -- this is what proves
 * the route's mixed-case search actually works end to end, rather than just
 * asserting the route *calls* Prisma with the right arguments.
 */
interface Row {
  id: string;
  [key: string]: unknown;
}

function containsCI(value: string | null | undefined, needle: string): boolean {
  if (value == null) return false;
  return value.toLowerCase().includes(needle.toLowerCase());
}

function byCreatedDesc(rows: Row[]): Row[] {
  return [...rows].sort((a, b) => (b.createdAt as Date).getTime() - (a.createdAt as Date).getTime());
}

function project(row: Row, select?: Record<string, unknown>): Row {
  if (!select) return row;
  const out: Row = {};
  for (const key of Object.keys(select)) {
    const spec = select[key];
    if (spec && typeof spec === "object" && "select" in (spec as object)) {
      out[key] = project(row[key] as Row, (spec as { select: Record<string, unknown> }).select);
    } else {
      out[key] = row[key];
    }
  }
  return out;
}

function createFakePrisma() {
  const servers = new Map<string, Row>();
  const tunnels = new Map<string, Row>();
  const users = new Map<string, Row>();
  const events = new Map<string, Row>();

  return {
    server: {
      findMany: vi.fn(
        async ({
          where,
          select,
          take,
        }: {
          where: { OR: { name?: { contains: string }; host?: { contains: string }; location?: { contains: string } }[] };
          select?: Record<string, unknown>;
          take?: number;
        }) => {
          const needle = where.OR[0].name!.contains;
          const matches = [...servers.values()].filter(
            (r) =>
              containsCI(r.name as string, needle) ||
              containsCI(r.host as string, needle) ||
              containsCI(r.location as string | null, needle),
          );
          return byCreatedDesc(matches)
            .slice(0, take)
            .map((r) => project(r, select));
        },
      ),
    },
    tunnel: {
      findMany: vi.fn(
        async ({ select, take }: { select?: Record<string, unknown>; take?: number }) =>
          byCreatedDesc([...tunnels.values()])
            .slice(0, take)
            .map((r) => project(r, select)),
      ),
    },
    user: {
      findMany: vi.fn(
        async ({
          where,
          select,
          take,
        }: {
          where: { email: { contains: string } };
          select?: Record<string, unknown>;
          take?: number;
        }) => {
          const matches = [...users.values()].filter((r) => containsCI(r.email as string, where.email.contains));
          return byCreatedDesc(matches)
            .slice(0, take)
            .map((r) => project(r, select));
        },
      ),
    },
    event: {
      findMany: vi.fn(
        async ({
          where,
          select,
          take,
        }: {
          where: { message: { contains: string } };
          select?: Record<string, unknown>;
          take?: number;
        }) => {
          const matches = [...events.values()].filter((r) => containsCI(r.message as string, where.message.contains));
          return byCreatedDesc(matches)
            .slice(0, take)
            .map((r) => project(r, select));
        },
      ),
    },
    __servers: servers,
    __tunnels: tunnels,
    __users: users,
    __events: events,
  };
}

const fakePrisma = createFakePrisma();
vi.mock("@/lib/db", () => ({ prisma: fakePrisma }));

const authMock = vi.fn();
vi.mock("@/auth", () => ({ auth: () => authMock() }));

const { GET } = await import("./route");

let counter = 0;
const nextId = (prefix: string) => `${prefix}-${++counter}`;

function sessionWithRole(role: string | undefined) {
  return { user: { id: "u1", email: "session@example.com", role } };
}

function seedServer(overrides: Partial<Row> = {}): Row {
  const row: Row = {
    id: nextId("server"),
    name: "Server",
    host: "10.0.0.1",
    location: null,
    createdAt: new Date(),
    ...overrides,
  };
  fakePrisma.__servers.set(row.id, row);
  return row;
}

function seedTunnel(overrides: Partial<Row> = {}): Row {
  const row: Row = {
    id: nextId("tunnel"),
    name: "Tunnel",
    core: "BACKHAUL",
    config: { port: 3080, ports: [] },
    sourceServer: { name: "Iran" },
    destServer: { name: "Germany" },
    createdAt: new Date(),
    ...overrides,
  };
  fakePrisma.__tunnels.set(row.id, row);
  return row;
}

function seedUser(overrides: Partial<Row> = {}): Row {
  const row: Row = {
    id: nextId("user"),
    email: "user@example.com",
    role: "VIEWER",
    createdAt: new Date(),
    ...overrides,
  };
  fakePrisma.__users.set(row.id, row);
  return row;
}

function seedEvent(overrides: Partial<Row> = {}): Row {
  const row: Row = {
    id: nextId("event"),
    message: "Something happened",
    category: "AUDIT",
    severity: "INFO",
    createdAt: new Date(),
    ...overrides,
  };
  fakePrisma.__events.set(row.id, row);
  return row;
}

function req(q: string) {
  return new Request(`http://localhost/api/v1/search?q=${encodeURIComponent(q)}`);
}

beforeEach(() => {
  authMock.mockReset();
  fakePrisma.__servers.clear();
  fakePrisma.__tunnels.clear();
  fakePrisma.__users.clear();
  fakePrisma.__events.clear();
  fakePrisma.server.findMany.mockClear();
  fakePrisma.tunnel.findMany.mockClear();
  fakePrisma.user.findMany.mockClear();
  fakePrisma.event.findMany.mockClear();
});

describe("GET /api/v1/search", () => {
  it("returns 401 when there is no session", async () => {
    authMock.mockResolvedValue(null);
    const res = await GET(req("hello"));
    expect(res.status).toBe(401);
  });

  it("returns all-empty groups for a query under 2 characters, without touching Prisma", async () => {
    authMock.mockResolvedValue(sessionWithRole("VIEWER"));
    seedServer({ name: "a" });
    const res = await GET(req("a"));
    expect(await res.json()).toEqual({ servers: [], tunnels: [], users: [], events: [] });
    expect(fakePrisma.server.findMany).not.toHaveBeenCalled();
  });

  describe("case-insensitivity", () => {
    it("matches a server whose name differs in case from the query", async () => {
      authMock.mockResolvedValue(sessionWithRole("VIEWER"));
      seedServer({ name: "Server-Alpha", host: "203.0.113.10" });
      const res = await GET(req("SERVER-a"));
      const body = await res.json();
      expect(body.servers).toHaveLength(1);
      expect(body.servers[0]).toMatchObject({ kind: "server", label: "Server-Alpha" });
    });

    it("matches an event message with the opposite case of the query", async () => {
      authMock.mockResolvedValue(sessionWithRole("VIEWER"));
      seedEvent({ message: "Agent Connection Restored" });
      const res = await GET(req("connection restored"));
      const body = await res.json();
      expect(body.events).toHaveLength(1);
      expect(body.events[0].label).toBe("Agent Connection Restored");
    });

    it("matches a user email case-insensitively (admin caller)", async () => {
      authMock.mockResolvedValue(sessionWithRole("ADMIN"));
      seedUser({ email: "Ops@Example.com" });
      const res = await GET(req("OPS@example"));
      const body = await res.json();
      expect(body.users).toHaveLength(1);
      expect(body.users[0].label).toBe("Ops@Example.com");
    });
  });

  describe("tunnel port-number matching", () => {
    it("matches a tunnel whose config.port equals the numeric query", async () => {
      authMock.mockResolvedValue(sessionWithRole("VIEWER"));
      seedTunnel({ name: "web-forward", config: { port: 8080, ports: [] } });
      seedTunnel({ name: "unrelated", config: { port: 3080, ports: [] } });
      const res = await GET(req("8080"));
      const body = await res.json();
      expect(body.tunnels).toHaveLength(1);
      expect(body.tunnels[0].label).toBe("web-forward");
    });

    it("matches a tunnel via its ports[] array (remote or local)", async () => {
      authMock.mockResolvedValue(sessionWithRole("VIEWER"));
      seedTunnel({
        name: "multi-port",
        config: { port: 1, ports: [{ remote: 9090, local: 80 }] },
      });
      const remoteMatch = await (await GET(req("9090"))).json();
      expect(remoteMatch.tunnels.map((t: { label: string }) => t.label)).toContain("multi-port");
      const localMatch = await (await GET(req("80"))).json();
      expect(localMatch.tunnels.map((t: { label: string }) => t.label)).toContain("multi-port");
    });

    it("does not treat an out-of-range or non-numeric query as a port", async () => {
      authMock.mockResolvedValue(sessionWithRole("VIEWER"));
      seedTunnel({ name: "irrelevant", config: { port: 99999, ports: [] } });
      const outOfRange = await (await GET(req("99999"))).json();
      expect(outOfRange.tunnels).toHaveLength(0);

      seedTunnel({ name: "irrelevant-2", config: { port: 3, ports: [] } });
      const notAllDigits = await (await GET(req("3.5"))).json();
      expect(notAllDigits.tunnels).toHaveLength(0);
    });

    it("matches a tunnel by core name", async () => {
      authMock.mockResolvedValue(sessionWithRole("VIEWER"));
      seedTunnel({ name: "core-search", core: "GOST" });
      const res = await GET(req("gost"));
      const body = await res.json();
      expect(body.tunnels.map((t: { label: string }) => t.label)).toContain("core-search");
    });
  });

  describe("RBAC filtering of Users results", () => {
    beforeEach(() => {
      seedUser({ email: "target-user@example.com" });
    });

    it.each(["VIEWER", "OPERATOR"])("omits users entirely for a %s caller", async (role) => {
      authMock.mockResolvedValue(sessionWithRole(role));
      const res = await GET(req("target-user"));
      const body = await res.json();
      expect(body.users).toEqual([]);
      // Proves the route skips the query outright rather than fetching and
      // filtering client-side.
      expect(fakePrisma.user.findMany).not.toHaveBeenCalled();
    });

    it("includes matching users for an ADMIN caller", async () => {
      authMock.mockResolvedValue(sessionWithRole("ADMIN"));
      const res = await GET(req("target-user"));
      const body = await res.json();
      expect(body.users).toHaveLength(1);
      expect(body.users[0]).toMatchObject({ kind: "user", label: "target-user@example.com", href: "/users" });
    });
  });

  it("caps each category's results", async () => {
    authMock.mockResolvedValue(sessionWithRole("ADMIN"));
    for (let i = 0; i < 10; i++) {
      seedServer({ name: `capped-server-${i}` });
    }
    const res = await GET(req("capped-server"));
    const body = await res.json();
    expect(body.servers.length).toBeLessThanOrEqual(6);
  });
});
