-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_AppSettings" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'singleton',
    "healthCheckIntervalMs" INTEGER NOT NULL DEFAULT 15000,
    "statRetentionMs" BIGINT NOT NULL DEFAULT 604800000,
    "stuckDeploymentTimeoutMs" INTEGER NOT NULL DEFAULT 600000,
    "deploymentMaxAttempts" INTEGER NOT NULL DEFAULT 3,
    "autoRestartEnabled" BOOLEAN NOT NULL DEFAULT true,
    "logRetentionDays" INTEGER NOT NULL DEFAULT 30,
    "backupScheduleHours" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_AppSettings" ("autoRestartEnabled", "deploymentMaxAttempts", "healthCheckIntervalMs", "id", "logRetentionDays", "statRetentionMs", "stuckDeploymentTimeoutMs", "updatedAt") SELECT "autoRestartEnabled", "deploymentMaxAttempts", "healthCheckIntervalMs", "id", "logRetentionDays", "statRetentionMs", "stuckDeploymentTimeoutMs", "updatedAt" FROM "AppSettings";
DROP TABLE "AppSettings";
ALTER TABLE "new_AppSettings" RENAME TO "AppSettings";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
