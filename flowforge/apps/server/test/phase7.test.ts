import { createVerify, generateKeyPairSync } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { auth, createTestApp, eventually, prisma, resetDb, setupOwner } from './helpers';

/** Phase 7 - the phone apps: push notifications (Firebase Cloud Messaging) and app origins. */
let app: FastifyInstance;
let token: string;
let fcm: Server;
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const sent: Array<{ path: string; auth: string; body: any }> = [];
const dead = new Set<string>();

beforeAll(async () => {
  fcm = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString();
      if (req.url === '/token') {
        // Check the service account's signed JWT like Google does.
        const assertion = new URLSearchParams(raw).get('assertion') ?? '';
        const [header, claims, signature] = assertion.split('.');
        const valid = createVerify('RSA-SHA256')
          .update(`${header}.${claims}`)
          .verify(publicKey, Buffer.from(signature ?? '', 'base64url'));
        const payload = JSON.parse(Buffer.from(claims ?? '', 'base64url').toString());
        res.writeHead(valid ? 200 : 401, { 'content-type': 'application/json' });
        return res.end(
          JSON.stringify(
            valid && payload.scope.includes('firebase.messaging')
              ? { access_token: 'fcm-access-token', expires_in: 3600 }
              : { error: 'invalid_grant' },
          ),
        );
      }
      const body = JSON.parse(raw);
      sent.push({ path: req.url ?? '', auth: String(req.headers.authorization), body });
      if (dead.has(body.message.token)) {
        res.writeHead(404, { 'content-type': 'application/json' });
        return res.end(
          JSON.stringify({
            error: { status: 'NOT_FOUND', details: [{ errorCode: 'UNREGISTERED' }] },
          }),
        );
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ name: 'projects/flowforge-test/messages/1' }));
    });
  });
  await new Promise<void>((r) => fcm.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(fcm.address() as AddressInfo).port}`;
  const serviceAccount = {
    type: 'service_account',
    project_id: 'flowforge-test',
    client_email: 'push@flowforge-test.iam.gserviceaccount.com',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    token_uri: `${base}/token`,
  };
  app = await createTestApp({
    FCM_SERVICE_ACCOUNT: Buffer.from(JSON.stringify(serviceAccount)).toString('base64'),
    FCM_API_URL: base,
  });
});

afterAll(async () => {
  await app.close();
  await new Promise<void>((r) => fcm.close(() => r()));
  await prisma.$disconnect();
});

beforeEach(async () => {
  await resetDb();
  sent.length = 0;
  dead.clear();
  token = await setupOwner(app);
});

const register = (deviceToken: string, platform = 'android') =>
  app.inject({
    method: 'POST',
    url: '/api/devices',
    headers: auth(token),
    payload: { token: deviceToken, platform },
  });

describe('phone notifications', () => {
  it('phones register; incoming calls, missed calls and summaries notify them', async () => {
    expect(
      (
        await app.inject({ method: 'GET', url: '/api/devices/status', headers: auth(token) })
      ).json(),
    ).toEqual({ enabled: true });
    expect((await register('android-device-token-1')).json()).toEqual({
      registered: true,
      enabled: true,
    });
    expect((await register('ios-device-token-1', 'ios')).statusCode).toBe(200);
    expect((await register('android-device-token-1')).statusCode).toBe(200); // re-register is fine
    expect(await prisma.device.count()).toBe(2);

    app.push.publish(['whatsapp'], {
      type: 'incomingCall',
      data: {
        callId: 'c1',
        accountId: 'a1',
        accountNumber: '+91 90000 11111',
        from: '919876543210',
        contactName: 'Ravi',
        ringSeconds: 20,
      },
    });
    await eventually(() => sent.length === 2 || null);
    expect(sent[0]!.path).toBe('/v1/projects/flowforge-test/messages:send');
    expect(sent[0]!.auth).toBe('Bearer fcm-access-token');
    const android = sent.find((s) => s.body.message.token === 'android-device-token-1')!.body
      .message;
    expect(android).toMatchObject({
      notification: {
        title: 'Incoming WhatsApp call',
        body: 'Ravi is calling +91 90000 11111. Tap to answer.',
      },
      data: { url: '/calls', tag: 'call-c1' },
      android: { priority: 'high', notification: { channel_id: 'calls' } },
      apns: { headers: { 'apns-priority': '10' } },
    });

    // Live updates that are not worth a notification stay quiet.
    app.push.publish(['whatsapp'], {
      type: 'callTranscript',
      data: { callId: 'c1', role: 'caller', text: 'hi' },
    });
    app.push.publish(['whatsapp'], {
      type: 'callSummary',
      data: {
        callId: 'c1',
        summary: 'Ravi booked a haircut for Friday.',
        contact: '919876543210',
        contactName: 'Ravi',
      },
    });
    await eventually(() => sent.length === 4 || null);
    expect(sent[3]!.body.message.notification).toEqual({
      title: 'Call with Ravi',
      body: 'Ravi booked a haircut for Friday.',
    });
    expect(sent[3]!.body.message.android.priority).toBe('normal');

    // An uninstalled app's token is forgotten.
    dead.add('ios-device-token-1');
    app.push.publish(['whatsapp'], {
      type: 'callSummary',
      data: { callId: 'c2', summary: 'x', contact: '91', contactName: null },
    });
    await eventually(async () => (await prisma.device.count()) === 1 || null);

    const removed = await app.inject({
      method: 'DELETE',
      url: '/api/devices',
      headers: auth(token),
      payload: { token: 'android-device-token-1' },
    });
    expect(removed.statusCode).toBe(204);
    expect(await prisma.device.count()).toBe(0);
  });

  it('the Android app origin may call the API', async () => {
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/api/auth/status',
      headers: { origin: 'https://localhost', 'access-control-request-method': 'GET' },
    });
    expect(res.headers['access-control-allow-origin']).toBe('https://localhost');
    const ios = await app.inject({
      method: 'OPTIONS',
      url: '/api/auth/status',
      headers: { origin: 'capacitor://localhost', 'access-control-request-method': 'GET' },
    });
    expect(ios.headers['access-control-allow-origin']).toBe('capacitor://localhost');
    const other = await app.inject({
      method: 'OPTIONS',
      url: '/api/auth/status',
      headers: { origin: 'https://evil.example.com', 'access-control-request-method': 'GET' },
    });
    expect(other.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('tells the Windows app on the same PC how many calls are on, nobody else', async () => {
    const local = await app.inject({ method: 'GET', url: '/readyz' });
    expect(local.json()).toEqual({ status: 'ok', mode: 'regular', activeCalls: 0 });
    const remote = await app.inject({
      method: 'GET',
      url: '/readyz',
      remoteAddress: '203.0.113.9',
    });
    expect(remote.json()).toEqual({ status: 'ok', mode: 'regular' });
  });
});
