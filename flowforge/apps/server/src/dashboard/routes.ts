import type { FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { workflowCreateSchema } from '@flowforge/workflow';
import { parse } from '../lib/errors';
import { TEMPLATES } from '../templates/templates';

const isZone = (zone: string) => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
};

/** The days of the period in a timezone, oldest first ("2026-10-08"). */
function dayKeys(days: number, timezone: string): string[] {
  const format = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const keys: string[] = [];
  for (let i = days - 1; i >= 0; i--)
    keys.push(format.format(new Date(Date.now() - i * 86_400_000)));
  return [...new Set(keys)];
}

/** Dashboard numbers and the workflow template gallery (inside the /api scope). */
export async function dashboardRoutes(app: FastifyInstance, opts: { defaultTimezone: string }) {
  const { prisma } = app;

  app.get('/api/dashboard', async (request) => {
    const query = parse(
      z.object({
        days: z.coerce.number().int().min(1).max(90).default(7),
        timezone: z.string().max(64).optional(),
        accountId: z.string().optional(),
      }),
      request.query,
    );
    const timezone =
      query.timezone && isZone(query.timezone) ? query.timezone : opts.defaultTimezone;
    const keys = dayKeys(query.days, timezone);
    // Rows from a day before the window too: they are bucketed by local day and outside days dropped.
    const since = new Date(Date.now() - query.days * 86_400_000 - 86_400_000);
    const accountFilter = query.accountId
      ? Prisma.sql`AND "accountId" = ${query.accountId}`
      : Prisma.empty;
    const localDay = (column: string) =>
      Prisma.raw(
        `to_char(("${column}" AT TIME ZONE 'UTC') AT TIME ZONE '${timezone.replace(/'/g, '')}', 'YYYY-MM-DD')`,
      );
    const localHour = (column: string) =>
      Prisma.raw(
        `extract(hour from ("${column}" AT TIME ZONE 'UTC') AT TIME ZONE '${timezone.replace(/'/g, '')}')::int`,
      );

    const [
      callDays,
      callHours,
      messageDays,
      executionDays,
      handled,
      durations,
      topCallers,
      agents,
      missed,
    ] = await Promise.all([
      prisma.$queryRaw<Array<{ day: string; status: string; count: number }>>`
          SELECT ${localDay('startedAt')} AS day, status::text AS status, count(*)::int AS count
          FROM "Call" WHERE "startedAt" >= ${since} ${accountFilter} GROUP BY 1, 2`,
      prisma.$queryRaw<Array<{ hour: number; count: number }>>`
          SELECT ${localHour('startedAt')} AS hour, count(*)::int AS count
          FROM "Call" WHERE "startedAt" >= ${since} ${accountFilter} GROUP BY 1`,
      prisma.$queryRaw<Array<{ day: string; direction: string; count: number }>>`
          SELECT ${localDay('timestamp')} AS day, direction::text AS direction, count(*)::int AS count
          FROM "WhatsAppMessage" WHERE "timestamp" >= ${since} ${accountFilter} GROUP BY 1, 2`,
      prisma.$queryRaw<Array<{ day: string; status: string; count: number }>>`
          SELECT ${localDay('createdAt')} AS day, status::text AS status, count(*)::int AS count
          FROM "Execution" WHERE "createdAt" >= ${since} AND mode <> 'manual' GROUP BY 1, 2`,
      prisma.call.groupBy({
        by: ['handledBy'],
        where: {
          startedAt: { gte: since },
          ...(query.accountId ? { accountId: query.accountId } : {}),
        },
        _count: true,
      }),
      prisma.call.aggregate({
        where: {
          startedAt: { gte: since },
          status: 'ended',
          ...(query.accountId ? { accountId: query.accountId } : {}),
        },
        _avg: { durationSeconds: true },
        _sum: { durationSeconds: true },
      }),
      prisma.call.groupBy({
        by: ['contact'],
        where: {
          startedAt: { gte: since },
          ...(query.accountId ? { accountId: query.accountId } : {}),
        },
        _count: { _all: true },
        orderBy: { _count: { contact: 'desc' } },
        take: 5,
      }),
      prisma.call.groupBy({
        by: ['agentId'],
        where: { startedAt: { gte: since }, agentId: { not: null } },
        _count: { _all: true },
        _avg: { durationSeconds: true },
      }),
      prisma.call.findMany({
        where: {
          startedAt: { gte: since },
          status: { in: ['missed', 'rejected'] },
          ...(query.accountId ? { accountId: query.accountId } : {}),
        },
        orderBy: { startedAt: 'desc' },
        take: 5,
        select: { id: true, contact: true, contactName: true, startedAt: true, status: true },
      }),
    ]);

    const calls = keys.map((day) => ({ day, answered: 0, missed: 0, other: 0 }));
    const callIndex = new Map(calls.map((c) => [c.day, c]));
    for (const row of callDays) {
      const entry = callIndex.get(row.day);
      if (!entry) continue;
      if (row.status === 'ended' || row.status === 'answered') entry.answered += row.count;
      else if (row.status === 'missed' || row.status === 'rejected') entry.missed += row.count;
      else entry.other += row.count;
    }
    const messages = keys.map((day) => ({ day, received: 0, sent: 0 }));
    const messageIndex = new Map(messages.map((m) => [m.day, m]));
    for (const row of messageDays) {
      const entry = messageIndex.get(row.day);
      if (!entry) continue;
      if (row.direction === 'inbound') entry.received += row.count;
      else entry.sent += row.count;
    }
    const executions = keys.map((day) => ({ day, success: 0, error: 0 }));
    const executionIndex = new Map(executions.map((e) => [e.day, e]));
    for (const row of executionDays) {
      const entry = executionIndex.get(row.day);
      if (!entry) continue;
      if (row.status === 'success') entry.success += row.count;
      else if (row.status === 'error' || row.status === 'crashed') entry.error += row.count;
    }
    const hours = Array.from({ length: 24 }, (_, hour) => ({ hour, count: 0 }));
    // Hours are counted over the whole window (a day of slack included); fine for "busiest hours".
    for (const row of callHours) hours[row.hour]!.count += row.count;

    const sum = <T>(list: T[], pick: (t: T) => number) => list.reduce((n, t) => n + pick(t), 0);
    const totalCalls = sum(calls, (c) => c.answered + c.missed + c.other);
    const handledBy = Object.fromEntries(handled.map((h) => [h.handledBy ?? 'none', h._count]));
    const ai = (handledBy.ai ?? 0) + (handledBy['ai+person'] ?? 0);
    const names = new Map(
      (
        await prisma.call.findMany({
          where: { contact: { in: topCallers.map((t) => t.contact) }, contactName: { not: null } },
          distinct: ['contact'],
          select: { contact: true, contactName: true },
        })
      ).map((c) => [c.contact, c.contactName]),
    );
    const agentNames = new Map(
      (
        await prisma.agent.findMany({
          where: { id: { in: agents.flatMap((a) => (a.agentId ? [a.agentId] : [])) } },
          select: { id: true, name: true },
        })
      ).map((a) => [a.id, a.name]),
    );

    return {
      days: query.days,
      timezone,
      totals: {
        calls: totalCalls,
        answered: sum(calls, (c) => c.answered),
        missed: sum(calls, (c) => c.missed),
        answerRate: totalCalls ? sum(calls, (c) => c.answered) / totalCalls : null,
        handledByAi: ai,
        handledByPeople: (handledBy.person ?? 0) + (handledBy['ai+person'] ?? 0),
        voicemail: handledBy.voicemail ?? 0,
        averageCallSeconds: Math.round(durations._avg.durationSeconds ?? 0),
        talkMinutes: Math.round((durations._sum.durationSeconds ?? 0) / 60),
        messagesReceived: sum(messages, (m) => m.received),
        messagesSent: sum(messages, (m) => m.sent),
        workflowRuns: sum(executions, (e) => e.success + e.error),
        workflowErrors: sum(executions, (e) => e.error),
      },
      series: { calls, messages, executions },
      busiestHours: hours,
      topCallers: topCallers.map((t) => ({
        contact: t.contact,
        contactName: names.get(t.contact) ?? null,
        calls: t._count._all,
      })),
      agents: agents.map((a) => ({
        agentId: a.agentId,
        name: agentNames.get(a.agentId!) ?? 'Deleted agent',
        calls: a._count._all,
        averageSeconds: Math.round(a._avg.durationSeconds ?? 0),
      })),
      recentMissed: missed.map((m) => ({ ...m, startedAt: m.startedAt.toISOString() })),
    };
  });

  // ---- Workflow templates -------------------------------------------------------------------------

  app.get('/api/templates', async () => ({
    data: TEMPLATES.map(({ nodes, connections: _connections, ...t }) => ({
      ...t,
      nodeTypes: [...new Set(nodes.map((n) => n.type))],
    })),
  }));

  /** Create a workflow from a template. */
  app.post('/api/templates/:id/use', async (request, reply) => {
    const { id } = parse(z.object({ id: z.string() }), request.params);
    const template = TEMPLATES.find((t) => t.id === id);
    if (!template)
      return reply.status(404).send({ error: 'NotFound', message: 'Template not found' });
    // The user's own credentials, picked by type (newest first); none are ever stored in templates.
    const credentialsByType = new Map<string, { id: string; name: string } | null>();
    for (const type of new Set(template.nodes.flatMap((n) => n.credentialTypes ?? []))) {
      const [newest] = await app.services.credentials.list(request.currentUser, type);
      credentialsByType.set(type, newest ? { id: newest.id, name: newest.name } : null);
    }
    const nodes = template.nodes.map(({ credentialTypes, ...n }) => {
      const credentials = Object.fromEntries(
        (credentialTypes ?? []).flatMap((type) => {
          const found = credentialsByType.get(type);
          return found ? [[type, found]] : [];
        }),
      );
      return Object.keys(credentials).length ? { ...n, credentials } : n;
    });
    const row = await app.services.workflows.create(
      request.currentUser,
      parse(workflowCreateSchema, {
        name: template.name,
        nodes,
        connections: template.connections,
        settings: template.settings ?? {},
        active: false,
      }),
    );
    const missingCredentials = [...credentialsByType]
      .filter(([, found]) => !found)
      .map(([type]) => app.services.credentials.types.get(type)?.displayName ?? type);
    return reply.status(201).send({
      id: row.id,
      name: row.name,
      setup: template.setup,
      missingCredentials,
    });
  });
}
