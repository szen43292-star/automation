-- AlterTable
ALTER TABLE "Execution" ADD COLUMN     "parentExecutionId" TEXT,
ADD COLUMN     "waitTill" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "ExecutionData" ADD COLUMN     "startData" JSONB;

-- CreateTable
CREATE TABLE "Credential" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "data" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Credential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Variable" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Variable_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookEntity" (
    "id" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookEntity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Credential_ownerId_idx" ON "Credential"("ownerId");

-- CreateIndex
CREATE INDEX "Credential_type_idx" ON "Credential"("type");

-- CreateIndex
CREATE UNIQUE INDEX "Variable_key_key" ON "Variable"("key");

-- CreateIndex
CREATE INDEX "WebhookEntity_workflowId_idx" ON "WebhookEntity"("workflowId");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookEntity_method_path_key" ON "WebhookEntity"("method", "path");

-- CreateIndex
CREATE INDEX "Execution_status_waitTill_idx" ON "Execution"("status", "waitTill");

-- AddForeignKey
ALTER TABLE "Credential" ADD CONSTRAINT "Credential_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookEntity" ADD CONSTRAINT "WebhookEntity_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "Workflow"("id") ON DELETE CASCADE ON UPDATE CASCADE;
