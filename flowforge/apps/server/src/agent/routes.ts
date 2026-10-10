import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireRole } from '../auth/auth';
import { pickModel, suitable } from '../ai/models';
import { PROVIDERS } from '../ai/providers';
import { HttpError, parse } from '../lib/errors';
import {
  DEFAULT_MODELS,
  DEFAULT_VOICES,
  LLM_PROVIDERS,
  STT_PROVIDERS,
  TTS_PROVIDERS,
  agentInputSchema,
} from './config';

const idParams = z.object({ id: z.string().min(1) });
const docParams = z.object({ id: z.string().min(1), documentId: z.string().min(1) });
const documentBody = z.object({
  title: z.string().trim().min(1).max(200),
  content: z.string().trim().min(1).max(500_000),
});

/** AI providers, agents, their knowledge, and the test chat (inside the /api scope). */
export async function agentRoutes(app: FastifyInstance) {
  const { agents, aiProviders } = app;
  const admin = { onRequest: requireRole('owner', 'admin') };
  const owner = { onRequest: requireRole('owner') };

  // ---- AI providers (keys never leave the server) ------------------------------------------------

  app.get('/api/ai/providers', async () => ({ data: await aiProviders.status() }));

  app.put('/api/ai/providers', owner, async (request) => {
    const body = parse(
      z.object(
        Object.fromEntries(
          PROVIDERS.map((id) => [id, z.string().max(500).nullable().optional()]),
        ) as Record<(typeof PROVIDERS)[number], z.ZodOptional<z.ZodNullable<z.ZodString>>>,
      ),
      request.body,
    );
    await aiProviders.save(body);
    return { data: await aiProviders.status() };
  });

  /** The models a provider's key can use, and the one picked automatically (empty model). */
  app.get('/api/ai/models', async (request) => {
    const query = parse(
      z.object({ provider: z.enum(PROVIDERS), purpose: z.enum(['llm', 'stt']) }),
      request.query,
    );
    const available = await aiProviders.models(query.provider);
    const fallback =
      query.purpose === 'llm'
        ? DEFAULT_MODELS.llm[query.provider as keyof typeof DEFAULT_MODELS.llm]
        : DEFAULT_MODELS.stt[query.provider as keyof typeof DEFAULT_MODELS.stt];
    return {
      data: (available ?? []).filter((m) => suitable(query.purpose, m)).sort(),
      automatic: fallback
        ? pickModel(query.purpose, query.provider, available, '', fallback)
        : null,
    };
  });

  // ---- Agents -------------------------------------------------------------------------------------

  /** Everything the agent builder needs: providers, defaults, workflows usable as tools. */
  app.get('/api/agents/options', async () => {
    const workflows = await app.prisma.workflow.findMany({
      select: { id: true, name: true, nodes: true },
      orderBy: { updatedAt: 'desc' },
    });
    return {
      providers: await aiProviders.status(),
      sttProviders: STT_PROVIDERS,
      llmProviders: LLM_PROVIDERS,
      ttsProviders: TTS_PROVIDERS,
      defaultModels: DEFAULT_MODELS,
      defaultVoices: DEFAULT_VOICES,
      workflows: workflows
        .filter((w) =>
          (w.nodes as Array<{ type: string; disabled?: boolean }>).some(
            (n) => n.type === 'flowforge.executeWorkflowTrigger' && !n.disabled,
          ),
        )
        .map((w) => ({ id: w.id, name: w.name })),
    };
  });

  app.get('/api/agents', async () => ({ data: await agents.list() }));

  app.post('/api/agents', admin, async (request, reply) => {
    const input = parse(agentInputSchema, request.body);
    return reply.status(201).send(await agents.create(input, request.currentUser.id));
  });

  app.get('/api/agents/:id', async (request) => {
    const { id } = parse(idParams, request.params);
    const agent = await agents.get(id);
    const row = await app.prisma.agent.findUniqueOrThrow({ where: { id } });
    return { ...agent, missingProviders: await agents.missingProviders(row) };
  });

  app.put('/api/agents/:id', admin, async (request) => {
    const { id } = parse(idParams, request.params);
    return agents.update(id, parse(agentInputSchema, request.body));
  });

  app.delete('/api/agents/:id', admin, async (request, reply) => {
    await agents.remove(parse(idParams, request.params).id);
    return reply.status(204).send();
  });

  // ---- Knowledge ----------------------------------------------------------------------------------

  app.post('/api/agents/:id/documents', admin, async (request, reply) => {
    const { id } = parse(idParams, request.params);
    return reply.status(201).send(await agents.addDocument(id, parse(documentBody, request.body)));
  });

  app.get('/api/agents/:id/documents/:documentId', async (request) => {
    const { id, documentId } = parse(docParams, request.params);
    return agents.getDocument(id, documentId);
  });

  app.put('/api/agents/:id/documents/:documentId', admin, async (request) => {
    const { id, documentId } = parse(docParams, request.params);
    await agents.updateDocument(id, documentId, parse(documentBody, request.body));
    return agents.getDocument(id, documentId);
  });

  app.delete('/api/agents/:id/documents/:documentId', admin, async (request, reply) => {
    const { id, documentId } = parse(docParams, request.params);
    await agents.removeDocument(id, documentId);
    return reply.status(204).send();
  });

  app.get('/api/agents/:id/search', async (request) => {
    const { id } = parse(idParams, request.params);
    const { q } = parse(z.object({ q: z.string().min(1).max(500) }), request.query);
    return { data: await agents.search(id, q) };
  });

  // ---- Test chat ----------------------------------------------------------------------------------

  app.post('/api/agents/:id/chat', async (request) => {
    const { id } = parse(idParams, request.params);
    const { messages } = parse(
      z.object({
        messages: z
          .array(
            z.object({
              role: z.enum(['caller', 'agent']),
              text: z.string().trim().min(1).max(4000),
            }),
          )
          .min(1)
          .max(60),
      }),
      request.body,
    );
    try {
      return await agents.testChat(id, messages, { name: request.currentUser.name });
    } catch (error) {
      if (error instanceof HttpError) throw error;
      // The AI provider failed (bad key, model name, rate limit...): say which and why.
      throw new HttpError(502, (error as Error).message, 'AiProviderError');
    }
  });

  // ---- Which agent answers a number --------------------------------------------------------------

  app.put('/api/whatsapp/accounts/:id/agent', admin, async (request) => {
    const { id } = parse(idParams, request.params);
    const { agentId } = parse(z.object({ agentId: z.string().min(1).nullable() }), request.body);
    await agents.assign(id, agentId);
    return { agentId };
  });
}
