/*
  Warnings:

  - You are about to drop the column `agentToken` on the `Server` table. All the data in the column will be lost.
  - Added the required column `agentTokenEnc` to the `Server` table without a default value. This is not possible if the table is not empty.

*/
-- CreateTable
CREATE TABLE "Tunnel" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "core" TEXT NOT NULL,
    "sourceServerId" TEXT NOT NULL,
    "destServerId" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "secretEnc" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DEPLOYING',
    "lastCheckedAt" DATETIME,
    "lastRestartAt" DATETIME,
    "createdById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Tunnel_sourceServerId_fkey" FOREIGN KEY ("sourceServerId") REFERENCES "Server" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Tunnel_destServerId_fkey" FOREIGN KEY ("destServerId") REFERENCES "Server" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Tunnel_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Deployment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tunnelId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "steps" JSONB NOT NULL DEFAULT [],
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Deployment_tunnelId_fkey" FOREIGN KEY ("tunnelId") REFERENCES "Tunnel" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "TunnelStat" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tunnelId" TEXT NOT NULL,
    "timestamp" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rxBytes" BIGINT NOT NULL DEFAULT 0,
    "txBytes" BIGINT NOT NULL DEFAULT 0,
    "latencyMs" REAL,
    "packetLossPct" REAL,
    "cpuPercent" REAL,
    "ramPercent" REAL,
    "connections" INTEGER,
    "reconnectCount" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "TunnelStat_tunnelId_fkey" FOREIGN KEY ("tunnelId") REFERENCES "Tunnel" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Event" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "category" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'INFO',
    "message" TEXT NOT NULL,
    "serverId" TEXT,
    "tunnelId" TEXT,
    "userId" TEXT,
    "deploymentId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Event_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Event_tunnelId_fkey" FOREIGN KEY ("tunnelId") REFERENCES "Tunnel" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Event_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Event_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "Deployment" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "TunnelBackup" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tunnelId" TEXT NOT NULL,
    "configSnapshot" JSONB NOT NULL,
    "serviceUnitSnapshot" JSONB NOT NULL,
    "secretEnc" TEXT NOT NULL,
    "driverVersion" TEXT,
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TunnelBackup_tunnelId_fkey" FOREIGN KEY ("tunnelId") REFERENCES "Tunnel" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Server" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "agentPort" INTEGER NOT NULL DEFAULT 8443,
    "agentTokenEnc" TEXT NOT NULL,
    "tlsFingerprint" TEXT NOT NULL,
    "location" TEXT,
    "agentVersion" TEXT,
    "agentCommit" TEXT,
    "agentOs" TEXT,
    "agentArch" TEXT,
    "lastSeenAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_Server" ("agentPort", "createdAt", "host", "id", "name", "tlsFingerprint", "updatedAt") SELECT "agentPort", "createdAt", "host", "id", "name", "tlsFingerprint", "updatedAt" FROM "Server";
DROP TABLE "Server";
ALTER TABLE "new_Server" RENAME TO "Server";
CREATE TABLE "new_User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'ADMIN',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_User" ("createdAt", "email", "id", "passwordHash") SELECT "createdAt", "email", "id", "passwordHash" FROM "User";
DROP TABLE "User";
ALTER TABLE "new_User" RENAME TO "User";
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "TunnelStat_tunnelId_timestamp_idx" ON "TunnelStat"("tunnelId", "timestamp");

-- CreateIndex
CREATE INDEX "Event_category_createdAt_idx" ON "Event"("category", "createdAt");
