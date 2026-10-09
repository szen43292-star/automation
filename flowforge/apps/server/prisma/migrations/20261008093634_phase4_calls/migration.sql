-- CreateEnum
CREATE TYPE "CallDirection" AS ENUM ('inbound', 'outbound');

-- CreateEnum
CREATE TYPE "CallStatus" AS ENUM ('ringing', 'answered', 'ended', 'missed', 'rejected', 'failed');

-- AlterTable
ALTER TABLE "WhatsAppAccount" ADD COLUMN     "callSettings" JSONB,
ADD COLUMN     "callingEnabled" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "Call" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "waCallId" TEXT,
    "direction" "CallDirection" NOT NULL,
    "contact" TEXT NOT NULL,
    "contactName" TEXT,
    "status" "CallStatus" NOT NULL DEFAULT 'ringing',
    "handledBy" TEXT,
    "answeredById" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "answeredAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "durationSeconds" INTEGER,
    "endReason" TEXT,
    "recordingPath" TEXT,
    "recordingBytes" INTEGER,
    "transcript" JSONB,
    "summary" TEXT,
    "metadata" JSONB,

    CONSTRAINT "Call_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Call_waCallId_key" ON "Call"("waCallId");

-- CreateIndex
CREATE INDEX "Call_accountId_startedAt_idx" ON "Call"("accountId", "startedAt" DESC);

-- CreateIndex
CREATE INDEX "Call_startedAt_idx" ON "Call"("startedAt" DESC);

-- CreateIndex
CREATE INDEX "Call_status_idx" ON "Call"("status");

-- AddForeignKey
ALTER TABLE "Call" ADD CONSTRAINT "Call_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "WhatsAppAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Call" ADD CONSTRAINT "Call_answeredById_fkey" FOREIGN KEY ("answeredById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
