import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireRole } from '../auth/auth';
import { badRequest, parse } from '../lib/errors';
import type { CloudWebhook } from './events';

const idParams = z.object({ id: z.string().min(1) });

const safeEqual = (a: string, b: string) => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

/**
 * Public endpoint Meta calls: GET to verify the callback URL, POST with messages and receipts.
 * POST bodies must carry a valid X-Hub-Signature-256 made with the Meta app secret.
 */
export async function whatsappWebhookRoutes(app: FastifyInstance) {
  const { whatsapp, whatsappPlatform: platform } = app;

  // Raw body: the signature is computed over the exact bytes Meta sent.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser(
    '*',
    { parseAs: 'buffer', bodyLimit: 4 * 1024 * 1024 },
    (_req, body, done) => done(null, body),
  );

  app.get('/webhooks/whatsapp', async (request, reply) => {
    const query = request.query as Record<string, string | undefined>;
    const config = await platform.get();
    if (
      query['hub.mode'] === 'subscribe' &&
      query['hub.verify_token'] &&
      safeEqual(query['hub.verify_token'], config.verifyToken)
    ) {
      await platform.markWebhookVerified();
      return reply.type('text/plain').send(query['hub.challenge'] ?? '');
    }
    request.log.warn('WhatsApp webhook verification failed (wrong verify token)');
    return reply.status(403).send({ error: 'Forbidden', message: 'Verify token does not match' });
  });

  app.post('/webhooks/whatsapp', async (request, reply) => {
    const raw = request.body as Buffer | undefined;
    const config = await platform.get();
    if (!config.appSecret) {
      request.log.warn('WhatsApp webhook rejected: the Meta app secret is not configured');
      return reply.status(403).send({ error: 'Forbidden', message: 'App secret not configured' });
    }
    const signature = String(request.headers['x-hub-signature-256'] ?? '');
    const expected = `sha256=${createHmac('sha256', config.appSecret)
      .update(raw ?? Buffer.alloc(0))
      .digest('hex')}`;
    if (!signature || !safeEqual(signature, expected)) {
      request.log.warn('WhatsApp webhook rejected: invalid signature');
      return reply.status(401).send({ error: 'Unauthorized', message: 'Invalid signature' });
    }
    let body: CloudWebhook;
    try {
      body = JSON.parse((raw ?? Buffer.alloc(0)).toString('utf8')) as CloudWebhook;
    } catch {
      return reply.status(400).send({ error: 'BadRequest', message: 'Body is not JSON' });
    }
    // Meta expects a fast 200; slow work happens after replying.
    void platform.markWebhookReceived().catch(() => undefined);
    void whatsapp
      .handleWebhook(body)
      .catch((error: unknown) =>
        request.log.error({ err: error }, 'WhatsApp webhook processing failed'),
      );
    return reply.status(200).send({ ok: true });
  });
}

const platformSchema = z.object({
  appId: z
    .string()
    .trim()
    .regex(
      /^\d*$/,
      'The App ID is a number - find it at the top of your app in developers.facebook.com',
    )
    .optional(),
  appSecret: z.string().trim().max(200).optional(),
  configId: z
    .string()
    .trim()
    .regex(
      /^\d*$/,
      'The configuration ID is a number (Facebook Login for Business → Configurations)',
    )
    .optional(),
});

const embeddedSignupSchema = z.object({
  code: z.string().min(10).max(2000),
  wabaId: z.string().regex(/^\d+$/, 'Missing WhatsApp Business account id'),
  phoneNumberId: z.string().regex(/^\d+$/, 'Missing phone number id'),
});

const manualSchema = z.object({
  wabaId: z.string().trim().regex(/^\d+$/, 'The WhatsApp Business Account ID is a number'),
  phoneNumberId: z.string().trim().regex(/^\d+$/, 'The Phone number ID is a number'),
  accessToken: z.string().trim().min(20, 'Paste the permanent access token'),
});

const simulateSchema = z.object({
  from: z.string().min(1).max(32),
  name: z.string().max(100).optional(),
  text: z.string().max(4096).optional(),
  reply: z
    .object({
      id: z.string().max(256),
      title: z.string().max(100),
      type: z.enum(['button', 'list']),
    })
    .optional(),
  location: z
    .object({ latitude: z.number(), longitude: z.number(), name: z.string().max(200).optional() })
    .optional(),
  media: z
    .object({
      base64: z.string().max(12_000_000),
      mimeType: z.string().max(100),
      fileName: z.string().max(200).optional(),
      caption: z.string().max(1024).optional(),
    })
    .optional(),
});

/** Authenticated WhatsApp API (registered inside the /api scope). */
export async function whatsappRoutes(app: FastifyInstance) {
  const { whatsapp, whatsappPlatform: platform } = app;
  const admin = { onRequest: requireRole('owner', 'admin') };
  const owner = { onRequest: requireRole('owner') };

  /** Platform setup status. Secrets are never returned - only whether they are set. */
  app.get('/api/whatsapp/platform', async (request) => {
    const config = await platform.get();
    const isOwner = request.currentUser.role === 'owner';
    return {
      appId: config.appId,
      configId: config.configId,
      appSecretSet: Boolean(config.appSecret),
      embeddedSignupReady: Boolean(config.appId && config.appSecret && config.configId),
      sources: config.sources,
      webhookUrl: platform.webhookUrl(),
      // Only the owner pastes this into the Meta app.
      verifyToken: isOwner ? config.verifyToken : null,
      webhookVerifiedAt: config.webhookVerifiedAt,
      lastWebhookAt: config.lastWebhookAt,
      graphVersion: app.whatsappGraphVersion,
    };
  });

  app.put('/api/whatsapp/platform', owner, async (request) => {
    const body = parse(platformSchema, request.body);
    await platform.save(body);
    const config = await platform.get();
    return {
      appId: config.appId,
      configId: config.configId,
      appSecretSet: Boolean(config.appSecret),
    };
  });

  app.get('/api/whatsapp/accounts', async () => ({ data: await whatsapp.list() }));

  app.post('/api/whatsapp/accounts/embedded-signup', admin, async (request, reply) => {
    const body = parse(embeddedSignupSchema, request.body);
    return reply
      .status(201)
      .send(await whatsapp.connectEmbeddedSignup(request.currentUser.id, body));
  });

  app.post('/api/whatsapp/accounts/manual', admin, async (request, reply) => {
    const body = parse(manualSchema, request.body);
    return reply.status(201).send(await whatsapp.connectManual(request.currentUser.id, body));
  });

  app.post('/api/whatsapp/accounts/simulator', admin, async (request, reply) => {
    const body = parse(z.object({ name: z.string().max(100).optional() }), request.body ?? {});
    return reply.status(201).send(await whatsapp.createSimulator(request.currentUser.id, body));
  });

  app.post('/api/whatsapp/accounts/:id/refresh', admin, async (request) => {
    const { id } = parse(idParams, request.params);
    return whatsapp.refresh(id);
  });

  app.delete('/api/whatsapp/accounts/:id', admin, async (request, reply) => {
    const { id } = parse(idParams, request.params);
    await whatsapp.disconnect(id);
    return reply.status(204).send();
  });

  app.get('/api/whatsapp/accounts/:id/conversations', async (request) => {
    const { id } = parse(idParams, request.params);
    return { data: await whatsapp.conversations(id) };
  });

  app.get('/api/whatsapp/accounts/:id/messages', async (request) => {
    const { id } = parse(idParams, request.params);
    const query = parse(
      z.object({
        contact: z.string().regex(/^\d+$/).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
        before: z.iso.datetime().optional(),
      }),
      request.query,
    );
    return { data: await whatsapp.messages(id, query) };
  });

  /** Send a quick text from the WhatsApp page (e.g. "send a test message"). */
  app.post('/api/whatsapp/accounts/:id/send', async (request) => {
    const { id } = parse(idParams, request.params);
    const body = parse(
      z.object({ to: z.string().min(5).max(32), text: z.string().min(1).max(4096) }),
      request.body,
    );
    return whatsapp.send(id, body.to, { type: 'text', text: { body: body.text } });
  });

  app.post('/api/whatsapp/accounts/:id/simulate', async (request) => {
    const { id } = parse(idParams, request.params);
    const { media, ...body } = parse(simulateSchema, request.body);
    return whatsapp.simulateInbound(id, {
      ...body,
      ...(media
        ? {
            media: {
              data: Buffer.from(media.base64, 'base64'),
              mimeType: media.mimeType,
              fileName: media.fileName,
              caption: media.caption,
            },
          }
        : {}),
    });
  });

  app.get('/api/whatsapp/accounts/:id/templates', async (request) => {
    const { id } = parse(idParams, request.params);
    return { data: await whatsapp.listTemplates(id) };
  });

  /** Step-by-step setup status shown at the top of the WhatsApp page. */
  app.get('/api/whatsapp/checklist', async () => {
    const config = await platform.get();
    const accounts = await whatsapp.list();
    const cloud = accounts.filter((a) => a.mode === 'cloud');
    const ready = cloud.filter((a) => a.status === 'connected');
    const [received, sent] = await Promise.all([
      app.prisma.whatsAppMessage.count({
        where: { direction: 'inbound', account: { mode: 'cloud' } },
      }),
      app.prisma.whatsAppMessage.count({
        where: { direction: 'outbound', status: { not: 'failed' }, account: { mode: 'cloud' } },
      }),
    ]);
    const workflows = app.services.activeWorkflows.eventWorkflowIds('whatsapp').length;
    const simulators = accounts.length - cloud.length;
    const agentRows = await app.prisma.agent.findMany();
    let agentReady = false;
    for (const agent of agentRows)
      if (!(await app.agents.missingProviders(agent)).length) agentReady = true;
    type Status = 'done' | 'todo' | 'error' | 'soon';
    const step = (id: string, title: string, status: Status, detail: string) => ({
      id,
      title,
      status,
      detail,
    });
    return {
      steps: [
        step(
          'platform',
          'Add your Meta app',
          config.appId && config.appSecret && config.configId ? 'done' : 'todo',
          config.appId && config.appSecret && config.configId
            ? `App ${config.appId} is set up for one-click connection.`
            : 'Once, by the owner: App ID, App Secret and the Embedded Signup configuration ID. Customers never see these.',
        ),
        step(
          'webhook',
          'Connect the webhook',
          config.webhookVerifiedAt ? 'done' : 'todo',
          config.webhookVerifiedAt
            ? `Verified ${new Date(config.webhookVerifiedAt).toLocaleString('en')}.`
            : 'Paste the callback URL and verify token into your Meta app (WhatsApp → Configuration) and subscribe to "messages".',
        ),
        step(
          'number',
          'Connect a WhatsApp number',
          ready.length ? 'done' : cloud.length ? 'error' : 'todo',
          ready.length
            ? ready
                .map(
                  (a) => `${a.displayPhoneNumber}${a.verifiedName ? ` (${a.verifiedName})` : ''}`,
                )
                .join(', ')
            : cloud.length
              ? (cloud[0]!.lastError ?? 'The number needs attention - use Refresh.')
              : `Click "Connect WhatsApp" and log in with Facebook.${simulators ? ' Your test number works meanwhile.' : ''}`,
        ),
        step(
          'receive',
          'Receive a message',
          received ? 'done' : 'todo',
          received
            ? `${received} message${received === 1 ? '' : 's'} received.`
            : 'Send a WhatsApp message to your number from your phone.',
        ),
        step(
          'send',
          'Send a message',
          sent ? 'done' : 'todo',
          sent
            ? `${sent} message${sent === 1 ? '' : 's'} sent.`
            : 'Reply from a workflow (WhatsApp node) or with "Send test message".',
        ),
        step(
          'workflow',
          'Automate replies',
          workflows ? 'done' : 'todo',
          workflows
            ? `${workflows} active workflow${workflows === 1 ? '' : 's'} with a WhatsApp Trigger.`
            : 'Create a workflow that starts with "WhatsApp Trigger" and activate it.',
        ),
        step(
          'calls',
          'Answer calls',
          accounts.some((a) => a.callingEnabled) ? 'done' : 'todo',
          accounts.some((a) => a.callingEnabled)
            ? 'Calling is on - calls ring in the app, go to voicemail, the AI agent, or are rejected, as you set.'
            : 'Open "Calls" on a number, choose how calls are answered and switch calling on.',
        ),
        step(
          'agent',
          'AI voice agent',
          agentReady ? 'done' : 'todo',
          agentReady
            ? 'An AI agent is ready to answer calls 24/7 - choose "AI voice agent" in a number\'s call settings.'
            : 'Add an AI provider key and create an agent on the "AI agents" page.',
        ),
      ],
      simulators,
    };
  });
}

/** Dropdown options for WhatsApp nodes (GET /api/node-options/<method>). */
export async function whatsappNodeOptions(
  app: FastifyInstance,
  method: string,
  query: Record<string, string | undefined>,
): Promise<Array<{ name: string; value: string; description?: string }> | null> {
  if (method === 'whatsappAccounts' || method === 'whatsappAccountsOrAny') {
    const accounts = await app.whatsapp.list();
    const options = accounts.map((a) => ({
      name: `${a.displayPhoneNumber} - ${a.verifiedName ?? a.name}${a.mode === 'simulator' ? ' (test)' : ''}`,
      value: a.id,
    }));
    return method === 'whatsappAccountsOrAny'
      ? [{ name: 'Any connected number', value: '*' }, ...options]
      : options;
  }
  if (method === 'whatsappTemplates') {
    if (!query.account) return [];
    const templates = await app.whatsapp.listTemplates(query.account).catch((error: Error) => {
      throw badRequest(`Could not load templates: ${error.message}`);
    });
    return templates
      .filter((t) => t.status === 'APPROVED')
      .map((t) => ({ name: `${String(t.name)} · ${String(t.language)}`, value: String(t.name) }));
  }
  return null;
}
