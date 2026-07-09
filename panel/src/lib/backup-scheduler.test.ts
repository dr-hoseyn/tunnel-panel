import { beforeEach, describe, expect, it, vi } from "vitest";

interface TunnelRow {
  id: string;
  status: string;
}

const tunnels = new Map<string, TunnelRow>();
let backupRows: { tunnelId: string; createdAt: Date }[] = [];

const fakePrisma = {
  tunnel: {
    findMany: vi.fn(async ({ where }: { where?: { status?: string } } = {}) =>
      Array.from(tunnels.values()).filter((t) => !where?.status || t.status === where.status),
    ),
  },
  tunnelBackup: {
    findFirst: vi.fn(async ({ where }: { where: { tunnelId: string } }) => {
      const rows = backupRows.filter((r) => r.tunnelId === where.tunnelId).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      return rows[0] ?? null;
    }),
  },
};
vi.mock("@/lib/db", () => ({ prisma: fakePrisma }));

let currentSettings = { backupScheduleHours: 0 };
vi.mock("@/lib/settings", () => ({ getSettings: () => Promise.resolve(currentSettings) }));

const createTunnelBackupMock = vi.fn(async () => ({ id: "backup-x", tunnelName: "T" }));
vi.mock("@/lib/backups", () => ({ createTunnelBackup: (...args: unknown[]) => createTunnelBackupMock(...args) }));

const { runBackupScheduleCycle } = await import("./backup-scheduler");

beforeEach(() => {
  tunnels.clear();
  backupRows = [];
  currentSettings = { backupScheduleHours: 0 };
  createTunnelBackupMock.mockClear();
});

describe("runBackupScheduleCycle", () => {
  it("does nothing when backupScheduleHours is 0 (disabled, the default)", async () => {
    currentSettings.backupScheduleHours = 0;
    tunnels.set("t1", { id: "t1", status: "RUNNING" });
    await runBackupScheduleCycle();
    expect(createTunnelBackupMock).not.toHaveBeenCalled();
  });

  it("backs up a RUNNING tunnel with no prior backup", async () => {
    currentSettings.backupScheduleHours = 24;
    tunnels.set("t1", { id: "t1", status: "RUNNING" });
    await runBackupScheduleCycle();
    expect(createTunnelBackupMock).toHaveBeenCalledWith("t1", "Scheduled backup");
  });

  it("skips a tunnel whose most recent backup is still within the schedule window", async () => {
    currentSettings.backupScheduleHours = 24;
    tunnels.set("t1", { id: "t1", status: "RUNNING" });
    backupRows.push({ tunnelId: "t1", createdAt: new Date(Date.now() - 60 * 60 * 1000) }); // 1h ago
    await runBackupScheduleCycle();
    expect(createTunnelBackupMock).not.toHaveBeenCalled();
  });

  it("backs up a tunnel whose most recent backup is older than the schedule window", async () => {
    currentSettings.backupScheduleHours = 24;
    tunnels.set("t1", { id: "t1", status: "RUNNING" });
    backupRows.push({ tunnelId: "t1", createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000) }); // 25h ago
    await runBackupScheduleCycle();
    expect(createTunnelBackupMock).toHaveBeenCalledWith("t1", "Scheduled backup");
  });

  it("ignores non-RUNNING tunnels", async () => {
    currentSettings.backupScheduleHours = 24;
    tunnels.set("t1", { id: "t1", status: "STOPPED" });
    await runBackupScheduleCycle();
    expect(createTunnelBackupMock).not.toHaveBeenCalled();
  });

  it("continues to other tunnels if one backup attempt throws", async () => {
    currentSettings.backupScheduleHours = 24;
    tunnels.set("t1", { id: "t1", status: "RUNNING" });
    tunnels.set("t2", { id: "t2", status: "RUNNING" });
    createTunnelBackupMock.mockRejectedValueOnce(new Error("db error")).mockResolvedValueOnce({ id: "b", tunnelName: "T2" });
    await runBackupScheduleCycle();
    expect(createTunnelBackupMock).toHaveBeenCalledTimes(2);
  });
});
