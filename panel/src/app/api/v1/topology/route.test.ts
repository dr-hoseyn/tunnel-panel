import { beforeEach, describe, expect, it, vi } from "vitest";

// This route talks to Prisma directly for a plain read-only snapshot -- a
// tiny in-memory fake stands in for it, same style as deploy-queue.test.ts.
interface FakeServerRow {
  id: string;
  name: string;
  location: string | null;
  lastSeenAt: Date | null;
  createdAt: Date;
}

interface FakeTunnelRow {
  id: string;
  name: string;
  core: string;
  status: string;
  sourceServerId: string;
  destServerId: string;
  createdAt: Date;
}

const servers: FakeServerRow[] = [];
const tunnels: FakeTunnelRow[] = [];

function applySelect<T extends Record<string, unknown>>(rows: T[], select?: Record<string, boolean>): Partial<T>[] {
  if (!select) return rows;
  return rows.map((row) => {
    const picked: Partial<T> = {};
    for (const key of Object.keys(select)) {
      (picked as Record<string, unknown>)[key] = row[key as keyof T];
    }
    return picked;
  });
}

const fakePrisma = {
  server: {
    findMany: vi.fn(async ({ select }: { select?: Record<string, boolean> } = {}) => {
      const sorted = [...servers].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      return applySelect(sorted, select);
    }),
  },
  tunnel: {
    findMany: vi.fn(async ({ select }: { select?: Record<string, boolean> } = {}) => {
      const sorted = [...tunnels].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      return applySelect(sorted, select);
    }),
  },
};

vi.mock("@/lib/db", () => ({ prisma: fakePrisma }));

const requireRoleResponseMock = vi.fn();
vi.mock("@/lib/rbac", () => ({ requireRoleResponse: (...args: unknown[]) => requireRoleResponseMock(...args) }));

const { GET } = await import("./route");

beforeEach(() => {
  servers.length = 0;
  tunnels.length = 0;
  requireRoleResponseMock.mockReset();
  requireRoleResponseMock.mockResolvedValue({ session: { user: { id: "u1", role: "VIEWER" } } });
});

describe("GET /api/v1/topology", () => {
  it("requires at least the VIEWER role", async () => {
    await GET();
    expect(requireRoleResponseMock).toHaveBeenCalledWith("VIEWER");
  });

  it("returns the 401/403 response as-is when unauthorized", async () => {
    const denied = new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
    requireRoleResponseMock.mockResolvedValue({ response: denied });
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it("returns servers and tunnels ordered by creation time, with lastSeenAt serialized to ISO strings", async () => {
    servers.push(
      { id: "s2", name: "Second", location: null, lastSeenAt: null, createdAt: new Date("2026-01-02T00:00:00Z") },
      {
        id: "s1",
        name: "First",
        location: "Germany",
        lastSeenAt: new Date("2026-07-09T11:59:30Z"),
        createdAt: new Date("2026-01-01T00:00:00Z"),
      },
    );
    tunnels.push({
      id: "t1",
      name: "de-to-ir",
      core: "RATHOLE",
      status: "RUNNING",
      sourceServerId: "s1",
      destServerId: "s2",
      createdAt: new Date("2026-01-03T00:00:00Z"),
    });

    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      servers: { id: string; lastSeenAt: string | null }[];
      tunnels: { id: string }[];
    };

    expect(body.servers.map((s) => s.id)).toEqual(["s1", "s2"]);
    expect(body.servers[0].lastSeenAt).toBe("2026-07-09T11:59:30.000Z");
    expect(body.servers[1].lastSeenAt).toBeNull();
    expect(body.tunnels).toEqual([
      { id: "t1", name: "de-to-ir", core: "RATHOLE", status: "RUNNING", sourceServerId: "s1", destServerId: "s2" },
    ]);
  });

  it("returns empty arrays when there are no servers or tunnels yet", async () => {
    const res = await GET();
    const body = (await res.json()) as { servers: unknown[]; tunnels: unknown[] };
    expect(body).toEqual({ servers: [], tunnels: [] });
  });
});
