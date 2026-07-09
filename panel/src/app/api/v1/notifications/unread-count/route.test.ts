import { beforeEach, describe, expect, it, vi } from "vitest";

const authMock = vi.fn();
vi.mock("@/auth", () => ({ auth: () => authMock() }));

const countMock = vi.fn();
vi.mock("@/lib/db", () => ({ prisma: { notification: { count: (...args: unknown[]) => countMock(...args) } } }));

const { GET } = await import("./route");

beforeEach(() => {
  authMock.mockReset();
  countMock.mockReset();
});

describe("GET /api/v1/notifications/unread-count", () => {
  it("returns 401 when unauthenticated", async () => {
    authMock.mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it("returns the unread count for VIEWER", async () => {
    authMock.mockResolvedValue({ user: { id: "u1", email: "a@b.com", role: "VIEWER" } });
    countMock.mockResolvedValue(3);

    const res = await GET();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ count: 3 });
    expect(countMock).toHaveBeenCalledWith({ where: { read: false } });
  });
});
