import pino from 'pino';
import { PrismaClient } from '@prisma/client';
import { CredentialTypeRegistry, createNodeTypes } from '@flowforge/nodes';
import { ApprovalService } from './approvals/ApprovalService';
import type { FastifyBaseLogger } from 'fastify';
import { loadConfig } from './config';
import { Cipher } from './credentials/cipher';
import { CredentialsService } from './credentials/CredentialsService';
import { ExecutionService } from './executions/ExecutionService';
import { QueueService } from './queue/QueueService';
import { VariablesService } from './variables/routes';
import { WorkflowService } from './workflows/WorkflowService';
import { GraphClient } from './whatsapp/graph';
import { WhatsAppPlatform } from './whatsapp/platform';
import { WhatsAppService } from './whatsapp/WhatsAppService';

/**
 * Queue worker: runs production executions from BullMQ.
 * Start with `node dist/worker.js` (EXECUTIONS_MODE=queue, same DATABASE_URL / REDIS_URL / ENCRYPTION_KEY as the server).
 */
export async function startWorker(
  options: {
    prisma?: PrismaClient;
    logger?: FastifyBaseLogger;
    queuePrefix?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
) {
  const config = loadConfig(options.env);
  if (config.EXECUTIONS_MODE !== 'queue' || !config.REDIS_URL) {
    throw new Error('The worker needs EXECUTIONS_MODE=queue and REDIS_URL');
  }
  const logger =
    options.logger ??
    (pino({ level: config.LOG_LEVEL, name: 'worker' }) as unknown as FastifyBaseLogger);
  const prisma = options.prisma ?? new PrismaClient();
  const queue = new QueueService(config.REDIS_URL, logger, options.queuePrefix);
  const nodeTypes = createNodeTypes();
  const workflows = new WorkflowService(prisma, nodeTypes);
  const cipher = new Cipher(config.ENCRYPTION_KEY!);
  const push = queue.pushPublisher();
  // Workers send WhatsApp messages; incoming webhooks are handled by the main server.
  const whatsapp = new WhatsAppService({
    prisma,
    cipher,
    graph: new GraphClient(config.META_GRAPH_URL, config.META_GRAPH_VERSION),
    platform: new WhatsAppPlatform(prisma, cipher, config),
    push,
    logger,
  });
  // Calls are hosted by the main server (call audio, webhooks): ask it over Redis.
  const whatsappHelper = whatsapp.helper();
  whatsappHelper.requestCallPermission = async (accountId, to, text) => {
    queue.sendCommand({ type: 'callPermission', accountId, to, ...(text ? { text } : {}) });
    return { alreadyGranted: false, messageId: null };
  };
  whatsappHelper.startAgentCall = async (accountId, to, options) => {
    const contact = to.replace(/[^\d]/g, '');
    const permission = await prisma.callPermission.findUnique({
      where: { accountId_contact: { accountId, contact } },
    });
    if (
      permission?.status !== 'granted' ||
      (permission.expiresAt && permission.expiresAt < new Date())
    )
      throw new Error(`+${contact} has not allowed calls - send a call permission request first`);
    queue.sendCommand({ type: 'startCall', accountId, to: contact, ...options });
    return { callId: null, status: 'queued' };
  };
  // Approvals made on a worker link to PUBLIC_URL; the main server shows them and takes answers
  // (both need the same DATA_DIR for the saved videos).
  const approvals = new ApprovalService({
    prisma,
    dataDir: config.dataDir,
    publicUrl: config.PUBLIC_URL,
    remote: null,
    logger,
  });
  const executions = new ExecutionService({
    prisma,
    nodeTypes,
    workflows,
    credentials: new CredentialsService(prisma, cipher, new CredentialTypeRegistry()),
    whatsapp: whatsappHelper,
    approvals: approvals.helper(),
    variables: new VariablesService(prisma),
    push,
    config,
    logger,
    queue,
    inProcessOnly: true,
  });
  await queue.subscribe({
    onCommand: (command) => {
      if (command.type === 'cancel') executions.cancelLocal(command.executionId);
    },
  });
  const worker = queue.createWorker(config.WORKER_CONCURRENCY, ({ executionId }) =>
    executions.runQueued(executionId),
  );
  logger.info(`AutoForge worker started (concurrency ${config.WORKER_CONCURRENCY})`);

  return {
    worker,
    async close() {
      await worker.close();
      await executions.shutdown();
      whatsapp.close();
      await queue.close();
      if (!options.prisma) await prisma.$disconnect();
    },
  };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  startWorker()
    .then((w) => {
      const stop = async () => {
        await w.close();
        process.exit(0);
      };
      process.on('SIGINT', () => void stop());
      process.on('SIGTERM', () => void stop());
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    });
}
