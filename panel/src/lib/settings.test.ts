import { beforeEach, describe, expect, it, vi } from "vitest";

interface Row {
  id: string;
  healthCheckIntervalMs: number;
  statRetentionMs: bigint;
  stuckDeploymentTimeoutMs: number;
  deploymentMaxAttempts: number;
  autoRestartEnabled: boolean;
  logRetentionDays: number;
  backupScheduleHours: number;
}

let row: Row | null = null;

const fakePrisma = {
  appSettings: {
    upsert: vi.fn(async ({ update, create }: { update: Record<string, unknown>; create: Row }) => {
      if (!row) {
        row = { ...create };
      } else {
        Object.assign(row, update);
      }
      return row;
    }),
  },
};

vi.mock("@/lib/db", () => ({ prisma: fakePrisma }));

const { getSettings, updateSettings, __resetSettingsCacheForTests } = await import("./settings");

beforeEach(() => {
  row = null;
  fakePrisma.appSettings.upsert.mockClear();
  __resetSettingsCacheForTests();
});

describe("getSettings", () => {
  it("creates and returns the singleton row with schema defaults on first read", async () => {
    const settings = await getSettings();
    expect(settings.healthCheckIntervalMs).toBe(15000);
    expect(settings.autoRestartEnabled).toBe(true);
    expect(settings.statRetentionMs).toBe(7 * 24 * 60 * 60 * 1000);
    expect(settings.backupScheduleHours).toBe(0);
  });

  it("caches the result -- a second call within the TTL does not hit the DB again", async () => {
    await getSettings();
    await getSettings();
    expect(fakePrisma.appSettings.upsert).toHaveBeenCalledTimes(1);
  });
});

describe("updateSettings", () => {
  it("persists only the provided fields and invalidates the cache", async () => {
    await getSettings();
    const updated = await updateSettings({ healthCheckIntervalMs: 30000 });
    expect(updated.healthCheckIntervalMs).toBe(30000);
    // Unrelated fields must survive untouched.
    expect(updated.autoRestartEnabled).toBe(true);
  });

  it("a subsequent getSettings() call reflects the update without waiting for the TTL", async () => {
    await getSettings();
    await updateSettings({ deploymentMaxAttempts: 5 });
    const settings = await getSettings();
    expect(settings.deploymentMaxAttempts).toBe(5);
  });

  it("converts statRetentionMs to BigInt for storage and back to number on read", async () => {
    await updateSettings({ statRetentionMs: 1000 });
    const settings = await getSettings();
    expect(settings.statRetentionMs).toBe(1000);
    expect(typeof settings.statRetentionMs).toBe("number");
  });

  it("updates backupScheduleHours", async () => {
    const updated = await updateSettings({ backupScheduleHours: 24 });
    expect(updated.backupScheduleHours).toBe(24);
  });
});
