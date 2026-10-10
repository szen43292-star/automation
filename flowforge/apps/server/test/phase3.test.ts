import { createHmac } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { auth, createTestApp, eventually, prisma, resetDb, setupOwner } from './helpers';

/**
 * Phase 3 - WhatsApp Business. A local fake of Meta's Graph API stands in for graph.facebook.com.
 */
const APP_SECRET = 'test-app-secret-0123456789abcdef';
const PHONE_ID = '200200200';
const WABA_ID = '100100100';

let app: FastifyInstance;
let token: string;
let graph: Server;
let graphUrl: string;
const graphCalls: Array<{
  method: string;
  path: string;
  query: URLSearchParams;
  auth?: string;
  body: string;
}> = [];

const readBody = (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });

beforeAll(async () => {
  let sent = 0;
  graph = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://graph');
    const body = await readBody(req);
    graphCalls.push({
      method: req.method!,
      path: url.pathname,
      query: url.searchParams,
      auth: req.headers.authorization,
      body,
    });
    const json = (status: number, value: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    const path = url.pathname.replace(/^\/v23\.0/, '');
    if (path === '/oauth/access_token') {
      if (
        url.searchParams.get('code') !== 'good-code-from-meta' ||
        url.searchParams.get('client_secret') !== APP_SECRET
      ) {
        return json(400, {
          error: {
            message: 'Invalid verification code format.',
            code: 100,
            type: 'OAuthException',
          },
        });
      }
      return json(200, { access_token: 'EAAG-business-token-0001', token_type: 'bearer' });
    }
    if (
      req.headers.authorization !== 'Bearer EAAG-business-token-0001' &&
      !path.startsWith('/files/')
    ) {
      return json(401, { error: { message: 'Invalid OAuth access token.', code: 190 } });
    }
    if (path === `/${PHONE_ID}` && req.method === 'GET') {
      return json(200, {
        id: PHONE_ID,
        display_phone_number: '+91 98000 11111',
        verified_name: 'Asha Bakery',
        quality_rating: 'GREEN',
        code_verification_status: 'VERIFIED',
        name_status: 'APPROVED',
        messaging_limit_tier: 'TIER_1K',
      });
    }
    if (path === `/${WABA_ID}/subscribed_apps`) return json(200, { success: true });
    if (path === `/${PHONE_ID}/register`) return json(200, { success: true });
    if (path === `/${PHONE_ID}/media`) return json(200, { id: 'uploaded-media-1' });
    if (path === `/${PHONE_ID}/messages`) {
      const message = JSON.parse(body) as { to?: string; status?: string };
      if (message.status === 'read') return json(200, { success: true });
      if (message.to === '15550000000') {
        return json(400, {
          error: {
            message: 'Re-engagement message',
            code: 131047,
            error_data: {
              details: 'Message failed to send because more than 24 hours have passed.',
            },
          },
        });
      }
      sent++;
      return json(200, {
        messaging_product: 'whatsapp',
        contacts: [{ input: message.to, wa_id: message.to }],
        messages: [{ id: `wamid.TEST${sent}` }],
      });
    }
    if (path === `/${WABA_ID}/message_templates`) {
      return json(200, {
        data: [
          { name: 'order_shipped', language: 'en_US', status: 'APPROVED', category: 'UTILITY' },
          { name: 'draft_offer', language: 'en_US', status: 'PENDING', category: 'MARKETING' },
        ],
      });
    }
    if (path === '/incoming-photo-1') {
      return json(200, {
        url: `${graphUrl}/files/photo.jpg`,
        mime_type: 'image/jpeg',
        sha256: 'abc',
      });
    }
    if (path === '/files/photo.jpg') {
      if (req.headers.authorization !== 'Bearer EAAG-business-token-0001') return json(401, {});
      res.writeHead(200, { 'content-type': 'image/jpeg' });
      return res.end(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]));
    }
    return json(404, { error: { message: `Unknown path ${path}`, code: 100 } });
  });
  await new Promise<void>((r) => graph.listen(0, '127.0.0.1', r));
  graphUrl = `http://127.0.0.1:${(graph.address() as AddressInfo).port}`;
  app = await createTestApp({ META_GRAPH_URL: graphUrl }, { whatsappReceiptDelays: [30, 60] });
});

afterAll(async () => {
  await app.close();
  await new Promise<void>((r) => graph.close(() => r()));
  await prisma.$disconnect();
});

beforeEach(async () => {
  await resetDb();
  app.whatsappPlatform.invalidate();
  graphCalls.length = 0;
  token = await setupOwner(app);
});

const H = () => auth(token);

async function configurePlatform() {
  const res = await app.inject({
    method: 'PUT',
    url: '/api/whatsapp/platform',
    headers: H(),
    payload: { appId: '123456789', appSecret: APP_SECRET, configId: '987654321' },
  });
  expect(res.statusCode).toBe(200);
}

async function connectCloudNumber(): Promise<string> {
  await configurePlatform();
  const res = await app.inject({
    method: 'POST',
    url: '/api/whatsapp/accounts/embedded-signup',
    headers: H(),
    payload: { code: 'good-code-from-meta', wabaId: WABA_ID, phoneNumberId: PHONE_ID },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

/** POST a webhook body the way Meta does, signed with the app secret. */
async function deliverWebhook(body: unknown, secret = APP_SECRET) {
  const raw = JSON.stringify(body);
  return app.inject({
    method: 'POST',
    url: '/webhooks/whatsapp',
    headers: {
      'content-type': 'application/json',
      'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`,
    },
    payload: raw,
  });
}

const inboundText = (id: string, text: string, from = '919876543210', name = 'Asha') => ({
  object: 'whatsapp_business_account',
  entry: [
    {
      id: WABA_ID,
      changes: [
        {
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            metadata: { display_phone_number: '919800011111', phone_number_id: PHONE_ID },
            contacts: [{ wa_id: from, profile: { name } }],
            messages: [{ from, id, timestamp: '1791400000', type: 'text', text: { body: text } }],
          },
        },
      ],
    },
  ],
});

const statusUpdate = (id: string, status: string) => ({
  object: 'whatsapp_business_account',
  entry: [
    {
      changes: [
        {
          field: 'messages',
          value: {
            metadata: { phone_number_id: PHONE_ID },
            statuses: [{ id, status, timestamp: '1791400100', recipient_id: '919876543210' }],
          },
        },
      ],
    },
  ],
});

const node = (
  id: string,
  type: string,
  position: [number, number],
  parameters: Record<string, unknown> = {},
) => ({
  id,
  name: id,
  type,
  typeVersion: 1,
  position,
  parameters,
});

async function createActiveWorkflow(nodes: unknown[], connections: unknown[]) {
  const created = await app.inject({
    method: 'POST',
    url: '/api/workflows',
    headers: H(),
    payload: { name: 'WhatsApp flow', nodes, connections },
  });
  expect(created.statusCode).toBe(201);
  const id = created.json().id as string;
  const activated = await app.inject({
    method: 'PATCH',
    url: `/api/workflows/${id}`,
    headers: H(),
    payload: { active: true },
  });
  expect(activated.statusCode, activated.body).toBe(200);
  return id;
}

async function finishedExecutions(workflowId: string, count: number) {
  return eventually(async () => {
    const rows = await prisma.execution.findMany({
      where: { workflowId },
      orderBy: { createdAt: 'asc' },
    });
    return rows.length >= count && rows.every((r) => !['new', 'running'].includes(r.status))
      ? rows
      : null;
  });
}

async function executionDetail(id: string) {
  const res = await app.inject({ method: 'GET', url: `/api/executions/${id}`, headers: H() });
  return res.json() as {
    status: string;
    data: {
      resultData: {
        runData: Record<
          string,
          Array<{
            data?: { main: Array<Array<{ json: Record<string, any> }>> };
            error?: { message: string; description?: string };
          }>
        >;
      };
    };
  };
}

const graphMessages = () =>
  graphCalls
    .filter((c) => c.path.endsWith(`/${PHONE_ID}/messages`))
    .map((c) => JSON.parse(c.body) as Record<string, any>);

describe('platform setup (owner, once)', () => {
  it('generates a verify token, keeps the app secret on the server and reports readiness', async () => {
    const before = (
      await app.inject({ method: 'GET', url: '/api/whatsapp/platform', headers: H() })
    ).json();
    expect(before.embeddedSignupReady).toBe(false);
    expect(before.verifyToken).toMatch(/^[\w-]{20,}$/);
    expect(before.webhookUrl).toBe('http://localhost:5678/webhooks/whatsapp');

    await configurePlatform();
    const after = (
      await app.inject({ method: 'GET', url: '/api/whatsapp/platform', headers: H() })
    ).json();
    expect(after).toMatchObject({
      appId: '123456789',
      configId: '987654321',
      appSecretSet: true,
      embeddedSignupReady: true,
    });
    expect(JSON.stringify(after)).not.toContain(APP_SECRET);
    const stored = await prisma.setting.findUnique({ where: { key: 'whatsapp.platform' } });
    expect(JSON.stringify(stored?.value)).not.toContain(APP_SECRET);

    const bad = await app.inject({
      method: 'PUT',
      url: '/api/whatsapp/platform',
      headers: H(),
      payload: { appId: 'abc' },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('answers Meta’s webhook verification only with the right token', async () => {
    const { verifyToken } = (
      await app.inject({ method: 'GET', url: '/api/whatsapp/platform', headers: H() })
    ).json();
    const ok = await app.inject({
      method: 'GET',
      url: `/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${verifyToken}&hub.challenge=1158201444`,
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toBe('1158201444');
    const wrong = await app.inject({
      method: 'GET',
      url: '/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=guess&hub.challenge=1',
    });
    expect(wrong.statusCode).toBe(403);
    const checklist = (
      await app.inject({ method: 'GET', url: '/api/whatsapp/checklist', headers: H() })
    ).json();
    expect(checklist.steps.find((s: { id: string }) => s.id === 'webhook').status).toBe('done');
  });
});

describe('connecting a number', () => {
  it('Embedded Signup: exchanges the code on the server, subscribes and registers the number', async () => {
    const id = await connectCloudNumber();
    const account = (
      await app.inject({ method: 'GET', url: '/api/whatsapp/accounts', headers: H() })
    ).json().data[0];
    expect(account).toMatchObject({
      id,
      mode: 'cloud',
      connectedVia: 'embedded_signup',
      displayPhoneNumber: '+91 98000 11111',
      verifiedName: 'Asha Bakery',
      status: 'connected',
      webhookSubscribed: true,
    });
    // The browser never sees the token; the database only has it encrypted.
    expect(JSON.stringify(account)).not.toContain('EAAG');
    const row = await prisma.whatsAppAccount.findUniqueOrThrow({ where: { id } });
    expect(row.secrets).toMatch(/^v1:/);
    expect(row.secrets).not.toContain('EAAG');

    expect(graphCalls[0]!.path).toBe('/v23.0/oauth/access_token');
    expect(graphCalls[0]!.query.get('client_id')).toBe('123456789');
    const register = graphCalls.find((c) => c.path.endsWith('/register'))!;
    expect(JSON.parse(register.body)).toMatchObject({
      messaging_product: 'whatsapp',
      pin: expect.stringMatching(/^\d{6}$/),
    });
    expect(
      graphCalls.some((c) => c.path === `/v23.0/${WABA_ID}/subscribed_apps` && c.method === 'POST'),
    ).toBe(true);
  });

  it('explains a failed signup and refuses before the owner set up the Meta app', async () => {
    const early = await app.inject({
      method: 'POST',
      url: '/api/whatsapp/accounts/embedded-signup',
      headers: H(),
      payload: { code: 'good-code-from-meta', wabaId: WABA_ID, phoneNumberId: PHONE_ID },
    });
    expect(early.statusCode).toBe(400);
    expect(early.json().message).toContain('owner needs to add the Meta app');

    await configurePlatform();
    const bad = await app.inject({
      method: 'POST',
      url: '/api/whatsapp/accounts/embedded-signup',
      headers: H(),
      payload: { code: 'expired-code', wabaId: WABA_ID, phoneNumberId: PHONE_ID },
    });
    expect(bad.statusCode).toBe(502);
    expect(bad.json()).toMatchObject({
      error: 'WhatsAppError',
      message: expect.stringContaining('Invalid verification code'),
    });
    expect(await prisma.whatsAppAccount.count()).toBe(0);
  });

  it('manual connection with a permanent token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/whatsapp/accounts/manual',
      headers: H(),
      payload: {
        wabaId: WABA_ID,
        phoneNumberId: PHONE_ID,
        accessToken: 'EAAG-business-token-0001',
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ connectedVia: 'manual', status: 'connected' });
    expect(graphCalls.some((c) => c.path.endsWith('/register'))).toBe(false);
  });
});

describe('receiving and replying', () => {
  it('rejects webhooks without a valid signature', async () => {
    await connectCloudNumber();
    const unsigned = await app.inject({
      method: 'POST',
      url: '/webhooks/whatsapp',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(inboundText('wamid.X1', 'hi')),
    });
    expect(unsigned.statusCode).toBe(401);
    expect((await deliverWebhook(inboundText('wamid.X1', 'hi'), 'wrong-secret')).statusCode).toBe(
      401,
    );
    expect(await prisma.whatsAppMessage.count()).toBe(0);
  });

  it('a message starts the workflow, which replies with the WhatsApp node - once per message', async () => {
    const accountId = await connectCloudNumber();
    const workflowId = await createActiveWorkflow(
      [
        node('WhatsApp Trigger', 'flowforge.whatsAppTrigger', [0, 0], {
          account: accountId,
          events: ['message'],
          messageTypes: ['text'],
        }),
        node('Reply', 'flowforge.whatsApp', [240, 0], {
          account: accountId,
          operation: 'sendText',
          to: '={{ $json.from }}',
          text: '=Hi {{ $json.contactName }}, you said: {{ $json.text }}',
          options: { replyTo: '={{ $json.messageId }}' },
        }),
      ],
      [{ source: 'WhatsApp Trigger', sourceOutput: 0, target: 'Reply', targetInput: 0 }],
    );

    const res = await deliverWebhook(inboundText('wamid.IN1', 'hello'));
    expect(res.statusCode).toBe(200);
    const [execution] = await finishedExecutions(workflowId, 1);
    expect(execution!.status).toBe('success');
    expect(graphMessages()).toEqual([
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: '919876543210',
        type: 'text',
        text: { body: 'Hi Asha, you said: hello', preview_url: false },
        context: { message_id: 'wamid.IN1' },
      },
    ]);

    const detail = await executionDetail(execution!.id);
    const triggerItem =
      detail.data.resultData.runData['WhatsApp Trigger']![0]!.data!.main[0]![0]!.json;
    expect(triggerItem).toMatchObject({
      event: 'message',
      from: '919876543210',
      contactName: 'Asha',
      type: 'text',
      text: 'hello',
    });
    expect(detail.data.resultData.runData.Reply![0]!.data!.main[0]![0]!.json).toMatchObject({
      messageId: expect.stringMatching(/^wamid\.TEST\d+$/),
      to: '919876543210',
      simulated: false,
    });

    // Meta retries deliveries: the same message must not run the workflow again.
    await deliverWebhook(inboundText('wamid.IN1', 'hello'));
    await new Promise((r) => setTimeout(r, 300));
    expect(await prisma.execution.count({ where: { workflowId } })).toBe(1);

    const log = await prisma.whatsAppMessage.findMany({ orderBy: { createdAt: 'asc' } });
    expect(log.map((m) => [m.direction, m.status, m.text])).toEqual([
      ['inbound', 'received', 'hello'],
      ['outbound', 'sent', 'Hi Asha, you said: hello'],
    ]);
  });

  it('delivery receipts update the log in order and can trigger workflows', async () => {
    const accountId = await connectCloudNumber();
    const workflowId = await createActiveWorkflow(
      [
        node('On status', 'flowforge.whatsAppTrigger', [0, 0], {
          account: '*',
          events: ['status'],
          messageTypes: ['text'],
        }),
      ],
      [],
    );
    const { messageId } = await app.whatsapp.send(accountId, '+91 98765 43210', {
      type: 'text',
      text: { body: 'Your order is ready' },
    });
    await deliverWebhook(statusUpdate(messageId, 'read'));
    await deliverWebhook(statusUpdate(messageId, 'delivered')); // late, out of order
    await finishedExecutions(workflowId, 2);
    const message = await prisma.whatsAppMessage.findUniqueOrThrow({
      where: { waMessageId: messageId },
    });
    expect(message.status).toBe('read');
    const executions = await prisma.execution.findMany({ where: { workflowId } });
    const statuses = await Promise.all(
      executions.map(
        async (e) =>
          (await executionDetail(e.id)).data.resultData.runData['On status']![0]!.data!.main[0]![0]!
            .json.status,
      ),
    );
    expect(statuses.sort()).toEqual(['delivered', 'read']);
  });

  it('never downgrades a status when receipts are processed at the same time', async () => {
    const accountId = await connectCloudNumber();
    for (let round = 0; round < 5; round++) {
      const { messageId } = await app.whatsapp.send(accountId, '919876543210', {
        type: 'text',
        text: { body: `Ping ${round}` },
      });
      await Promise.all([
        app.whatsapp.handleWebhook(statusUpdate(messageId, 'read')),
        app.whatsapp.handleWebhook(statusUpdate(messageId, 'delivered')),
        app.whatsapp.handleWebhook(statusUpdate(messageId, 'sent')),
      ]);
      const row = await prisma.whatsAppMessage.findUniqueOrThrow({
        where: { waMessageId: messageId },
      });
      expect(row.status).toBe('read');
    }
  });

  it('turns the 24-hour window error into a clear explanation', async () => {
    const accountId = await connectCloudNumber();
    const error = await app.whatsapp
      .send(accountId, '15550000000', { type: 'text', text: { body: 'Hi' } })
      .catch((e: unknown) => e);
    expect((error as Error).message).toContain('more than 24 hours');
    expect((error as { description?: string }).description).toContain('Send Template');
    const failed = await prisma.whatsAppMessage.findFirstOrThrow({ where: { status: 'failed' } });
    expect(failed.error).toMatchObject({ code: 131047 });
  });

  it('lists approved templates, uploads and downloads media', async () => {
    const accountId = await connectCloudNumber();
    const options = await app.inject({
      method: 'GET',
      url: `/api/node-options/whatsappTemplates?account=${accountId}`,
      headers: H(),
    });
    expect(options.json().data).toEqual([
      { name: 'order_shipped · en_US', value: 'order_shipped' },
    ]);

    const media = await app.whatsapp.downloadMedia(accountId, 'incoming-photo-1');
    expect(media.mimeType).toBe('image/jpeg');
    expect([...media.data.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);

    const uploaded = await app.whatsapp.uploadMedia(accountId, {
      data: Buffer.from('%PDF-1.4'),
      mimeType: 'application/pdf',
      fileName: 'menu.pdf',
    });
    expect(uploaded.id).toBe('uploaded-media-1');
    const upload = graphCalls.find((c) => c.path.endsWith('/media'))!;
    expect(upload.body).toContain('name="messaging_product"');
    expect(upload.body).toContain('filename="menu.pdf"');
  });

  it('refuses to activate a trigger for a number that is not connected', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/workflows',
      headers: H(),
      payload: {
        name: 'x',
        nodes: [
          node('T', 'flowforge.whatsAppTrigger', [0, 0], { account: 'gone', events: ['message'] }),
        ],
        connections: [],
      },
    });
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/workflows/${created.json().id}`,
      headers: H(),
      payload: { active: true },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain('not connected');
  });
});

describe('test numbers (simulator) - no Meta account or keys', () => {
  it('every test number gets its own phone number', async () => {
    const numbers = new Set<string>();
    for (let i = 0; i < 40; i++) {
      const sim = await app.inject({
        method: 'POST',
        url: '/api/whatsapp/accounts/simulator',
        headers: H(),
        payload: { name: `Test ${i}` },
      });
      expect(sim.statusCode).toBe(201);
      numbers.add(sim.json().displayPhoneNumber);
    }
    expect(numbers.size).toBe(40);
  });

  it('runs the whole conversation: message → buttons → tapped reply, with receipts', async () => {
    const sim = await app.inject({
      method: 'POST',
      url: '/api/whatsapp/accounts/simulator',
      headers: H(),
      payload: { name: 'Bakery test' },
    });
    expect(sim.statusCode).toBe(201);
    const accountId = sim.json().id as string;
    expect(sim.json()).toMatchObject({ mode: 'simulator', status: 'connected' });

    const textFlow = await createActiveWorkflow(
      [
        node('Incoming', 'flowforge.whatsAppTrigger', [0, 0], {
          account: accountId,
          events: ['message'],
          messageTypes: ['text'],
        }),
        node('Ask', 'flowforge.whatsApp', [240, 0], {
          account: accountId,
          operation: 'sendButtons',
          to: '={{ $json.from }}',
          bodyText: '=Hi {{ $json.contactName }}! Would you like to order?',
          buttons: {
            button: [
              { title: 'Yes please', id: 'yes' },
              { title: 'No thanks', id: 'no' },
            ],
          },
        }),
      ],
      [{ source: 'Incoming', sourceOutput: 0, target: 'Ask', targetInput: 0 }],
    );
    const replyFlow = await createActiveWorkflow(
      [
        node('Reply tapped', 'flowforge.whatsAppTrigger', [0, 0], {
          account: accountId,
          events: ['message'],
          messageTypes: ['interactive'],
        }),
      ],
      [],
    );

    const sent = await app.inject({
      method: 'POST',
      url: `/api/whatsapp/accounts/${accountId}/simulate`,
      headers: H(),
      payload: { from: '+91 98765 43210', name: 'Ravi', text: 'Hi' },
    });
    expect(sent.statusCode).toBe(200);
    const [run] = await finishedExecutions(textFlow, 1);
    expect(run!.status).toBe('success');

    const outbound = await eventually(() =>
      prisma.whatsAppMessage.findFirst({ where: { direction: 'outbound', status: 'read' } }),
    );
    expect(outbound.contact).toBe('919876543210');
    expect(outbound.payload).toMatchObject({
      type: 'interactive',
      interactive: { type: 'button', body: { text: 'Hi Ravi! Would you like to order?' } },
    });
    expect(graphCalls).toHaveLength(0); // nothing went to Meta

    await app.inject({
      method: 'POST',
      url: `/api/whatsapp/accounts/${accountId}/simulate`,
      headers: H(),
      payload: {
        from: '919876543210',
        name: 'Ravi',
        reply: { id: 'yes', title: 'Yes please', type: 'button' },
      },
    });
    const [tapped] = await finishedExecutions(replyFlow, 1);
    const item = (await executionDetail(tapped!.id)).data.resultData.runData['Reply tapped']![0]!
      .data!.main[0]![0]!.json;
    expect(item).toMatchObject({
      type: 'interactive',
      text: 'Yes please',
      reply: { type: 'button', id: 'yes', title: 'Yes please' },
    });
    // The text-only workflow ignored the button reply.
    expect(await prisma.execution.count({ where: { workflowId: textFlow } })).toBe(1);

    const conversations = (
      await app.inject({
        method: 'GET',
        url: `/api/whatsapp/accounts/${accountId}/conversations`,
        headers: H(),
      })
    ).json().data;
    expect(conversations).toEqual([
      expect.objectContaining({ contact: '919876543210', contactName: 'Ravi', count: 3 }),
    ]);
    const templates = (
      await app.inject({
        method: 'GET',
        url: `/api/node-options/whatsappTemplates?account=${accountId}`,
        headers: H(),
      })
    ).json().data;
    expect(templates.map((t: { value: string }) => t.value)).toContain('hello_world');
  });

  it('"Listen for test event" runs the editor’s workflow with the next message', async () => {
    const accountId = (
      await app.inject({
        method: 'POST',
        url: '/api/whatsapp/accounts/simulator',
        headers: H(),
        payload: {},
      })
    ).json().id;
    const created = await app.inject({
      method: 'POST',
      url: '/api/workflows',
      headers: H(),
      payload: {
        name: 'Draft',
        nodes: [
          node('T', 'flowforge.whatsAppTrigger', [0, 0], {
            account: accountId,
            events: ['message'],
          }),
        ],
        connections: [],
      },
    });
    const workflowId = created.json().id as string;
    const listen = await app.inject({
      method: 'POST',
      url: `/api/workflows/${workflowId}/webhook-test`,
      headers: H(),
      payload: { nodeId: 'T' },
    });
    expect(listen.json()).toMatchObject({ kind: 'event', source: 'whatsapp' });
    await app.inject({
      method: 'POST',
      url: `/api/whatsapp/accounts/${accountId}/simulate`,
      headers: H(),
      payload: { from: '447700900123', text: 'test' },
    });
    const [execution] = await finishedExecutions(workflowId, 1);
    expect(execution!.mode).toBe('manual');
    // One-shot: a second message does nothing (the workflow is not active).
    await app.inject({
      method: 'POST',
      url: `/api/whatsapp/accounts/${accountId}/simulate`,
      headers: H(),
      payload: { from: '447700900123', text: 'again' },
    });
    await new Promise((r) => setTimeout(r, 200));
    expect(await prisma.execution.count({ where: { workflowId } })).toBe(1);
  });

  it('the checklist reflects progress', async () => {
    const accountId = await connectCloudNumber();
    await createActiveWorkflow(
      [node('T', 'flowforge.whatsAppTrigger', [0, 0], { account: accountId, events: ['message'] })],
      [],
    );
    await deliverWebhook(inboundText('wamid.C1', 'hi'));
    await eventually(() => prisma.whatsAppMessage.count());
    await app.whatsapp.send(accountId, '919876543210', { type: 'text', text: { body: 'hello' } });
    const { steps } = (
      await app.inject({ method: 'GET', url: '/api/whatsapp/checklist', headers: H() })
    ).json();
    const status = Object.fromEntries(
      steps.map((s: { id: string; status: string }) => [s.id, s.status]),
    );
    expect(status).toEqual({
      platform: 'done',
      webhook: 'todo',
      number: 'done',
      receive: 'done',
      send: 'done',
      workflow: 'done',
      calls: 'todo',
      agent: 'todo',
    });
  });
});
