import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  CallMediaSession,
  encodeWav,
  parseWav,
  rms,
  tone,
  type MediaConfig,
} from '@flowforge/media';
import { chooseMode, defaultCallSettings, isOpen, type CallSettings } from '../src/calls/settings';
import { auth, createTestApp, eventually, prisma, resetDb, setupOwner } from './helpers';
import { startStunServer } from './stun';

/** Phase 4 - WhatsApp calls. Real WebRTC audio over localhost; a fake Graph API for Meta's side. */
const APP_SECRET = 'calls-app-secret-0123456789abcdef';
const PHONE_ID = '300300300';

let app: FastifyInstance;
let token: string;
let stun: Awaited<ReturnType<typeof startStunServer>>;
let media: MediaConfig;
let graph: Server;
let dataDir: string;
const graphCalls: Array<{ path: string; body: Record<string, any> }> = [];
const peers: CallMediaSession[] = [];

beforeAll(async () => {
  stun = await startStunServer();
  media = { iceServers: [{ urls: stun.url }], allowLoopback: true };
  graph = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const path = (req.url ?? '').replace(/^\/v23\.0/, '').split('?')[0]!;
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
      graphCalls.push({ path, body });
      res.writeHead(200, { 'content-type': 'application/json' });
      if (path === `/${PHONE_ID}` && req.method === 'GET') {
        return res.end(
          JSON.stringify({ display_phone_number: '+91 90000 22222', verified_name: 'Clinic' }),
        );
      }
      if (path === `/${PHONE_ID}/messages`)
        return res.end(JSON.stringify({ messages: [{ id: `wamid.M${graphCalls.length}` }] }));
      res.end(JSON.stringify({ success: true }));
    });
  });
  await new Promise<void>((r) => graph.listen(0, '127.0.0.1', r));
  dataDir = mkdtempSync(join(tmpdir(), 'ff-calls-'));
  app = await createTestApp(
    {
      META_GRAPH_URL: `http://127.0.0.1:${(graph.address() as AddressInfo).port}`,
      DATA_DIR: dataDir,
    },
    { media },
  );
});

afterAll(async () => {
  await app.close();
  await Promise.all(peers.map((p) => p.close()));
  await new Promise<void>((r) => graph.close(() => r()));
  await stun.close();
  rmSync(dataDir, { recursive: true, force: true });
  await prisma.$disconnect();
});

beforeEach(async () => {
  await resetDb();
  app.whatsappPlatform.invalidate();
  graphCalls.length = 0;
  token = await setupOwner(app);
});

const H = () => auth(token);
const peer = () => {
  const p = new CallMediaSession(media);
  peers.push(p);
  return p;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function testNumber(settings: Partial<CallSettings>) {
  const account = (
    await app.inject({
      method: 'POST',
      url: '/api/whatsapp/accounts/simulator',
      headers: H(),
      payload: {},
    })
  ).json();
  const res = await app.inject({
    method: 'PUT',
    url: `/api/whatsapp/accounts/${account.id}/calling`,
    headers: H(),
    payload: { ...defaultCallSettings(), ...settings },
  });
  expect(res.statusCode, res.body).toBe(200);
  return account.id as string;
}

/** The browser (or phone) side of a call to a test number. */
async function callTestNumber(accountId: string) {
  const caller = peer();
  const offer = await caller.offer();
  const res = await app.inject({
    method: 'POST',
    url: `/api/whatsapp/accounts/${accountId}/simulate-call`,
    headers: H(),
    payload: { from: '+91 98765 43210', name: 'Ravi', sdp: offer },
  });
  expect(res.statusCode, res.body).toBe(200);
  const result = res.json() as { waCallId: string; sdp?: string; rejected?: boolean };
  if (result.sdp) {
    await caller.acceptAnswer(result.sdp);
    await caller.connected();
  }
  return { caller, ...result };
}

const latestCall = () => prisma.call.findFirstOrThrow({ orderBy: { startedAt: 'desc' } });

describe('call settings', () => {
  it('business hours pick the mode, including overnight hours and other timezones', () => {
    const settings = defaultCallSettings('Asia/Kolkata');
    settings.businessHours.enabled = true;
    settings.mode = 'app';
    settings.businessHours.outsideMode = 'ai';
    // Wednesday 2026-10-07 10:00 IST = 04:30 UTC (open), 21:00 IST = 15:30 UTC (closed)
    expect(chooseMode(settings, new Date('2026-10-07T04:30:00Z'))).toBe('app');
    expect(chooseMode(settings, new Date('2026-10-07T15:30:00Z'))).toBe('ai');
    // Sunday is closed by default
    expect(isOpen(settings, new Date('2026-10-11T06:00:00Z'))).toBe(false);
    settings.businessHours.days = [{ day: 5, open: '20:00', close: '02:00' }];
    expect(isOpen(settings, new Date('2026-10-09T16:00:00Z'))).toBe(true); // Fri 21:30 IST
    expect(isOpen(settings, new Date('2026-10-09T20:00:00Z'))).toBe(true); // Sat 01:30 IST
    expect(isOpen(settings, new Date('2026-10-10T00:00:00Z'))).toBe(false); // Sat 05:30 IST
  });

  it('validates and stores settings per number', async () => {
    const accountId = await testNumber({ mode: 'voicemail', ringSeconds: 12 });
    const stored = (
      await app.inject({
        method: 'GET',
        url: `/api/whatsapp/accounts/${accountId}/calling`,
        headers: H(),
      })
    ).json();
    expect(stored.settings).toMatchObject({ mode: 'voicemail', ringSeconds: 12 });
    expect(stored.aiAvailable).toBe(false);
    const bad = await app.inject({
      method: 'PUT',
      url: `/api/whatsapp/accounts/${accountId}/calling`,
      headers: H(),
      payload: { ...defaultCallSettings(), ringSeconds: 999 },
    });
    expect(bad.statusCode).toBe(400);
    const enabled = await app.inject({
      method: 'POST',
      url: `/api/whatsapp/accounts/${accountId}/calling/enable`,
      headers: H(),
    });
    expect(enabled.json().callingEnabled).toBe(true);
  });
});

describe('calls to a test number', () => {
  it('voicemail: answers, plays the greeting and beep, records the caller and starts workflows', async () => {
    const accountId = await testNumber({ mode: 'voicemail' });
    const greeting = encodeWav([tone(300, 400, 0.4, 16_000)], 16_000);
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: `/api/whatsapp/accounts/${accountId}/calling/greeting`,
          headers: H(),
          payload: { base64: greeting.toString('base64') },
        })
      ).statusCode,
    ).toBe(204);
    const workflow = await app.inject({
      method: 'POST',
      url: '/api/workflows',
      headers: H(),
      payload: {
        name: 'Voicemail follow-up',
        nodes: [
          {
            id: 'T',
            name: 'T',
            type: 'flowforge.whatsAppTrigger',
            typeVersion: 1,
            position: [0, 0],
            parameters: { account: accountId, events: ['call_ended'] },
          },
        ],
        connections: [],
      },
    });
    const workflowId = workflow.json().id as string;
    await app.inject({
      method: 'PATCH',
      url: `/api/workflows/${workflowId}`,
      headers: H(),
      payload: { active: true },
    });

    const { caller, waCallId, sdp } = await callTestNumber(accountId);
    expect(sdp).toContain('a=fingerprint');
    const heard: number[] = [];
    caller.onAudio((frame) => heard.push(rms(frame)));
    await eventually(async () => (await latestCall()).status === 'answered');
    await sleep(1200); // greeting + beep
    expect(Math.max(...heard)).toBeGreaterThan(0.05);
    await caller.play(tone(520, 800, 0.4)); // the caller leaves a message
    await app.inject({
      method: 'POST',
      url: `/api/whatsapp/accounts/${accountId}/simulate-call/${waCallId}/hangup`,
      headers: H(),
    });

    const call = await eventually(async () => {
      const row = await latestCall();
      return row.status === 'ended' ? row : null;
    });
    expect(call).toMatchObject({
      handledBy: 'voicemail',
      contact: '919876543210',
      contactName: 'Ravi',
      endReason: 'Caller hung up',
    });
    expect(call.durationSeconds).toBeGreaterThanOrEqual(1);
    const recording = await app.inject({
      method: 'GET',
      url: `/api/calls/${call.id}/recording`,
      headers: H(),
    });
    expect(recording.headers['content-type']).toBe('audio/wav');
    const wav = parseWav(recording.rawPayload);
    expect(wav.channels).toBe(2);
    expect(wav.samples.length / wav.sampleRate).toBeGreaterThan(1);

    const [execution] = await eventually(async () => {
      const rows = await prisma.execution.findMany({ where: { workflowId } });
      return rows.length && rows.every((r) => r.status === 'success') ? rows : null;
    });
    const detail = (
      await app.inject({ method: 'GET', url: `/api/executions/${execution!.id}`, headers: H() })
    ).json();
    expect(detail.data.resultData.runData.T[0].data.main[0][0].json).toMatchObject({
      event: 'call_ended',
      callId: call.id,
      from: '919876543210',
      status: 'ended',
      hasRecording: true,
    });
    const log = (
      await app.inject({ method: 'GET', url: `/api/calls?accountId=${accountId}`, headers: H() })
    ).json().data;
    expect(log).toEqual([
      expect.objectContaining({ id: call.id, status: 'ended', hasRecording: true }),
    ]);
  }, 30_000);

  it('reject: declines the call and sends the missed-call message', async () => {
    const accountId = await testNumber({
      mode: 'reject',
      rejectMessage: 'Busy - we will call you back!',
    });
    const { rejected } = await callTestNumber(accountId);
    expect(rejected).toBe(true);
    const call = await eventually(async () => {
      const row = await latestCall();
      return row.status === 'rejected' ? row : null;
    });
    expect(call.handledBy).toBe('rejected');
    const message = await eventually(() =>
      prisma.whatsAppMessage.findFirst({ where: { direction: 'outbound' } }),
    );
    expect(message).toMatchObject({
      contact: '919876543210',
      text: 'Busy - we will call you back!',
    });
  }, 20_000);

  it('app: a person answers in the app and both sides hear each other; hang up from the app', async () => {
    const accountId = await testNumber({ mode: 'app', ringSeconds: 30 });
    const { caller, waCallId } = await callTestNumber(accountId);
    const ringing = await eventually(
      async () =>
        (await app.inject({ method: 'GET', url: '/api/calls/active', headers: H() })).json()
          .data[0],
    );
    expect(ringing).toMatchObject({ status: 'ringing', ringing: true, ringSeconds: 30 });

    const person = peer();
    const answer = await app.inject({
      method: 'POST',
      url: `/api/calls/${ringing.id}/answer`,
      headers: H(),
      payload: { sdp: await person.offer() },
    });
    expect(answer.statusCode, answer.body).toBe(200);
    await person.acceptAnswer(answer.json().sdp);
    await person.connected();
    await eventually(async () => (await latestCall()).status === 'answered');

    const personHeard: number[] = [];
    const callerHeard: number[] = [];
    person.onAudio((f) => personHeard.push(rms(f)));
    caller.onAudio((f) => callerHeard.push(rms(f)));
    await caller.play(tone(440, 500, 0.4));
    await person.play(tone(660, 500, 0.4));
    await sleep(300);
    expect(Math.max(...personHeard)).toBeGreaterThan(0.05);
    expect(Math.max(...callerHeard)).toBeGreaterThan(0.05);

    const second = await app.inject({
      method: 'POST',
      url: `/api/calls/${ringing.id}/answer`,
      headers: H(),
      payload: { sdp: await peer().offer() },
    });
    expect(second.statusCode).toBe(409);

    expect(
      (await app.inject({ method: 'POST', url: `/api/calls/${ringing.id}/hangup`, headers: H() }))
        .statusCode,
    ).toBe(204);
    const call = await latestCall();
    expect(call).toMatchObject({
      status: 'ended',
      handledBy: 'person',
      endReason: 'Ended by the business',
      waCallId,
    });
    expect(call.answeredById).toBeTruthy();
  }, 30_000);

  it('app: when nobody answers in time the fallback takes over', async () => {
    const accountId = await testNumber({
      mode: 'app',
      ringSeconds: 5,
      fallback: 'reject',
      rejectMessage: 'Missed you!',
    });
    await callTestNumber(accountId);
    const call = await eventually(async () => {
      const row = await latestCall();
      return row.status === 'missed' ? row : null;
    }, 10_000);
    expect(call.endReason).toBe('Declined by settings');
    await eventually(() => prisma.whatsAppMessage.findFirst({ where: { text: 'Missed you!' } }));
  }, 20_000);
});

describe('calls from WhatsApp (Cloud API)', () => {
  it('answers a "connect" webhook with pre_accept + accept carrying our SDP, and ends on "terminate"', async () => {
    await app.inject({
      method: 'PUT',
      url: '/api/whatsapp/platform',
      headers: H(),
      payload: { appId: '123456789', appSecret: APP_SECRET, configId: '987654321' },
    });
    const account = (
      await app.inject({
        method: 'POST',
        url: '/api/whatsapp/accounts/manual',
        headers: H(),
        payload: {
          wabaId: '400400400',
          phoneNumberId: PHONE_ID,
          accessToken: 'EAAG-calls-token-000000001',
        },
      })
    ).json();
    await app.inject({
      method: 'PUT',
      url: `/api/whatsapp/accounts/${account.id}/calling`,
      headers: H(),
      payload: { ...defaultCallSettings(), mode: 'voicemail' },
    });
    await app.inject({
      method: 'POST',
      url: `/api/whatsapp/accounts/${account.id}/calling/enable`,
      headers: H(),
    });
    expect(graphCalls.find((c) => c.path === `/${PHONE_ID}/settings`)?.body).toMatchObject({
      calling: { status: 'ENABLED' },
    });

    const meta = peer(); // plays WhatsApp's media server
    const deliver = async (call: Record<string, unknown>) => {
      const raw = JSON.stringify({
        object: 'whatsapp_business_account',
        entry: [
          {
            id: '400400400',
            changes: [
              {
                field: 'calls',
                value: {
                  messaging_product: 'whatsapp',
                  metadata: { phone_number_id: PHONE_ID, display_phone_number: '919000022222' },
                  contacts: [{ wa_id: '447700900123', profile: { name: 'Sam' } }],
                  calls: [
                    {
                      id: 'wacid.REAL1',
                      from: '447700900123',
                      to: '919000022222',
                      timestamp: '1791500000',
                      direction: 'USER_INITIATED',
                      ...call,
                    },
                  ],
                },
              },
            ],
          },
        ],
      });
      const res = await app.inject({
        method: 'POST',
        url: '/webhooks/whatsapp',
        headers: {
          'content-type': 'application/json',
          'x-hub-signature-256': `sha256=${createHmac('sha256', APP_SECRET).update(raw).digest('hex')}`,
        },
        payload: raw,
      });
      expect(res.statusCode).toBe(200);
    };

    await deliver({ event: 'connect', session: { sdp_type: 'offer', sdp: await meta.offer() } });
    const preAccept = await eventually(async () =>
      graphCalls.find((c) => c.path === `/${PHONE_ID}/calls` && c.body.action === 'pre_accept'),
    );
    expect(preAccept.body).toMatchObject({
      messaging_product: 'whatsapp',
      call_id: 'wacid.REAL1',
      session: { sdp_type: 'answer', sdp: expect.stringContaining('a=fingerprint') },
    });
    await meta.acceptAnswer(preAccept.body.session.sdp);
    await meta.connected();
    const accept = await eventually(async () => graphCalls.find((c) => c.body.action === 'accept'));
    expect(accept.body.call_id).toBe('wacid.REAL1');

    await deliver({ event: 'terminate', status: 'COMPLETED' });
    const call = await eventually(async () => {
      const row = await latestCall();
      return row.status === 'ended' ? row : null;
    });
    expect(call).toMatchObject({
      waCallId: 'wacid.REAL1',
      contact: '447700900123',
      contactName: 'Sam',
      handledBy: 'voicemail',
    });
  }, 30_000);
});
