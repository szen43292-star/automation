import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RemoteAccess } from '../src/remote/RemoteAccess';
import { auth, createTestApp, manualTrigger, prisma, resetDb, settle, setupOwner } from './helpers';

/** "Run from your phone": the secret link, its page, starting runs and the tunnel rule. */
let app: FastifyInstance;
let token: string;
const dataDir = mkdtempSync(join(tmpdir(), 'phone-'));

beforeAll(async () => {
  app = await createTestApp({ DATA_DIR: dataDir });
});
afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});
beforeEach(async () => {
  await resetDb();
  token = await setupOwner(app);
});

async function createWorkflow(name: string) {
  const created = await app.inject({
    method: 'POST',
    url: '/api/workflows',
    headers: auth(token),
    payload: {
      name,
      nodes: [
        manualTrigger,
        {
          id: 'set',
          name: 'Set',
          type: 'flowforge.set',
          typeVersion: 1,
          position: [200, 0],
          parameters: {
            mode: 'manual',
            assignments: { assignments: [{ id: '1', name: 'ok', value: true, type: 'boolean' }] },
          },
        },
      ],
      connections: [{ source: 'trigger', sourceOutput: 0, target: 'set', targetInput: 0 }],
      // Pinned test data must not be used by phone runs.
      pinData: { Set: [{ json: { pinned: true } }] },
    },
  });
  expect(created.statusCode, created.body).toBe(201);
  return created.json().id as string;
}

const linkToken = (url: string) => url.split('/run/')[1]!;

describe('run from your phone', () => {
  it('is off until you pick workflows, then gives a secret link', async () => {
    const off = await app.inject({ url: '/api/phone', headers: auth(token) });
    expect(off.json()).toEqual({ enabled: false, url: null, localUrl: null, workflowIds: [] });
    expect((await app.inject({ url: '/api/phone' })).statusCode).toBe(401);

    const id = await createWorkflow('Daily Short');
    const on = await app.inject({
      method: 'PUT',
      url: '/api/phone',
      headers: auth(token),
      payload: { workflowIds: [id, 'not-a-workflow'] },
    });
    expect(on.statusCode, on.body).toBe(200);
    const info = on.json();
    expect(info.enabled).toBe(true);
    // No tunnel in tests: the link is the local one.
    expect(info.url).toMatch(/^http:\/\/localhost:5678\/run\/[\w-]{32}$/);
    expect(info.localUrl).toBe(info.url);
    expect(info.workflowIds).toEqual([id]);
  });

  it('lists the workflows and runs one from the phone page', async () => {
    const id = await createWorkflow('Daily Short');
    const other = await createWorkflow('Not on the phone');
    const info = (
      await app.inject({
        method: 'PUT',
        url: '/api/phone',
        headers: auth(token),
        payload: { workflowIds: [id] },
      })
    ).json();
    const secret = linkToken(info.url);

    const page = await app.inject({ url: `/run/${secret}` });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.body).toContain('Run your workflows from here');

    const before = (await app.inject({ url: `/run/${secret}/status` })).json();
    expect(before.workflows).toEqual([{ id, name: 'Daily Short', last: null }]);

    const run = await app.inject({ method: 'POST', url: `/run/${secret}/${id}` });
    expect(run.statusCode, run.body).toBe(202);
    expect(run.json()).toMatchObject({ ok: true, message: 'Started "Daily Short".' });
    const { executionId } = run.json();
    await settle(app, executionId);
    const done = (await app.inject({ url: `/run/${secret}/status` })).json();
    expect(done.workflows[0].last.status).toBe('success');
    const detail = (
      await app.inject({ url: `/api/executions/${executionId}`, headers: auth(token) })
    ).json();
    expect(detail.data.resultData.runData.Set[0].data.main[0][0].json).toEqual({ ok: true });

    // Only the workflows you picked.
    const refused = await app.inject({ method: 'POST', url: `/run/${secret}/${other}` });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().message).toBe('This workflow cannot be run from the phone.');
  });

  it('shows videos waiting for approval', async () => {
    const id = await createWorkflow('Daily Short');
    const info = (
      await app.inject({
        method: 'PUT',
        url: '/api/phone',
        headers: auth(token),
        payload: { workflowIds: [id] },
      })
    ).json();
    await prisma.approval.create({
      data: {
        id: 'approval-id-0123456789abcdef',
        executionId: 'some-execution',
        title: 'The Lamp That Remembered',
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });
    const status = (await app.inject({ url: `/run/${linkToken(info.url)}/status` })).json();
    expect(status.approvals).toEqual([
      { id: 'approval-id-0123456789abcdef', title: 'The Lamp That Remembered' },
    ]);
  });

  it('stops the old link after a reset and when switched off', async () => {
    const id = await createWorkflow('Daily Short');
    const first = (
      await app.inject({
        method: 'PUT',
        url: '/api/phone',
        headers: auth(token),
        payload: { workflowIds: [id] },
      })
    ).json();
    const reset = (
      await app.inject({ method: 'POST', url: '/api/phone/reset', headers: auth(token) })
    ).json();
    expect(reset.url).not.toBe(first.url);
    expect(reset.workflowIds).toEqual([id]);
    expect((await app.inject({ url: `/run/${linkToken(first.url)}` })).statusCode).toBe(404);
    expect((await app.inject({ url: `/run/${linkToken(reset.url)}` })).statusCode).toBe(200);

    const off = await app.inject({ method: 'DELETE', url: '/api/phone', headers: auth(token) });
    expect(off.statusCode).toBe(204);
    expect((await app.inject({ url: `/run/${linkToken(reset.url)}` })).statusCode).toBe(404);
    expect(
      (await app.inject({ method: 'POST', url: `/run/${linkToken(reset.url)}/${id}` })).statusCode,
    ).toBe(404);
  });

  it('lets the full app through the https address only when switched on', async () => {
    const off = await app.inject({ url: '/api/phone/app-access', headers: auth(token) });
    expect(off.json()).toEqual({ enabled: false, url: null });
    const on = await app.inject({
      method: 'PUT',
      url: '/api/phone/app-access',
      headers: auth(token),
      payload: { enabled: true },
    });
    expect(on.json()).toEqual({ enabled: true, url: null });
    expect(app.remoteAccess.appAccessEnabled).toBe(true);

    // The choice is kept when AutoForge starts again.
    const restarted = await createTestApp({ DATA_DIR: dataDir });
    expect(restarted.remoteAccess.appAccessEnabled).toBe(true);
    await restarted.close();

    await app.inject({
      method: 'PUT',
      url: '/api/phone/app-access',
      headers: auth(token),
      payload: { enabled: false },
    });
    expect(app.remoteAccess.appAccessEnabled).toBe(false);

    const remote = new RemoteAccess({
      publicUrl: 'http://localhost:5678',
      port: 5678,
      mode: 'tunnel',
      dataDir,
      logger: app.log,
    });
    const host = 'quiet-lamp-1234.trycloudflare.com';
    remote.setAppAccess(true);
    expect(remote.allows(host, '/api/workflows')).toBe(true);
    expect(remote.allows(host, '/api/auth/login', {}, 'POST')).toBe(true);
    expect(remote.allows(host, '/workflows')).toBe(true);
    // Creating the first account stays on this computer.
    expect(remote.allows(host, '/api/auth/setup', {}, 'POST')).toBe(false);
    remote.setAppAccess(false);
    expect(remote.allows(host, '/api/workflows')).toBe(false);
  });

  it('lets the phone page through the tunnel, nothing else', () => {
    const remote = new RemoteAccess({
      publicUrl: 'http://localhost:5678',
      port: 5678,
      mode: 'tunnel',
      dataDir,
      logger: app.log,
    });
    const host = 'quiet-lamp-1234.trycloudflare.com';
    expect(remote.allows(host, '/run/abc')).toBe(true);
    expect(remote.allows(host, '/run/abc/status')).toBe(true);
    expect(remote.allows(host, '/approve/abc')).toBe(true);
    expect(remote.allows(host, '/api/phone')).toBe(false);
    expect(remote.allows(host, '/workflows')).toBe(false);
    expect(remote.allows('localhost:5678', '/api/phone')).toBe(true);
  });
});
