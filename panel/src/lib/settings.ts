import { prisma } from "@/lib/db";

/**
 * The operational knobs behind the Settings page: health-check interval,
 * stat/log retention, stuck-deployment timeout, deployment retry count, and
 * the auto-restart toggle. Backed by a singleton `AppSettings` row (id
 * "singleton") instead of the hardcoded constants health-sampler.ts and
 * deploy-queue.ts used to have, so an admin can tune them without a
 * redeploy. Cached in-memory for a few seconds so the health sampler (which
 * reads this every cycle) and the deployment queue (every job) don't each
 * hit the DB on every call -- a settings change takes effect within one
 * cache TTL, not instantly, which is an acceptable tradeoff for values that
 * are read far more often than they're written.
 */

export interface AppSettingsValue {
  healthCheckIntervalMs: number;
  statRetentionMs: number;
  stuckDeploymentTimeoutMs: number;
  deploymentMaxAttempts: number;
  autoRestartEnabled: boolean;
  logRetentionDays: number;
  backupScheduleHours: number;
}

const SINGLETON_ID = "singleton";

const DEFAULTS: AppSettingsValue = {
  healthCheckIntervalMs: 15_000,
  statRetentionMs: 7 * 24 * 60 * 60 * 1000,
  stuckDeploymentTimeoutMs: 10 * 60 * 1000,
  deploymentMaxAttempts: 3,
  autoRestartEnabled: true,
  logRetentionDays: 30,
  backupScheduleHours: 0,
};

const CACHE_TTL_MS = 5_000;
let cached: { value: AppSettingsValue; expiresAt: number } | null = null;

export async function getSettings(): Promise<AppSettingsValue> {
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }
  const row = await prisma.appSettings.upsert({
    where: { id: SINGLETON_ID },
    update: {},
    // Explicit defaults here (not relying on the Prisma schema's own
    // @default(...) values) so DEFAULTS stays the single source of truth
    // for what a never-configured install actually gets.
    create: {
      id: SINGLETON_ID,
      healthCheckIntervalMs: DEFAULTS.healthCheckIntervalMs,
      statRetentionMs: BigInt(DEFAULTS.statRetentionMs),
      stuckDeploymentTimeoutMs: DEFAULTS.stuckDeploymentTimeoutMs,
      deploymentMaxAttempts: DEFAULTS.deploymentMaxAttempts,
      autoRestartEnabled: DEFAULTS.autoRestartEnabled,
      logRetentionDays: DEFAULTS.logRetentionDays,
      backupScheduleHours: DEFAULTS.backupScheduleHours,
    },
  });
  const value: AppSettingsValue = {
    healthCheckIntervalMs: row.healthCheckIntervalMs,
    statRetentionMs: Number(row.statRetentionMs),
    stuckDeploymentTimeoutMs: row.stuckDeploymentTimeoutMs,
    deploymentMaxAttempts: row.deploymentMaxAttempts,
    autoRestartEnabled: row.autoRestartEnabled,
    logRetentionDays: row.logRetentionDays,
    backupScheduleHours: row.backupScheduleHours,
  };
  cached = { value, expiresAt: Date.now() + CACHE_TTL_MS };
  return value;
}

/** Partial update -- only the provided fields change. Invalidates the cache
 * immediately so the next getSettings() call (even from a different request)
 * sees the new values rather than waiting out the TTL. */
export async function updateSettings(patch: Partial<AppSettingsValue>): Promise<AppSettingsValue> {
  const data: Record<string, unknown> = {};
  if (patch.healthCheckIntervalMs !== undefined) data.healthCheckIntervalMs = patch.healthCheckIntervalMs;
  if (patch.statRetentionMs !== undefined) data.statRetentionMs = BigInt(patch.statRetentionMs);
  if (patch.stuckDeploymentTimeoutMs !== undefined) data.stuckDeploymentTimeoutMs = patch.stuckDeploymentTimeoutMs;
  if (patch.deploymentMaxAttempts !== undefined) data.deploymentMaxAttempts = patch.deploymentMaxAttempts;
  if (patch.autoRestartEnabled !== undefined) data.autoRestartEnabled = patch.autoRestartEnabled;
  if (patch.logRetentionDays !== undefined) data.logRetentionDays = patch.logRetentionDays;
  if (patch.backupScheduleHours !== undefined) data.backupScheduleHours = patch.backupScheduleHours;

  await prisma.appSettings.upsert({
    where: { id: SINGLETON_ID },
    update: data,
    create: { id: SINGLETON_ID, ...data },
  });
  cached = null;
  return getSettings();
}

/** Test-only escape hatch -- vitest runs in a single process across many
 * test files, and this module's cache would otherwise leak settings from
 * one test into another. */
export function __resetSettingsCacheForTests(): void {
  cached = null;
}

export const SETTINGS_DEFAULTS: AppSettingsValue = DEFAULTS;
