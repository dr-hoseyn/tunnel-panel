-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Tunnel" (
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
    "maintenanceMode" BOOLEAN NOT NULL DEFAULT false,
    "autoRestartDisabled" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "Tunnel_sourceServerId_fkey" FOREIGN KEY ("sourceServerId") REFERENCES "Server" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Tunnel_destServerId_fkey" FOREIGN KEY ("destServerId") REFERENCES "Server" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Tunnel_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Tunnel" ("config", "core", "createdAt", "createdById", "destServerId", "id", "lastCheckedAt", "lastRestartAt", "name", "secretEnc", "sourceServerId", "status", "updatedAt") SELECT "config", "core", "createdAt", "createdById", "destServerId", "id", "lastCheckedAt", "lastRestartAt", "name", "secretEnc", "sourceServerId", "status", "updatedAt" FROM "Tunnel";
DROP TABLE "Tunnel";
ALTER TABLE "new_Tunnel" RENAME TO "Tunnel";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
