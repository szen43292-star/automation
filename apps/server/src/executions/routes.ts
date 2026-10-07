import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse } from '../lib/errors';

const STATUSES = ['new', 'running', 'success', 'error', 'canceled', 'crashed', 'waiting'] as const;

const listQuery = z.object({
  workflowId: z.string().optional(),
  status: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',') : undefined))
    .pipe(z.array(z.enum(STATUSES)).optional()),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
});

const idParams = z.object({ id: z.string().min(1) });

export async function executionRoutes(app: FastifyInstance) {
  const { executions } = app.services;

  app.get('/api/executions', async (request) => {
    return executions.list(request.currentUser, parse(listQuery, request.query));
  });

  app.get('/api/executions/:id', async (request) => {
    const { id } = parse(idParams, request.params);
    return executions.get(request.currentUser, id);
  });

  app.post('/api/executions/:id/stop', async (request) => {
    const { id } = parse(idParams, request.params);
    return executions.stop(request.currentUser, id);
  });

  app.post('/api/executions/:id/retry', async (request, reply) => {
    const { id } = parse(idParams, request.params);
    const { useCurrentWorkflow } = parse(
      z.object({ useCurrentWorkflow: z.boolean().default(false) }),
      request.body ?? {},
    );
    return reply.status(202).send(await executions.retry(request.currentUser, id, useCurrentWorkflow));
  });

  app.delete('/api/executions/:id', async (request, reply) => {
    const { id } = parse(idParams, request.params);
    await executions.remove(request.currentUser, [id]);
    return reply.status(204).send();
  });

  app.post('/api/executions/delete', async (request) => {
    const { ids } = parse(z.object({ ids: z.array(z.string()).min(1).max(1000) }), request.body);
    return executions.remove(request.currentUser, ids);
  });
}
