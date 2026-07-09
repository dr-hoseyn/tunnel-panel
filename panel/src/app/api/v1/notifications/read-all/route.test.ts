import { beforeEach, describe, expect, it, vi } from "vitest";

const authMock = vi.fn();
vi.mock("@/auth", () => ({ auth: () => authMock() }));

const updateManyMock = vi.fn();
vi.mock("@/lib/db", () => ({
  prisma: { notification: { updateMany: (...args: unknown[]) => updateManyMock(...args) } },
}));

const { POST } = await import("./route");

beforeEach(() => {
  authMock.mockReset();
  updateManyMock.mockReset();
});

describe("POST /api/v1/notifications/read-all", () => {
  it("returns 401 when unauthenticated", async () => {
    authMock.mockResolvedValue(null);
    const res = await POST();
    expect(res.status).toBe(401);
  });

  it("marks every unread notification read for VIEWER", async () => {
    authMock.mockResolvedValue({ user: { id: "u1", email: "a@b.com", role: "VIEWER" } });
    updateManyMock.mockResolvedValue({ count: 4 });

    const res = await POST();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ count: 4 });
    expect(updateManyMock).toHaveBeenCalledWith({ where: { read: false }, data: { read: true } });
  });
});
