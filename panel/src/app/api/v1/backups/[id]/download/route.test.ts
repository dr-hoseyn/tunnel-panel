import { beforeEach, describe, expect, it, vi } from "vitest";

interface BackupRow {
  id: string;
  configSnapshot: object;
  serviceUnitSnapshot: object;
  secretEnc: string;
  driverVersion: string | null;
  note: string | null;
  createdAt: Date;
  tunnel: { name: string; core: string };
}

const backups = new Map<string, BackupRow>();
const fakePrisma = {
  tunnelBackup: {
    findUnique: vi.fn(async ({ where }: { where: { id: string } }) => backups.get(where.id) ?? null),
  },
};
vi.mock("@/lib/db", () => ({ prisma: fakePrisma }));

const authMock = vi.fn();
vi.mock("@/auth", () => ({ auth: () => authMock() }));

const { GET } = await import("./route");

function sessionWithRole(role: string | undefined) {
  return { user: { id: "u1", email: "op@example.com", role } };
}

beforeEach(() => {
  backups.clear();
  authMock.mockReset();
});

describe("GET /api/v1/backups/[id]/download", () => {
  it("returns 403 for a VIEWER", async () => {
    authMock.mockResolvedValue(sessionWithRole("VIEWER"));
    const res = await GET(new Request("http://localhost"), { params: Promise.resolve({ id: "b1" }) });
    expect(res.status).toBe(403);
  });

  it("returns 404 for an unknown backup id", async () => {
    authMock.mockResolvedValue(sessionWithRole("OPERATOR"));
    const res = await GET(new Request("http://localhost"), { params: Promise.resolve({ id: "does-not-exist" }) });
    expect(res.status).toBe(404);
  });

  it("returns a downloadable JSON file with the expected shape and a sanitized filename", async () => {
    authMock.mockResolvedValue(sessionWithRole("OPERATOR"));
    backups.set("b1", {
      id: "b1",
      configSnapshot: { port: 3080 },
      serviceUnitSnapshot: { note: "n/a" },
      secretEnc: "iv.tag.ciphertext",
      driverVersion: null,
      note: "Manual backup",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      tunnel: { name: "My Tunnel!! /weird", core: "BACKHAUL" },
    });

    const res = await GET(new Request("http://localhost"), { params: Promise.resolve({ id: "b1" }) });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    const disposition = res.headers.get("Content-Disposition")!;
    expect(disposition).toContain("attachment");
    expect(disposition).not.toMatch(/[!/]/); // sanitized -- no raw special chars in the filename

    const body = await res.json();
    expect(body.tunnelName).toBe("My Tunnel!! /weird");
    expect(body.core).toBe("BACKHAUL");
    expect(body.secretEnc).toBe("iv.tag.ciphertext");
    expect(body.configSnapshot).toEqual({ port: 3080 });
  });
});
