import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CallMediaSession, rms, tone, type MediaConfig } from '@flowforge/media';
import { startFakeAi } from './fakeAi';
import { auth, createTestApp, eventually, prisma, resetDb, setupOwner } from './helpers';
import { startStunServer } from './stun';

/** Phase 6 - outbound calls: call permission, the AI agent or a person calls the customer. */
let app: FastifyInstance;
let token: string;
let fake: Awaited<ReturnType<typeof startFakeAi>>;
let stun: Awaited<ReturnType<typeof startStunServer>>;
let media: MediaConfig;
let dataDir: string;
const peers: CallMediaSession[] = [];
/** Push events the simulator's "customer phone" would receive. */
const pushed: Array<{ type: string; data: any }> = [];

beforeAll(async () => {
  stun = await startStunServer();
  media = { iceServers: [{ urls: stun.url }], allowLoopback: true };
  fake = await startFakeAi();
  dataDir = mkdtempSync(join(tmpdir(), 'ff-outbound-'));
  app = await createTestApp({ ...fake.env, DATA_DIR: dataDir }, { media });
  const publish = app.push.publish.bind(app.push);
  app.push.publish = (topics, event) => {
    pushed.push(event as { type: string; data: unknown });
    publish(topics, event);
  };
});

afterAll(async () => {
  await app.close();
  await Promise.all(peers.map((p) => p.close()));
  await fake.close();
  await stun.close();
  rmSync(dataDir, { recursive: true, force: true });
  await prisma.$disconnect();
});

beforeEach(async () => {
  await resetDb();
  app.aiProviders.invalidate();
  pushed.length = 0;
  fake.requests.length = 0;
  fake.spoken.length = 0;
  token = await setupOwner(app);
});

const H = () => auth(token);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const CUSTOMER = '919876543210';
const peer = () => {
  const p = new CallMediaSession(media);
  peers.push(p);
  return p;
};
const latestCall = () => prisma.call.findFirstOrThrow({ orderBy: { startedAt: 'desc' } });

async function setup() {
  await app.inject({
    method: 'PUT',
    url: '/api/ai/providers',
    headers: H(),
    payload: { openai: 'sk-openai-key-9876', anthropic: 'sk-ant-test-key-1234' },
  });
  const agent = (
    await app.inject({
      method: 'POST',
      url: '/api/agents',
      headers: H(),
      payload: {
        name: 'Reminders',
        engine: 'pipeline',
        instructions: 'You call customers of Shine Salon.',
      },
    })
  ).json();
  const account = (
    await app.inject({
      method: 'POST',
      url: '/api/whatsapp/accounts/simulator',
      headers: H(),
      payload: {},
    })
  ).json();
  // The customer has chatted before (their name is known).
  await app.inject({
    method: 'POST',
    url: `/api/whatsapp/accounts/${account.id}/simulate`,
    headers: H(),
    payload: { from: CUSTOMER, name: 'Ravi', text: 'Hi, I booked for tomorrow' },
  });
  return { agentId: agent.id as string, accountId: account.id as string };
}

async function allowCalls(accountId: string) {
  const request = await app.inject({
    method: 'POST',
    url: `/api/whatsapp/accounts/${accountId}/call-permission`,
    headers: H(),
    payload: { to: `+${CUSTOMER}`, text: 'May we call you about your booking?' },
  });
  expect(request.statusCode, request.body).toBe(200);
  await app.inject({
    method: 'POST',
    url: `/api/whatsapp/accounts/${accountId}/simulate`,
    headers: H(),
    payload: { from: CUSTOMER, name: 'Ravi', callPermission: 'accept' },
  });
}

/** The customer's phone picks up the business's call. */
async function pickUp(accountId: string) {
  const ring = await eventually(
    () => pushed.find((e) => e.type === 'simulatedOutboundCall') ?? null,
  );
  const customer = peer();
  const answer = await customer.answer(ring.data.sdp);
  const res = await app.inject({
    method: 'POST',
    url: `/api/whatsapp/accounts/${accountId}/simulate-call/${ring.data.waCallId}/answer`,
    headers: H(),
    payload: { sdp: answer },
  });
  expect(res.statusCode, res.body).toBe(204);
  await customer.connected();
  return { customer, waCallId: ring.data.waCallId as string };
}

describe('call permission', () => {
  it('is required, requested with a WhatsApp message, and granted by the customer', async () => {
    const { accountId } = await setup();
    const early = await app.inject({
      method: 'POST',
      url: '/api/calls/outbound',
      headers: H(),
      payload: { accountId, to: CUSTOMER, purpose: 'Reminder' },
    });
    expect(early.statusCode).toBe(409);
    expect(early.json()).toMatchObject({ error: 'CallPermissionRequired' });

    const request = await app.inject({
      method: 'POST',
      url: `/api/whatsapp/accounts/${accountId}/call-permission`,
      headers: H(),
      payload: { to: CUSTOMER },
    });
    expect(request.json().alreadyGranted).toBe(false);
    const sent = await prisma.whatsAppMessage.findFirstOrThrow({
      where: { direction: 'outbound', type: 'interactive' },
    });
    expect(sent.payload).toMatchObject({
      interactive: { type: 'call_permission_request', action: { name: 'call_permission_request' } },
    });
    const pending = await app.inject({
      method: 'GET',
      url: `/api/whatsapp/accounts/${accountId}/call-permission?to=${CUSTOMER}`,
      headers: H(),
    });
    expect(pending.json().status).toBe('requested');

    await app.inject({
      method: 'POST',
      url: `/api/whatsapp/accounts/${accountId}/simulate`,
      headers: H(),
      payload: { from: CUSTOMER, name: 'Ravi', callPermission: 'accept' },
    });
    const granted = (
      await app.inject({
        method: 'GET',
        url: `/api/whatsapp/accounts/${accountId}/call-permission?to=${CUSTOMER}`,
        headers: H(),
      })
    ).json();
    expect(granted.status).toBe('granted');
    expect(new Date(granted.expiresAt).getTime()).toBeGreaterThan(Date.now() + 6 * 86_400_000);
    expect(pushed).toContainEqual({
      type: 'callPermission',
      data: { accountId, contact: CUSTOMER, status: 'granted' },
    });
    const reply = await prisma.whatsAppMessage.findFirstOrThrow({
      where: { direction: 'inbound', type: 'interactive' },
    });
    expect(reply.text).toBe('Allowed calls');

    // Expired permission counts as none.
    await prisma.callPermission.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    const expired = (
      await app.inject({
        method: 'GET',
        url: `/api/whatsapp/accounts/${accountId}/call-permission?to=${CUSTOMER}`,
        headers: H(),
      })
    ).json();
    expect(expired.status).toBe('expired');
  });
});

describe('outbound calls', () => {
  it('the AI agent calls with a purpose, speaks first, and the call is logged', async () => {
    const { accountId, agentId } = await setup();
    await allowCalls(accountId);
    const res = await app.inject({
      method: 'POST',
      url: '/api/calls/outbound',
      headers: H(),
      payload: {
        accountId,
        to: CUSTOMER,
        agentId,
        purpose: 'Remind Ravi of the haircut tomorrow at 5 pm',
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    expect((await latestCall()).status).toBe('ringing');

    const { customer } = await pickUp(accountId);
    const heard: number[] = [];
    customer.onAudio((f) => heard.push(rms(f)));
    await eventually(() => fake.spoken.length > 0 || null, 8000);
    await eventually(() => heard.filter((l) => l > 0.05).length > 10 || null, 8000);

    // The agent knew why it called, and who.
    const first = fake.requests.find((r) => r.path === '/v1/messages')!;
    expect(first.body.system).toContain('Remind Ravi of the haircut tomorrow at 5 pm');
    expect(first.body.system).toContain('You called the customer');
    expect(first.body.system).toContain('Name on WhatsApp: Ravi');
    expect(first.body.messages[0].content.at(-1).text).toContain('just picked up');

    await sleep(1500);
    await customer.play(tone(1000, 900, 0.3)); // "Thanks, bye."
    const ended = await eventually(async () => {
      const row = await latestCall();
      return row.status === 'ended' ? row : null;
    }, 15_000);
    expect(ended).toMatchObject({
      direction: 'outbound',
      handledBy: 'ai',
      agentId,
      contactName: 'Ravi',
      endReason: 'The agent ended the call',
      metadata: { purpose: 'Remind Ravi of the haircut tomorrow at 5 pm', handler: 'agent' },
    });
    const transcript = ended.transcript as Array<{ role: string; text: string }>;
    expect(transcript[0]!.role).toBe('agent');
    expect(transcript).toContainEqual(
      expect.objectContaining({ role: 'caller', text: 'Thanks, bye.' }),
    );
  }, 40_000);

  it('a person calls from the app; the customer hears them', async () => {
    const { accountId } = await setup();
    await allowCalls(accountId);
    const me = peer();
    const res = await app.inject({
      method: 'POST',
      url: '/api/calls/outbound',
      headers: H(),
      payload: { accountId, to: CUSTOMER, handler: 'person', sdp: await me.offer() },
    });
    expect(res.statusCode, res.body).toBe(201);
    await me.acceptAnswer(res.json().sdp);
    const { customer } = await pickUp(accountId);
    await eventually(async () => (await latestCall()).status === 'answered');
    const customerHeard: number[] = [];
    customer.onAudio((f) => customerHeard.push(rms(f)));
    await me.play(tone(600, 600, 0.3));
    await sleep(900);
    expect(Math.max(...customerHeard)).toBeGreaterThan(0.05);
    expect((await latestCall()).handledBy).toBe('person');
    await app.inject({
      method: 'POST',
      url: `/api/calls/${res.json().callId}/hangup`,
      headers: H(),
    });
    await eventually(async () => (await latestCall()).status === 'ended');
  });

  it('the customer declines', async () => {
    const { accountId } = await setup();
    await allowCalls(accountId);
    await app.inject({
      method: 'POST',
      url: '/api/calls/outbound',
      headers: H(),
      payload: { accountId, to: CUSTOMER, purpose: 'Follow-up' },
    });
    const ring = await eventually(
      () => pushed.find((e) => e.type === 'simulatedOutboundCall') ?? null,
    );
    await app.inject({
      method: 'POST',
      url: `/api/whatsapp/accounts/${accountId}/simulate-call/${ring.data.waCallId}/decline`,
      headers: H(),
    });
    const row = await eventually(async () => {
      const c = await latestCall();
      return c.status === 'rejected' ? c : null;
    });
    expect(row.endReason).toBe('Declined by the customer');
  });

  it('a workflow asks for permission and then has the agent call', async () => {
    const { accountId } = await setup();
    const node = (name: string, operation: string, extra: Record<string, unknown>) => ({
      id: name,
      name,
      type: 'flowforge.whatsApp',
      typeVersion: 1,
      position: [200, 0],
      parameters: { account: accountId, operation, to: CUSTOMER, ...extra },
    });
    const run = async (operation: string, extra: Record<string, unknown>) => {
      const wf = await app.inject({
        method: 'POST',
        url: '/api/workflows',
        headers: H(),
        payload: {
          name: operation,
          nodes: [
            {
              id: 'T',
              name: 'T',
              type: 'flowforge.manualTrigger',
              typeVersion: 1,
              position: [0, 0],
              parameters: {},
            },
            node('Call', operation, extra),
          ],
          connections: [{ source: 'T', sourceOutput: 0, target: 'Call', targetInput: 0 }],
        },
      });
      const started = await app.inject({
        method: 'POST',
        url: `/api/workflows/${wf.json().id}/run`,
        headers: H(),
        payload: {},
      });
      const result = await app.services.executions.waitFor(started.json().executionId);
      return result!;
    };

    const asked = await run('requestCallPermission', { permissionText: 'Can we call you?' });
    expect(asked.status).toBe('success');
    expect(asked.data.resultData.runData.Call![0]!.data!.main[0]![0]!.json).toMatchObject({
      status: 'requested',
    });

    const tooEarly = await run('callWithAgent', { purpose: 'Confirm the booking' });
    expect(tooEarly.status).toBe('error');
    expect(tooEarly.data.resultData.error?.message).toContain('not answered your call permission');

    await app.inject({
      method: 'POST',
      url: `/api/whatsapp/accounts/${accountId}/simulate`,
      headers: H(),
      payload: { from: CUSTOMER, name: 'Ravi', callPermission: 'accept' },
    });
    const calling = await run('callWithAgent', { purpose: 'Confirm the booking' });
    expect(calling.status).toBe('success');
    expect(calling.data.resultData.runData.Call![0]!.data!.main[0]![0]!.json).toMatchObject({
      status: 'calling',
    });
    await eventually(() => pushed.find((e) => e.type === 'simulatedOutboundCall') ?? null);
    const row = await latestCall();
    expect(row).toMatchObject({ direction: 'outbound', status: 'ringing' });
    await app.inject({ method: 'POST', url: `/api/calls/${row.id}/hangup`, headers: H() });
  });
});
