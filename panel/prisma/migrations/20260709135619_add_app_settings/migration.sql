-- CreateTable
CREATE TABLE "AppSettings" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'singleton',
    "healthCheckIntervalMs" INTEGER NOT NULL DEFAULT 15000,
    "statRetentionMs" BIGINT NOT NULL DEFAULT 604800000,
    "stuckDeploymentTimeoutMs" INTEGER NOT NULL DEFAULT 600000,
    "deploymentMaxAttempts" INTEGER NOT NULL DEFAULT 3,
    "autoRestartEnabled" BOOLEAN NOT NULL DEFAULT true,
    "logRetentionDays" INTEGER NOT NULL DEFAULT 30,
    "updatedAt" DATETIME NOT NULL
);
