import { beforeEach, describe, expect, it, vi } from "vitest";

const authMock = vi.fn();
vi.mock("@/auth", () => ({ auth: () => authMock() }));

const findUniqueMock = vi.fn();
const updateMock = vi.fn();
vi.mock("@/lib/db", () => ({
  prisma: {
    notification: {
      findUnique: (...args: unknown[]) => findUniqueMock(...args),
      update: (...args: unknown[]) => updateMock(...args),
    },
  },
}));

const { POST } = await import("./route");

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  authMock.mockReset();
  findUniqueMock.mockReset();
  updateMock.mockReset();
});

describe("POST /api/v1/notifications/[id]/read", () => {
  it("returns 401 when unauthenticated", async () => {
    authMock.mockResolvedValue(null);
    const res = await POST(new Request("http://localhost"), ctx("n1"));
    expect(res.status).toBe(401);
  });

  it("returns 404 when the notification doesn't exist", async () => {
    authMock.mockResolvedValue({ user: { id: "u1", email: "a@b.com", role: "VIEWER" } });
    findUniqueMock.mockResolvedValue(null);

    const res = await POST(new Request("http://localhost"), ctx("missing"));

    expect(res.status).toBe(404);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("marks the notification read for VIEWER", async () => {
    authMock.mockResolvedValue({ user: { id: "u1", email: "a@b.com", role: "VIEWER" } });
    findUniqueMock.mockResolvedValue({ id: "n1", read: false });
    updateMock.mockResolvedValue({ id: "n1", read: true });

    const res = await POST(new Request("http://localhost"), ctx("n1"));

    expect(res.status).toBe(200);
    expect(updateMock).toHaveBeenCalledWith({ where: { id: "n1" }, data: { read: true } });
    expect(await res.json()).toEqual({ notification: { id: "n1", read: true } });
  });
});
