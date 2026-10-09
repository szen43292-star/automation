-- CreateEnum
CREATE TYPE "WhatsAppAccountMode" AS ENUM ('cloud', 'simulator');

-- CreateEnum
CREATE TYPE "WhatsAppAccountStatus" AS ENUM ('connected', 'error', 'disconnected');

-- CreateEnum
CREATE TYPE "WhatsAppDirection" AS ENUM ('inbound', 'outbound');

-- CreateEnum
CREATE TYPE "WhatsAppMessageStatus" AS ENUM ('received', 'sent', 'delivered', 'read', 'failed');

-- CreateTable
CREATE TABLE "Setting" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Setting_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "WhatsAppAccount" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mode" "WhatsAppAccountMode" NOT NULL DEFAULT 'cloud',
    "connectedVia" TEXT NOT NULL,
    "wabaId" TEXT,
    "phoneNumberId" TEXT NOT NULL,
    "displayPhoneNumber" TEXT NOT NULL,
    "verifiedName" TEXT,
    "qualityRating" TEXT,
    "nameStatus" TEXT,
    "codeVerificationStatus" TEXT,
    "messagingLimit" TEXT,
    "secrets" TEXT,
    "webhookSubscribed" BOOLEAN NOT NULL DEFAULT false,
    "status" "WhatsAppAccountStatus" NOT NULL DEFAULT 'connected',
    "lastError" TEXT,
    "lastEventAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WhatsAppAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WhatsAppMessage" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "waMessageId" TEXT,
    "direction" "WhatsAppDirection" NOT NULL,
    "contact" TEXT NOT NULL,
    "contactName" TEXT,
    "type" TEXT NOT NULL,
    "text" TEXT,
    "payload" JSONB NOT NULL,
    "status" "WhatsAppMessageStatus" NOT NULL,
    "error" JSONB,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WhatsAppMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WhatsAppAccount_phoneNumberId_key" ON "WhatsAppAccount"("phoneNumberId");

-- CreateIndex
CREATE UNIQUE INDEX "WhatsAppMessage_waMessageId_key" ON "WhatsAppMessage"("waMessageId");

-- CreateIndex
CREATE INDEX "WhatsAppMessage_accountId_contact_timestamp_idx" ON "WhatsAppMessage"("accountId", "contact", "timestamp");

-- CreateIndex
CREATE INDEX "WhatsAppMessage_accountId_timestamp_idx" ON "WhatsAppMessage"("accountId", "timestamp");

-- AddForeignKey
ALTER TABLE "WhatsAppAccount" ADD CONSTRAINT "WhatsAppAccount_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhatsAppMessage" ADD CONSTRAINT "WhatsAppMessage_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "WhatsAppAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
