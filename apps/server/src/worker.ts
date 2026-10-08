import pino from 'pino';
import { PrismaClient } from '@prisma/client';
import { CredentialTypeRegistry, createNodeTypes } from '@flowforge/nodes';
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
  const executions = new ExecutionService({
    prisma,
    nodeTypes,
    workflows,
    credentials: new CredentialsService(prisma, cipher, new CredentialTypeRegistry()),
    whatsapp: whatsapp.helper(),
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
  logger.info(`FlowForge worker started (concurrency ${config.WORKER_CONCURRENCY})`);

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
