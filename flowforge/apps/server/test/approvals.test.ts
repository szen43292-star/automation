import { chmodSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { auth, createTestApp, manualTrigger, prisma, resetDb, settle, setupOwner } from './helpers';

/** "Ask for Approval" → Wait (webhook) → load the approved video: pages, answers, the tunnel rule. */
let app: FastifyInstance;
let token: string;
let files: Server;
let videoUrl: string;
const VIDEO = Buffer.from('0123456789abcdefghij-fake-mp4');
const dataDir = mkdtempSync(join(tmpdir(), 'approvals-'));

beforeAll(async () => {
  app = await createTestApp({ DATA_DIR: dataDir });
  files = createServer((_req, res) => {
    res.setHeader('content-type', 'video/mp4');
    res.end(VIDEO);
  });
  await new Promise<void>((resolve) => files.listen(0, '127.0.0.1', resolve));
  videoUrl = `http://127.0.0.1:${(files.address() as AddressInfo).port}/final-1.mp4`;
});
afterAll(async () => {
  await app.close();
  await new Promise<void>((resolve) => files.close(() => resolve()));
  await prisma.$disconnect();
});
beforeEach(async () => {
  await resetDb();
  token = await setupOwner(app);
});

const node = (name: string, type: string, parameters: Record<string, unknown> = {}) => ({
  id: name,
  name,
  type,
  typeVersion: 1,
  position: [0, 0] as [number, number],
  parameters,
});
const chain = (...names: string[]) =>
  names
    .slice(1)
    .map((target, i) => ({ source: names[i]!, sourceOutput: 0, target, targetInput: 0 }));

interface Detail {
  status: string;
  data: {
    waitingNode?: string;
    resultData: {
      runData: Record<
        string,
        Array<{ data: { main: Array<Array<{ json: Record<string, unknown>; binary?: unknown }>> } }>
      >;
    };
  };
}
const output = (detail: Detail, name: string) => {
  const runs = detail.data.resultData.runData[name];
  return runs?.[runs.length - 1]?.data.main[0];
};
const execution = async (id: string): Promise<Detail> =>
  (await app.inject({ url: `/api/executions/${id}`, headers: auth(token) })).json();

/** Runs Download → Ask for Approval → Wait → Load Video → After, up to the wait. */
async function startApprovalRun(target = app, t = token) {
  const created = await target.inject({
    method: 'POST',
    url: '/api/workflows',
    headers: auth(t),
    payload: {
      name: 'Approve video',
      nodes: [
        manualTrigger,
        node('Download', 'flowforge.httpRequest', {
          method: 'GET',
          url: videoUrl,
          options: { responseFormat: 'binary' },
        }),
        node('Ask', 'flowforge.approval', {
          operation: 'request',
          title: 'The Lamp That Remembered',
          description: 'A lamp with a memory.',
          binaryPropertyName: 'data',
          expiresAfterHours: 24,
        }),
        node('Wait', 'flowforge.wait', { resume: 'webhook', limitWaitTime: true, limitHours: 24 }),
        node('Load', 'flowforge.approval', {
          operation: 'media',
          approvalId: "={{ $('Ask').first().json.approval_id }}",
        }),
        node('After', 'flowforge.set', {
          mode: 'manual',
          assignments: {
            assignments: [
              {
                id: '1',
                name: 'approved',
                value: "={{ $('Wait').first().json.approved }}",
                type: 'boolean',
              },
              {
                id: '2',
                name: 'bytes',
                value: '={{ $binary.data?.fileSize ?? 0 }}',
                type: 'number',
              },
            ],
          },
        }),
      ],
      connections: chain('trigger', 'Download', 'Ask', 'Wait', 'Load', 'After'),
    },
  });
  expect(created.statusCode, created.body).toBe(201);
  const run = await target.inject({
    method: 'POST',
    url: `/api/workflows/${created.json().id}/run`,
    headers: auth(t),
    payload: {},
  });
  expect(run.statusCode, run.body).toBe(202);
  const { executionId } = run.json();
  await settle(target, executionId);
  const detail = (
    await target.inject({ url: `/api/executions/${executionId}`, headers: auth(t) })
  ).json() as Detail;
  expect(detail.status).toBe('waiting');
  expect(detail.data.waitingNode).toBe('Wait');
  const ask = output(detail, 'Ask')![0]!.json as {
    approval_id: string;
    approval_url: string;
    local_url: string;
  };
  return { executionId, ask };
}

describe('approvals', () => {
  it('shows the video on a phone page and continues the workflow when approved', async () => {
    const { executionId, ask } = await startApprovalRun();
    expect(ask.approval_id).toMatch(/^[\w-]{32}$/);
    // No tunnel in this server: the link is the local one.
    expect(ask.approval_url).toBe(`http://localhost:5678/approve/${ask.approval_id}`);

    const page = await app.inject({ url: `/approve/${ask.approval_id}` });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.body).toContain('The Lamp That Remembered');
    expect(page.body).toContain(`<video src="${ask.approval_id}/media"`);
    expect(page.body).toContain('data-decision="approve"');

    // The video streams, with ranges (phones seek this way).
    const full = await app.inject({ url: `/approve/${ask.approval_id}/media` });
    expect(full.statusCode).toBe(200);
    expect(full.headers['content-type']).toBe('video/mp4');
    expect(full.rawPayload.equals(VIDEO)).toBe(true);
    const part = await app.inject({
      url: `/approve/${ask.approval_id}/media`,
      headers: { range: 'bytes=0-3' },
    });
    expect(part.statusCode).toBe(206);
    expect(part.headers['content-range']).toBe(`bytes 0-3/${VIDEO.length}`);
    expect(part.body).toBe('0123');

    // The app's Approvals screen lists it.
    const list = await app.inject({ url: '/api/approvals', headers: auth(token) });
    expect(list.json().data).toEqual([
      expect.objectContaining({ id: ask.approval_id, status: 'pending', hasMedia: true }),
    ]);
    // Signing in is needed for the list, not for the page.
    expect((await app.inject({ url: '/api/approvals' })).statusCode).toBe(401);

    const answer = await app.inject({
      method: 'POST',
      url: `/approve/${ask.approval_id}`,
      payload: { decision: 'approve' },
    });
    expect(answer.statusCode, answer.body).toBe(200);
    expect(answer.json()).toMatchObject({ ok: true, status: 'approved' });
    await settle(app, executionId);
    const done = await execution(executionId);
    expect(done.status).toBe('success');
    expect(output(done, 'After')![0]!.json).toEqual({ approved: true, bytes: VIDEO.length });

    // Only the first answer counts.
    const again = await app.inject({
      method: 'POST',
      url: `/approve/${ask.approval_id}`,
      payload: { decision: 'reject' },
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().message).toContain('already approved');
    expect((await app.inject({ url: `/approve/${ask.approval_id}` })).body).toContain(
      'You approved this.',
    );
  });

  it('continues with approved: false when rejected, from the app', async () => {
    const { executionId, ask } = await startApprovalRun();
    const answer = await app.inject({
      method: 'POST',
      url: `/api/approvals/${ask.approval_id}/decision`,
      headers: auth(token),
      payload: { decision: 'reject' },
    });
    expect(answer.json()).toMatchObject({ ok: true, status: 'rejected' });
    await settle(app, executionId);
    const done = await execution(executionId);
    // "Load" fails on purpose here: a rejected video is deleted.
    expect(output(done, 'Wait')![0]!.json).toMatchObject({ approved: false, decision: 'rejected' });
    const row = await prisma.approval.findUnique({ where: { id: ask.approval_id } });
    expect(existsSync(join(dataDir, 'approvals', row!.mediaFile!))).toBe(false);
  });

  it('refuses answers after it expired and for unknown links', async () => {
    const { ask } = await startApprovalRun();
    await prisma.approval.update({
      where: { id: ask.approval_id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const late = await app.inject({
      method: 'POST',
      url: `/approve/${ask.approval_id}`,
      payload: { decision: 'approve' },
    });
    expect(late.statusCode).toBe(409);
    expect(late.json()).toMatchObject({ ok: false, status: 'expired' });
    expect((await app.inject({ url: `/approve/${ask.approval_id}` })).body).toContain(
      'This approval has expired',
    );
    expect((await app.inject({ url: '/approve/not-a-real-approval-id-0000' })).statusCode).toBe(
      404,
    );
  });
});

describe('remote access (quick tunnel)', () => {
  let tunneled: FastifyInstance;
  let tunnelToken: string;

  beforeAll(async () => {
    // Stands in for cloudflared: prints the tunnel address like it does, then keeps running.
    const fake = join(dataDir, 'fake-cloudflared.sh');
    writeFileSync(
      fake,
      '#!/bin/sh\necho "INF |  https://quiet-lamp-1234.trycloudflare.com  |" 1>&2\nexec sleep 300\n',
    );
    chmodSync(fake, 0o755);
    tunneled = await createTestApp({
      DATA_DIR: dataDir,
      REMOTE_ACCESS: 'tunnel',
      CLOUDFLARED_PATH: fake,
    });
  });
  afterAll(async () => {
    await tunneled.close();
  });
  beforeEach(async () => {
    await resetDb();
    tunnelToken = await setupOwner(tunneled);
  });

  it('puts the tunnel address in approval links', async () => {
    const { ask } = await startApprovalRun(tunneled, tunnelToken);
    expect(ask.approval_url).toBe(
      `https://quiet-lamp-1234.trycloudflare.com/approve/${ask.approval_id}`,
    );
    expect(ask.local_url).toBe(`http://localhost:5678/approve/${ask.approval_id}`);
  });

  it('only lets the approval pages through the tunnel', async () => {
    const { ask } = await startApprovalRun(tunneled, tunnelToken);
    const host = 'quiet-lamp-1234.trycloudflare.com';
    const blocked = await tunneled.inject({
      url: '/api/workflows',
      headers: { host, ...auth(tunnelToken) },
    });
    expect(blocked.statusCode).toBe(404);
    expect((await tunneled.inject({ url: '/', headers: { host } })).statusCode).toBe(404);
    expect(
      (await tunneled.inject({ method: 'POST', url: '/webhook/anything', headers: { host } }))
        .statusCode,
    ).toBe(404);
    expect(
      (await tunneled.inject({ url: `/approve/${ask.approval_id}`, headers: { host } })).statusCode,
    ).toBe(200);
    // Marked by Cloudflare but with this computer's host name: still only approvals.
    expect(
      (
        await tunneled.inject({
          url: '/api/workflows',
          headers: { 'cf-connecting-ip': '203.0.113.7', ...auth(tunnelToken) },
        })
      ).statusCode,
    ).toBe(404);
    // On this computer everything works as before.
    expect(
      (await tunneled.inject({ url: '/api/workflows', headers: auth(tunnelToken) })).statusCode,
    ).toBe(200);
  });
});
