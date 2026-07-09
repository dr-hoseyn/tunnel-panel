import { beforeEach, describe, expect, it, vi } from "vitest";

interface SettingsRow {
  healthCheckIntervalMs: number;
  statRetentionMs: number;
  stuckDeploymentTimeoutMs: number;
  deploymentMaxAttempts: number;
  autoRestartEnabled: boolean;
  logRetentionDays: number;
}

function defaults(): SettingsRow {
  return {
    healthCheckIntervalMs: 15000,
    statRetentionMs: 7 * 24 * 60 * 60 * 1000,
    stuckDeploymentTimeoutMs: 10 * 60 * 1000,
    deploymentMaxAttempts: 3,
    autoRestartEnabled: true,
    logRetentionDays: 30,
  };
}

let current: SettingsRow = defaults();
const getSettingsMock = vi.fn(async () => current);
const updateSettingsMock = vi.fn(async (patch: Partial<SettingsRow>) => {
  current = { ...current, ...patch };
  return current;
});
vi.mock("@/lib/settings", () => ({
  getSettings: () => getSettingsMock(),
  updateSettings: (patch: Partial<SettingsRow>) => updateSettingsMock(patch),
}));

const eventCreateMock = vi.fn(async () => ({}));
vi.mock("@/lib/db", () => ({ prisma: { event: { create: (...args: unknown[]) => eventCreateMock(...args) } } }));

const authMock = vi.fn();
vi.mock("@/auth", () => ({ auth: () => authMock() }));

const { GET, PATCH } = await import("./route");

function sessionWithRole(role: string | undefined) {
  return { user: { id: "u1", email: "admin@example.com", role } };
}

function patchRequest(body: unknown) {
  return new Request("http://localhost/api/v1/settings", { method: "PATCH", body: JSON.stringify(body) });
}

beforeEach(() => {
  current = defaults();
  authMock.mockReset();
  getSettingsMock.mockClear();
  updateSettingsMock.mockClear();
  eventCreateMock.mockClear();
});

describe("GET /api/v1/settings", () => {
  it("returns 401 with no session", async () => {
    authMock.mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it("returns settings for any authenticated role (VIEWER included)", async () => {
    authMock.mockResolvedValue(sessionWithRole("VIEWER"));
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.settings.healthCheckIntervalMs).toBe(15000);
  });
});

describe("PATCH /api/v1/settings", () => {
  it("returns 403 for a non-ADMIN role", async () => {
    authMock.mockResolvedValue(sessionWithRole("OPERATOR"));
    const res = await PATCH(patchRequest({ healthCheckIntervalMs: 30000 }));
    expect(res.status).toBe(403);
    expect(updateSettingsMock).not.toHaveBeenCalled();
  });

  it("rejects an out-of-range value", async () => {
    authMock.mockResolvedValue(sessionWithRole("ADMIN"));
    const res = await PATCH(patchRequest({ healthCheckIntervalMs: 1 })); // below the 5s minimum
    expect(res.status).toBe(400);
    expect(updateSettingsMock).not.toHaveBeenCalled();
  });

  it("rejects an empty patch", async () => {
    authMock.mockResolvedValue(sessionWithRole("ADMIN"));
    const res = await PATCH(patchRequest({}));
    expect(res.status).toBe(400);
  });

  it("updates settings for ADMIN and records an audit event", async () => {
    authMock.mockResolvedValue(sessionWithRole("ADMIN"));
    const res = await PATCH(patchRequest({ healthCheckIntervalMs: 30000, autoRestartEnabled: false }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.settings.healthCheckIntervalMs).toBe(30000);
    expect(body.settings.autoRestartEnabled).toBe(false);
    expect(eventCreateMock).toHaveBeenCalledTimes(1);
    const eventData = eventCreateMock.mock.calls[0][0].data;
    expect(eventData.type).toBe("SETTINGS_UPDATED");
    expect(eventData.category).toBe("AUDIT");
  });
});
