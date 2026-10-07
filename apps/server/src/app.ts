import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import { PrismaClient } from '@prisma/client';
import { CredentialTypeRegistry, createNodeTypes } from '@flowforge/nodes';
import type { INodeTypes } from '@flowforge/workflow';
import { authenticate, authRoutes } from './auth/auth';
import type { Config } from './config';
import { Cipher } from './credentials/cipher';
import { CredentialsService } from './credentials/CredentialsService';
import { credentialRoutes, oauthCallbackRoutes } from './credentials/routes';
import { ExecutionService } from './executions/ExecutionService';
import { executionRoutes } from './executions/routes';
import { registerErrorHandler } from './lib/errors';
import { PushHub } from './push/PushHub';
import { pushRoutes } from './push/routes';
import { QueueService } from './queue/QueueService';
import { ActiveWorkflowManager, WaitTracker } from './triggers/ActiveWorkflowManager';
import { VariablesService, variableRoutes } from './variables/routes';
import { TestWebhooks, webhookRoutes } from './webhooks/webhooks';
import { WorkflowService } from './workflows/WorkflowService';
import { workflowRoutes } from './workflows/routes';

export const VERSION = '0.2.0';

export interface Services {
  workflows: WorkflowService;
  executions: ExecutionService;
  credentials: CredentialsService;
  variables: VariablesService;
  activeWorkflows: ActiveWorkflowManager;
}

declare module 'fastify' {
  interface FastifyInstance {
    prisma: PrismaClient;
    push: PushHub;
    nodeTypes: INodeTypes;
    services: Services;
    testWebhooks: TestWebhooks;
    queue: QueueService | null;
    waitTracker: WaitTracker;
    flowforgeVersion: string;
    /** Start schedules, webhooks, the wait tracker and queue relays (not done in tests unless asked). */
    startBackgroundServices(): Promise<void>;
  }
}

export interface BuildOptions {
  prisma?: PrismaClient;
  logger?: FastifyServerOptions['logger'];
  waitTrackerIntervalMs?: number;
  /** Prefix for Redis keys (tests use a unique one). */
  queuePrefix?: string;
}

export async function buildApp(
  config: Config,
  options: BuildOptions = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    logger:
      options.logger ??
      (config.NODE_ENV === 'development'
        ? {
            level: config.LOG_LEVEL,
            transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss' } },
          }
        : { level: config.LOG_LEVEL }),
    bodyLimit: 32 * 1024 * 1024,
    trustProxy: true,
  });

  const prisma = options.prisma ?? new PrismaClient();
  const push = new PushHub(app.log);
  const nodeTypes = createNodeTypes();
  const queue =
    config.EXECUTIONS_MODE === 'queue' && config.REDIS_URL
      ? new QueueService(config.REDIS_URL, app.log, options.queuePrefix)
      : null;
  const workflows = new WorkflowService(prisma, nodeTypes);
  const credentials = new CredentialsService(
    prisma,
    new Cipher(config.ENCRYPTION_KEY!),
    new CredentialTypeRegistry(),
  );
  const variables = new VariablesService(prisma);
  const executions = new ExecutionService({
    prisma,
    nodeTypes,
    workflows,
    credentials,
    variables,
    push,
    config,
    logger: app.log,
    ...(queue ? { queue } : {}),
  });
  const activeWorkflows = new ActiveWorkflowManager(
    prisma,
    nodeTypes,
    executions,
    app.log,
    config.DEFAULT_TIMEZONE,
  );
  workflows.activation = activeWorkflows;
  const waitTracker = new WaitTracker(prisma, executions, app.log, options.waitTrackerIntervalMs);

  app.decorate('prisma', prisma);
  app.decorate('push', push);
  app.decorate('nodeTypes', nodeTypes);
  app.decorate('services', { workflows, executions, credentials, variables, activeWorkflows });
  app.decorate('testWebhooks', new TestWebhooks());
  app.decorate('queue', queue);
  app.decorate('waitTracker', waitTracker);
  app.decorate('flowforgeVersion', VERSION);
  app.decorate('startBackgroundServices', async () => {
    if (queue) {
      // Relay live events from workers to WebSocket clients.
      await queue.subscribe({ onPush: (topics, event) => push.publish(topics, event) });
    }
    await executions.recoverCrashed();
    await activeWorkflows.init();
    waitTracker.start();
  });

  registerErrorHandler(app);

  await app.register(cors, {
    // Same-origin editor needs no CORS; desktop/mobile apps and hosted editors (e.g. Vercel) are listed explicitly.
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      const allowed =
        config.corsOrigins.includes('*') ||
        config.corsOrigins.includes(origin) ||
        /^(tauri|capacitor|ionic):\/\//.test(origin) ||
        origin === 'http://tauri.localhost' ||
        origin === 'https://tauri.localhost';
      cb(null, allowed);
    },
    credentials: false,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  });
  await app.register(rateLimit, { global: false });
  await app.register(jwt, {
    secret: config.JWT_SECRET,
    sign: { expiresIn: config.JWT_EXPIRES_IN },
  });
  await app.register(websocket, { options: { maxPayload: 64 * 1024 } });

  // --- Public routes -------------------------------------------------------
  app.get('/healthz', async () => ({ status: 'ok' }));
  app.get('/readyz', async (_request, reply) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return { status: 'ok', mode: config.EXECUTIONS_MODE };
    } catch {
      return reply
        .status(503)
        .send({ status: 'unavailable', message: 'Database is not reachable' });
    }
  });
  await app.register(authRoutes, { rateLimit: config.AUTH_RATE_LIMIT });
  await app.register(pushRoutes);
  await app.register(oauthCallbackRoutes, { config });
  await app.register(webhookRoutes, { config });

  // --- Authenticated API -----------------------------------------------------
  await app.register(async (api) => {
    api.addHook('onRequest', authenticate);
    api.get('/api/node-types', async () => ({
      data: nodeTypes.getAll().map((n) => n.description),
    }));
    api.get('/api/settings', async () => ({
      publicUrl: config.PUBLIC_URL.replace(/\/+$/, ''),
      executionsMode: config.EXECUTIONS_MODE,
      oauthCallbackUrl: `${config.PUBLIC_URL.replace(/\/+$/, '')}/rest/oauth2-credential/callback`,
      version: VERSION,
    }));
    await api.register(workflowRoutes, { config });
    await api.register(executionRoutes);
    await api.register(credentialRoutes, { config });
    await api.register(variableRoutes);
  });

  // --- Editor (single page app) ---------------------------------------------
  if (config.editorDist) {
    const indexHtml = await readFile(resolve(config.editorDist, 'index.html'), 'utf8');
    await app.register(fastifyStatic, { root: config.editorDist, wildcard: false, index: false });
    app.get('/', (_req, reply) => reply.type('text/html').send(indexHtml));
    app.setNotFoundHandler((request, reply) => {
      if (
        request.method === 'GET' &&
        !request.url.startsWith('/api/') &&
        !/\.\w+$/.test(request.url.split('?')[0]!)
      ) {
        return reply.type('text/html').send(indexHtml);
      }
      return reply
        .status(404)
        .send({ error: 'NotFound', message: `Route ${request.method} ${request.url} not found` });
    });
  } else {
    app.setNotFoundHandler((request, reply) =>
      reply
        .status(404)
        .send({ error: 'NotFound', message: `Route ${request.method} ${request.url} not found` }),
    );
  }

  app.addHook('onClose', async () => {
    waitTracker.stop();
    activeWorkflows.shutdown();
    await executions.shutdown();
    push.closeAll();
    await queue?.close();
    if (!options.prisma) await prisma.$disconnect();
  });

  return app;
}
