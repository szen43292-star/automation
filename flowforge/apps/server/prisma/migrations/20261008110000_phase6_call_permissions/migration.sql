-- CreateEnum
CREATE TYPE "CallPermissionStatus" AS ENUM ('requested', 'granted', 'denied');

-- CreateTable
CREATE TABLE "CallPermission" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "contact" TEXT NOT NULL,
    "status" "CallPermissionStatus" NOT NULL,
    "permanent" BOOLEAN NOT NULL DEFAULT false,
    "requestedAt" TIMESTAMP(3),
    "respondedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CallPermission_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CallPermission_accountId_contact_key" ON "CallPermission"("accountId", "contact");

-- AddForeignKey
ALTER TABLE "CallPermission" ADD CONSTRAINT "CallPermission_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "WhatsAppAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

