import { beforeEach, describe, expect, it, vi } from "vitest";

const authMock = vi.fn();
vi.mock("@/auth", () => ({ auth: () => authMock() }));

const { requireRole, requireRoleResponse, UnauthorizedError } = await import("./rbac");

beforeEach(() => {
  authMock.mockReset();
});

function sessionWithRole(role: string | undefined) {
  return { user: { id: "u1", email: "a@b.com", role } };
}

describe("requireRole", () => {
  it("throws 401 when there is no session", async () => {
    authMock.mockResolvedValue(null);
    await expect(requireRole("VIEWER")).rejects.toMatchObject({ status: 401 });
  });

  it("throws 403 when the session's role is below the minimum", async () => {
    authMock.mockResolvedValue(sessionWithRole("VIEWER"));
    await expect(requireRole("ADMIN")).rejects.toMatchObject({ status: 403 });
  });

  it("resolves when the role exactly matches the minimum", async () => {
    authMock.mockResolvedValue(sessionWithRole("OPERATOR"));
    await expect(requireRole("OPERATOR")).resolves.toMatchObject({ user: { role: "OPERATOR" } });
  });

  it("resolves when the role exceeds the minimum", async () => {
    authMock.mockResolvedValue(sessionWithRole("ADMIN"));
    await expect(requireRole("VIEWER")).resolves.toBeTruthy();
  });

  it("treats a missing role as VIEWER", async () => {
    authMock.mockResolvedValue(sessionWithRole(undefined));
    await expect(requireRole("VIEWER")).resolves.toBeTruthy();
    await expect(requireRole("OPERATOR")).rejects.toBeInstanceOf(UnauthorizedError);
  });
});

describe("requireRoleResponse", () => {
  it("returns a 401 NextResponse when unauthenticated", async () => {
    authMock.mockResolvedValue(null);
    const result = await requireRoleResponse("VIEWER");
    expect("response" in result).toBe(true);
    if ("response" in result) {
      expect(result.response.status).toBe(401);
    }
  });

  it("returns a 403 NextResponse when under-privileged", async () => {
    authMock.mockResolvedValue(sessionWithRole("VIEWER"));
    const result = await requireRoleResponse("ADMIN");
    expect("response" in result).toBe(true);
    if ("response" in result) {
      expect(result.response.status).toBe(403);
    }
  });

  it("returns the session when authorized", async () => {
    authMock.mockResolvedValue(sessionWithRole("ADMIN"));
    const result = await requireRoleResponse("ADMIN");
    expect("session" in result).toBe(true);
  });
});
