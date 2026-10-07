import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { requireRole } from '../auth/auth';
import { parse } from '../lib/errors';

const bodySchema = z.object({
  key: z
    .string()
    .trim()
    .regex(
      /^[A-Za-z_][A-Za-z0-9_]{0,63}$/,
      'Keys may contain letters, numbers and _ and must not start with a number',
    ),
  value: z.string().max(10_000),
});

/** Variables as a plain object for `$vars` (cached briefly). */
export class VariablesService {
  private cache?: { at: number; values: Record<string, string> };
  constructor(private readonly prisma: PrismaClient) {}

  async all(): Promise<Record<string, string>> {
    if (this.cache && Date.now() - this.cache.at < 5_000) return this.cache.values;
    const rows = await this.prisma.variable.findMany();
    const values = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    this.cache = { at: Date.now(), values };
    return values;
  }

  invalidate() {
    this.cache = undefined;
  }
}

export async function variableRoutes(app: FastifyInstance) {
  const { variables } = app.services;
  const admin = { onRequest: requireRole('owner', 'admin') };

  app.get('/api/variables', async () => {
    const rows = await app.prisma.variable.findMany({ orderBy: { key: 'asc' } });
    return {
      data: rows.map((r) => ({
        id: r.id,
        key: r.key,
        value: r.value,
        updatedAt: r.updatedAt.toISOString(),
      })),
    };
  });

  app.post('/api/variables', admin, async (request, reply) => {
    const body = parse(bodySchema, request.body);
    const row = await app.prisma.variable.create({ data: body });
    variables.invalidate();
    return reply.status(201).send({ id: row.id, key: row.key, value: row.value });
  });

  app.patch('/api/variables/:id', admin, async (request) => {
    const { id } = parse(z.object({ id: z.string() }), request.params);
    const body = parse(bodySchema.partial(), request.body);
    const row = await app.prisma.variable.update({ where: { id }, data: body });
    variables.invalidate();
    return { id: row.id, key: row.key, value: row.value };
  });

  app.delete('/api/variables/:id', admin, async (request, reply) => {
    const { id } = parse(z.object({ id: z.string() }), request.params);
    await app.prisma.variable.delete({ where: { id } });
    variables.invalidate();
    return reply.status(204).send();
  });
}
