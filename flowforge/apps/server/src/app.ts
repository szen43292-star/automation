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
import { GraphClient } from './whatsapp/graph';
import { WhatsAppPlatform } from './whatsapp/platform';
import { whatsappRoutes, whatsappWebhookRoutes } from './whatsapp/routes';
import { WhatsAppService } from './whatsapp/WhatsAppService';
import { badRequest } from './lib/errors';
import { CallService } from './calls/CallService';
import { callRoutes } from './calls/routes';
import type { MediaConfig } from '@flowforge/media';
import { AiProviders } from './ai/providers';
import { AgentService } from './agent/AgentService';
import { agentRoutes } from './agent/routes';
import { inviteRoutes, userRoutes } from './users/routes';
import { dashboardRoutes } from './dashboard/routes';
import { PhoneNotifications, deviceRoutes, readServiceAccount } from './push/PhoneNotifications';

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
    whatsapp: WhatsAppService;
    whatsappPlatform: WhatsAppPlatform;
    whatsappGraphVersion: string;
    calls: CallService;
    aiProviders: AiProviders;
    agents: AgentService;
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
  /** Delays of simulated WhatsApp "delivered" / "read" receipts (tests use short ones). */
  whatsappReceiptDelays?: [number, number];
  /** Call audio network settings (tests use a local STUN server). */
  media?: MediaConfig;
}

/** Call audio settings from MEDIA_* variables. */
export function mediaConfigFrom(config: Config): MediaConfig {
  const range = config.MEDIA_PORT_RANGE?.split('-').map(Number) as [number, number] | undefined;
  return {
    iceServers: config.MEDIA_ICE_SERVERS.split(',')
      .map((url) => url.trim())
      .filter(Boolean)
      .map((urls) => ({ urls })),
    ...(range ? { portRange: range } : {}),
    ...(config.MEDIA_PUBLIC_IP ? { additionalHostAddresses: [config.MEDIA_PUBLIC_IP] } : {}),
  };
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
  const cipher = new Cipher(config.ENCRYPTION_KEY!);
  const credentials = new CredentialsService(prisma, cipher, new CredentialTypeRegistry());
  const whatsappPlatform = new WhatsAppPlatform(prisma, cipher, config);
  const whatsapp = new WhatsAppService({
    prisma,
    cipher,
    graph: new GraphClient(config.META_GRAPH_URL, config.META_GRAPH_VERSION),
    platform: whatsappPlatform,
    push,
    logger: app.log,
    ...(options.whatsappReceiptDelays
      ? { simulatorReceiptDelays: options.whatsappReceiptDelays }
      : {}),
  });
  const variables = new VariablesService(prisma);
  const whatsappHelper = whatsapp.helper();
  const executions = new ExecutionService({
    prisma,
    nodeTypes,
    workflows,
    credentials,
    variables,
    push,
    config,
    logger: app.log,
    whatsapp: whatsappHelper,
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
  activeWorkflows.push = push;
  activeWorkflows.eventValidators.set('whatsapp', async (subscription, node) => {
    if (subscription.scope === '*') return;
    const exists = await prisma.whatsAppAccount.count({ where: { id: subscription.scope } });
    if (!exists)
      throw badRequest(`"${node.name}": the selected WhatsApp number is not connected any more`);
  });
  whatsapp.onEvent = async (event, item) => {
    await activeWorkflows.dispatchEvent(event, item);
  };
  const calls = new CallService({
    prisma,
    whatsapp,
    push,
    logger: app.log,
    dataDir: config.dataDir,
    media: options.media ?? mediaConfigFrom(config),
    defaultTimezone: config.DEFAULT_TIMEZONE,
    onEvent: async (event, item) => {
      await activeWorkflows.dispatchEvent(event, item);
    },
  });
  whatsapp.onCalls = (account, value) => calls.handleWebhook(account, value);
  const aiProviders = new AiProviders(prisma, cipher, config);
  const agents = new AgentService({
    prisma,
    providers: aiProviders,
    whatsapp,
    executions,
    push,
    logger: app.log,
    defaultTimezone: config.DEFAULT_TIMEZONE,
  });
  calls.agent = agents.runCall;
  calls.agentAvailable = (account, agentId) => agents.available(account, agentId);
  whatsapp.onInbound = (account, message) => calls.handleInbound(account, message);
  whatsappHelper.requestCallPermission = (accountId, to, text) =>
    calls.requestPermission(accountId, to, text);
  whatsappHelper.startAgentCall = async (accountId, to, options) => {
    const { callId } = await calls.startOutbound({ accountId, to, handler: 'agent', ...options });
    return { callId, status: 'calling' };
  };
  whatsapp.onCallStatus = (account, status) => calls.handleCallStatus(account, status);
  calls.summarize = agents.summarizeCall;
  const phones = new PhoneNotifications(
    prisma,
    app.log,
    readServiceAccount(config.FCM_SERVICE_ACCOUNT),
    config.FCM_API_URL,
  );
  push.observers.add(phones.observe);
  const waitTracker = new WaitTracker(prisma, executions, app.log, options.waitTrackerIntervalMs);

  app.decorate('prisma', prisma);
  app.decorate('push', push);
  app.decorate('nodeTypes', nodeTypes);
  app.decorate('services', { workflows, executions, credentials, variables, activeWorkflows });
  app.decorate('testWebhooks', new TestWebhooks());
  app.decorate('queue', queue);
  app.decorate('waitTracker', waitTracker);
  app.decorate('flowforgeVersion', VERSION);
  app.decorate('whatsapp', whatsapp);
  app.decorate('whatsappPlatform', whatsappPlatform);
  app.decorate('whatsappGraphVersion', config.META_GRAPH_VERSION);
  app.decorate('calls', calls);
  app.decorate('aiProviders', aiProviders);
  app.decorate('agents', agents);
  app.decorate('startBackgroundServices', async () => {
    if (queue) {
      // Relay live events from workers to WebSocket clients.
      await queue.subscribe({
        onPush: (topics, event) => push.publish(topics, event),
        // Workflows running on workers: calls are made from here, where call audio lives.
        onCommand: (command) => {
          const run =
            command.type === 'callPermission'
              ? calls.requestPermission(command.accountId, command.to, command.text)
              : command.type === 'startCall'
                ? calls.startOutbound({ ...command, handler: 'agent' })
                : null;
          run?.catch((error: Error) =>
            app.log.warn(
              { err: error, command: command.type },
              'Call request from a worker failed',
            ),
          );
        },
      });
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
        origin === 'https://tauri.localhost' ||
        // The Android app (Capacitor) loads the editor from https://localhost.
        origin === 'https://localhost' ||
        origin === 'http://localhost';
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
  await app.register(inviteRoutes, { rateLimit: config.AUTH_RATE_LIMIT });
  await app.register(pushRoutes);
  await app.register(oauthCallbackRoutes, { config });
  await app.register(webhookRoutes, { config });
  await app.register(whatsappWebhookRoutes);

  // --- Authenticated API -----------------------------------------------------
  await app.register(async (api) => {
    api.addHook('onRequest', authenticate);
    api.get('/api/node-types', async () => ({
      data: nodeTypes.getAll().map((n) => n.description),
    }));
    api.get('/api/settings', async () => ({
      publicUrl: config.PUBLIC_URL.replace(/\/+$/, ''),
      editorUrl: config.editorUrl,
      executionsMode: config.EXECUTIONS_MODE,
      oauthCallbackUrl: `${config.PUBLIC_URL.replace(/\/+$/, '')}/rest/oauth2-credential/callback`,
      version: VERSION,
    }));
    await api.register(workflowRoutes, { config });
    await api.register(executionRoutes);
    await api.register(credentialRoutes, { config });
    await api.register(variableRoutes);
    await api.register(whatsappRoutes);
    await api.register(callRoutes);
    await api.register(agentRoutes);
    await api.register(userRoutes, { editorUrl: config.editorUrl });
    await api.register(dashboardRoutes, { defaultTimezone: config.DEFAULT_TIMEZONE });
    await api.register(deviceRoutes, { notifications: phones });
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
    await calls.shutdown();
    whatsapp.close();
    await executions.shutdown();
    push.closeAll();
    await queue?.close();
    if (!options.prisma) await prisma.$disconnect();
  });

  return app;
}
