import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import { PrismaClient } from '@prisma/client';
import { createNodeTypes } from '@flowforge/nodes';
import type { INodeTypes } from '@flowforge/workflow';
import { authenticate, authRoutes } from './auth/auth';
import type { Config } from './config';
import { ExecutionService } from './executions/ExecutionService';
import { executionRoutes } from './executions/routes';
import { registerErrorHandler } from './lib/errors';
import { PushHub } from './push/PushHub';
import { pushRoutes } from './push/routes';
import { WorkflowService } from './workflows/WorkflowService';
import { workflowRoutes } from './workflows/routes';

export const VERSION = '0.1.0';

export interface Services {
  workflows: WorkflowService;
  executions: ExecutionService;
}

declare module 'fastify' {
  interface FastifyInstance {
    prisma: PrismaClient;
    push: PushHub;
    nodeTypes: INodeTypes;
    services: Services;
    flowforgeVersion: string;
  }
}

export interface BuildOptions {
  prisma?: PrismaClient;
  logger?: FastifyServerOptions['logger'];
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
    bodyLimit: 16 * 1024 * 1024,
    trustProxy: true,
  });

  const prisma = options.prisma ?? new PrismaClient();
  const push = new PushHub(app.log);
  const nodeTypes = createNodeTypes();
  const workflows = new WorkflowService(prisma, nodeTypes);
  const executions = new ExecutionService(prisma, nodeTypes, workflows, push, config, app.log);

  app.decorate('prisma', prisma);
  app.decorate('push', push);
  app.decorate('nodeTypes', nodeTypes);
  app.decorate('services', { workflows, executions });
  app.decorate('flowforgeVersion', VERSION);

  registerErrorHandler(app);

  await app.register(cors, {
    // Same-origin editor needs no CORS; desktop/mobile apps and the dev server are listed explicitly.
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
      return { status: 'ok' };
    } catch {
      return reply
        .status(503)
        .send({ status: 'unavailable', message: 'Database is not reachable' });
    }
  });
  await app.register(authRoutes, { rateLimit: config.AUTH_RATE_LIMIT });
  await app.register(pushRoutes);

  // --- Authenticated API -----------------------------------------------------
  await app.register(async (api) => {
    api.addHook('onRequest', authenticate);
    api.get('/api/node-types', async () => ({
      data: nodeTypes.getAll().map((n) => n.description),
    }));
    await api.register(workflowRoutes);
    await api.register(executionRoutes);
  });

  // --- Editor (single page app) ---------------------------------------------
  if (config.editorDist) {
    const indexHtml = await readFile(resolve(config.editorDist, 'index.html'), 'utf8');
    await app.register(fastifyStatic, { root: config.editorDist, wildcard: false, index: false });
    const serveIndex = (
      _req: unknown,
      reply: { type: (t: string) => { send: (b: string) => unknown } },
    ) => reply.type('text/html').send(indexHtml);
    app.get('/', serveIndex);
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
    await executions.shutdown();
    push.closeAll();
    if (!options.prisma) await prisma.$disconnect();
  });

  return app;
}
