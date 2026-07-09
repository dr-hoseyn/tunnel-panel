import { beforeEach, describe, expect, it, vi } from "vitest";

const authMock = vi.fn();
vi.mock("@/auth", () => ({ auth: () => authMock() }));

const findManyMock = vi.fn();
vi.mock("@/lib/db", () => ({
  prisma: { notification: { findMany: (...args: unknown[]) => findManyMock(...args) } },
}));

const { GET } = await import("./route");

function sessionWithRole(role: string) {
  return { user: { id: "u1", email: "a@b.com", role } };
}

beforeEach(() => {
  authMock.mockReset();
  findManyMock.mockReset();
  findManyMock.mockResolvedValue([]);
});

describe("GET /api/v1/notifications", () => {
  it("returns 401 when unauthenticated", async () => {
    authMock.mockResolvedValue(null);
    const res = await GET(new Request("http://localhost/api/v1/notifications"));
    expect(res.status).toBe(401);
  });

  it("allows VIEWER (reading your own notifications isn't privileged)", async () => {
    authMock.mockResolvedValue(sessionWithRole("VIEWER"));
    const res = await GET(new Request("http://localhost/api/v1/notifications"));
    expect(res.status).toBe(200);
  });

  it("orders newest first with a default limit and no filter", async () => {
    authMock.mockResolvedValue(sessionWithRole("VIEWER"));
    await GET(new Request("http://localhost/api/v1/notifications"));
    expect(findManyMock).toHaveBeenCalledWith({
      where: undefined,
      orderBy: { createdAt: "desc" },
      take: 20,
    });
  });

  it("filters to unread only when ?unread=true", async () => {
    authMock.mockResolvedValue(sessionWithRole("VIEWER"));
    await GET(new Request("http://localhost/api/v1/notifications?unread=true"));
    expect(findManyMock).toHaveBeenCalledWith(expect.objectContaining({ where: { read: false } }));
  });

  it("respects a valid ?limit=", async () => {
    authMock.mockResolvedValue(sessionWithRole("VIEWER"));
    await GET(new Request("http://localhost/api/v1/notifications?limit=5"));
    expect(findManyMock).toHaveBeenCalledWith(expect.objectContaining({ take: 5 }));
  });

  it("clamps an oversized ?limit= to the max", async () => {
    authMock.mockResolvedValue(sessionWithRole("VIEWER"));
    await GET(new Request("http://localhost/api/v1/notifications?limit=100000"));
    expect(findManyMock).toHaveBeenCalledWith(expect.objectContaining({ take: 100 }));
  });

  it("falls back to the default limit for a bogus ?limit=", async () => {
    authMock.mockResolvedValue(sessionWithRole("VIEWER"));
    await GET(new Request("http://localhost/api/v1/notifications?limit=not-a-number"));
    expect(findManyMock).toHaveBeenCalledWith(expect.objectContaining({ take: 20 }));
  });

  it("returns the notifications from the list", async () => {
    authMock.mockResolvedValue(sessionWithRole("VIEWER"));
    findManyMock.mockResolvedValue([{ id: "n1" }]);
    const res = await GET(new Request("http://localhost/api/v1/notifications"));
    expect(await res.json()).toEqual({ notifications: [{ id: "n1" }] });
  });
});
