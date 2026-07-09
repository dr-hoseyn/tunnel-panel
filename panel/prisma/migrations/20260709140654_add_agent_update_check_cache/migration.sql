-- AlterTable
ALTER TABLE "Server" ADD COLUMN "latestAgentCheckedAt" DATETIME;
ALTER TABLE "Server" ADD COLUMN "latestAgentVersion" TEXT;
