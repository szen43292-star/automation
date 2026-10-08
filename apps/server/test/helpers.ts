import type { FastifyInstance } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { buildApp } from '../src/app';
import { loadConfig } from '../src/config';

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/flowforge_test';

export const prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });

export async function createTestApp(): Promise<FastifyInstance> {
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: TEST_DATABASE_URL,
    JWT_SECRET: 'test-secret-test-secret-test-secret-123',
    LOG_LEVEL: 'silent',
    CODE_TIMEOUT_MS: '3000',
    AUTH_RATE_LIMIT: '1000',
    EDITOR_DIST: '/nonexistent',
  });
  config.editorDist = null;
  const app = await buildApp(config, { prisma, logger: false });
  await app.ready();
  return app;
}

/** Empty all tables between tests. Only ever runs against a *_test database. */
export async function resetDb() {
  if (!new URL(TEST_DATABASE_URL).pathname.endsWith('_test'))
    throw new Error('resetDb only runs on *_test databases');
  // A background execution from the previous test (error workflow, schedule, wait) may still be
  // writing; if PostgreSQL picks the TRUNCATE as a deadlock victim, try again.
  for (let attempt = 1; ; attempt++) {
    try {
      await prisma.$executeRawUnsafe(
        'TRUNCATE "ExecutionData", "Execution", "WebhookEntity", "WorkflowVersion", "Workflow", "Credential", "Variable", "User" RESTART IDENTITY CASCADE',
      );
      return;
    } catch (error) {
      if (attempt >= 5 || !String((error as Error).message).includes('40P01')) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
    }
  }
}

export const OWNER = { email: 'owner@example.com', name: 'Owner', password: 'Sup3rSecret!' };

export async function setupOwner(app: FastifyInstance): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/setup', payload: OWNER });
  if (res.statusCode !== 201) throw new Error(`setup failed: ${res.body}`);
  return res.json().token as string;
}

export const auth = (token: string) => ({ authorization: `Bearer ${token}` });

/** Wait for every running execution to finish. */
export async function settle(app: FastifyInstance, executionId: string) {
  await app.services.executions.waitFor(executionId);
}

export const manualTrigger = {
  id: 'trigger',
  name: 'Manual Trigger',
  type: 'flowforge.manualTrigger',
  typeVersion: 1,
  position: [0, 0] as [number, number],
  parameters: {},
};
