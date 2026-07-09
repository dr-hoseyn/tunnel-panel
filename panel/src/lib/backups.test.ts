import { beforeEach, describe, expect, it, vi } from "vitest";

interface TunnelRow {
  id: string;
  name: string;
  config: object;
  secretEnc: string;
}

const tunnels = new Map<string, TunnelRow>();
const backups: Record<string, unknown>[] = [];

const fakePrisma = {
  tunnel: {
    findUnique: vi.fn(async ({ where }: { where: { id: string } }) => tunnels.get(where.id) ?? null),
  },
  tunnelBackup: {
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      const row = { id: `backup-${backups.length}`, ...data };
      backups.push(row);
      return row;
    }),
  },
};
vi.mock("@/lib/db", () => ({ prisma: fakePrisma }));

const { createTunnelBackup } = await import("./backups");

beforeEach(() => {
  tunnels.clear();
  backups.length = 0;
  fakePrisma.tunnel.findUnique.mockClear();
  fakePrisma.tunnelBackup.create.mockClear();
});

describe("createTunnelBackup", () => {
  it("returns null for an unknown tunnel id without creating a backup row", async () => {
    const result = await createTunnelBackup("nope", "note");
    expect(result).toBeNull();
    expect(fakePrisma.tunnelBackup.create).not.toHaveBeenCalled();
  });

  it("snapshots the tunnel's config/secret and returns its id/name", async () => {
    tunnels.set("t1", { id: "t1", name: "My Tunnel", config: { port: 3080 }, secretEnc: "enc-secret" });
    const result = await createTunnelBackup("t1", "test note");
    expect(result).toEqual({ id: "backup-0", tunnelName: "My Tunnel" });
    expect(backups[0]).toMatchObject({ tunnelId: "t1", secretEnc: "enc-secret", note: "test note" });
  });
});
