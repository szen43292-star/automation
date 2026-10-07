import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { WebSocket } from 'ws';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  OWNER,
  auth,
  createTestApp,
  manualTrigger,
  prisma,
  resetDb,
  settle,
  setupOwner,
} from './helpers';

let app: FastifyInstance;

beforeAll(async () => {
  app = await createTestApp();
});
afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});
beforeEach(resetDb);

describe('auth', () => {
  it('requires setup first, then allows exactly one owner', async () => {
    expect((await app.inject('/api/auth/status')).json()).toMatchObject({ setupRequired: true });

    const weak = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { ...OWNER, password: 'short' },
    });
    expect(weak.statusCode).toBe(400);
    expect(weak.json()).toMatchObject({
      error: 'ValidationError',
      message: 'password: Password must be at least 8 characters',
    });

    const token = await setupOwner(app);
    expect(token).toBeTruthy();
    expect((await app.inject('/api/auth/status')).json()).toMatchObject({ setupRequired: false });

    const again = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { ...OWNER, email: 'x@y.com' },
    });
    expect(again.statusCode).toBe(403);
  });

  it('logs in and protects the API', async () => {
    await setupOwner(app);
    const bad = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { ...OWNER, password: 'Wrong123!' },
    });
    expect(bad.statusCode).toBe(401);
    expect(bad.json().message).toBe('Wrong email or password');

    const ok = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'OWNER@example.com ', password: OWNER.password },
    });
    expect(ok.statusCode).toBe(200);
    const { token, user } = ok.json();
    expect(user).toMatchObject({ email: OWNER.email, role: 'owner' });

    expect((await app.inject('/api/workflows')).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/workflows', headers: auth('garbage') })).statusCode).toBe(
      401,
    );
    expect(
      (await app.inject({ url: '/api/auth/me', headers: auth(token) })).json().user.email,
    ).toBe(OWNER.email);
  });
});

describe('workflows', () => {
  let token: string;
  beforeEach(async () => {
    token = await setupOwner(app);
  });

  const create = (payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: '/api/workflows', headers: auth(token), payload });

  it('creates, lists, updates with optimistic locking, versions and deletes', async () => {
    const created = await create({ name: 'Receptionist', nodes: [manualTrigger] });
    expect(created.statusCode).toBe(201);
    const wf = created.json();
    expect(wf).toMatchObject({ name: 'Receptionist', active: false, settings: {} });

    const list = (
      await app.inject({ url: '/api/workflows?search=recep', headers: auth(token) })
    ).json();
    expect(list.total).toBe(1);
    expect(list.data[0]).toMatchObject({
      id: wf.id,
      nodeCount: 1,
      nodeTypes: ['flowforge.manualTrigger'],
    });

    const updated = await app.inject({
      method: 'PATCH',
      url: `/api/workflows/${wf.id}`,
      headers: auth(token),
      payload: { name: 'Receptionist v2', versionId: wf.versionId },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().versionId).not.toBe(wf.versionId);

    const stale = await app.inject({
      method: 'PATCH',
      url: `/api/workflows/${wf.id}`,
      headers: auth(token),
      payload: { name: 'Old tab', versionId: wf.versionId },
    });
    expect(stale.statusCode).toBe(409);

    const versions = (
      await app.inject({ url: `/api/workflows/${wf.id}/versions`, headers: auth(token) })
    ).json();
    expect(versions.data).toHaveLength(2);
    const first = await app.inject({
      url: `/api/workflows/${wf.id}/versions/${wf.versionId}`,
      headers: auth(token),
    });
    expect(first.json().name).toBe('Receptionist');

    expect(
      (await app.inject({ method: 'DELETE', url: `/api/workflows/${wf.id}`, headers: auth(token) }))
        .statusCode,
    ).toBe(204);
    expect(
      (await app.inject({ url: `/api/workflows/${wf.id}`, headers: auth(token) })).statusCode,
    ).toBe(404);
  });

  it('validates the graph', async () => {
    const res = await create({
      name: 'Broken',
      nodes: [manualTrigger, { ...manualTrigger, id: 'other' }],
      connections: [{ source: 'trigger', sourceOutput: 0, target: 'ghost', targetInput: 0 }],
    });
    expect(res.statusCode).toBe(400);
    const messages = res.json().issues.map((i: { message: string }) => i.message);
    expect(messages).toContain('Duplicate node name "Manual Trigger" - node names must be unique');
    expect(messages).toContain('Connection references a node that does not exist');
  });

  it('refuses to activate a workflow with only a manual trigger', async () => {
    const wf = (await create({ name: 'Manual only', nodes: [manualTrigger] })).json();
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/workflows/${wf.id}`,
      headers: auth(token),
      payload: { active: true },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/no trigger that can start it automatically/);
  });

  it('imports and exports JSON', async () => {
    const wf = (await create({ name: 'Export me', nodes: [manualTrigger] })).json();
    const exported = await app.inject({
      url: `/api/workflows/${wf.id}/export`,
      headers: auth(token),
    });
    expect(exported.headers['content-disposition']).toBe('attachment; filename="Export me.json"');
    const imported = await app.inject({
      method: 'POST',
      url: '/api/workflows/import',
      headers: auth(token),
      payload: { ...(exported.json() as Record<string, unknown>), name: 'Imported' },
    });
    expect(imported.statusCode).toBe(201);
    expect(imported.json()).toMatchObject({ name: 'Imported', nodes: [manualTrigger] });
    expect(imported.json().id).not.toBe(wf.id);
  });

  it('lists node types', async () => {
    const res = (await app.inject({ url: '/api/node-types', headers: auth(token) })).json();
    const names = res.data.map((d: { name: string }) => d.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'flowforge.manualTrigger',
        'flowforge.httpRequest',
        'flowforge.code',
        'flowforge.if',
      ]),
    );
  });
});

describe('executions', () => {
  let token: string;
  beforeEach(async () => {
    token = await setupOwner(app);
  });

  const nodes = [
    manualTrigger,
    {
      id: 'code',
      name: 'Code',
      type: 'flowforge.code',
      typeVersion: 1,
      position: [200, 0],
      parameters: {
        jsCode: 'return [{ json: { greeting: "hi" } }, { json: { greeting: "hello" } }];',
      },
    },
    {
      id: 'if',
      name: 'If',
      type: 'flowforge.if',
      typeVersion: 1,
      position: [400, 0],
      parameters: {
        conditions: {
          combinator: 'and',
          conditions: [
            {
              id: '1',
              leftValue: '={{ $json.greeting }}',
              rightValue: 'hi',
              operator: { type: 'string', operation: 'equals' },
            },
          ],
        },
      },
    },
  ];
  const connections = [
    { source: 'trigger', sourceOutput: 0, target: 'code', targetInput: 0 },
    { source: 'code', sourceOutput: 0, target: 'if', targetInput: 0 },
  ];

  async function runWorkflow(workflowId: string, body: Record<string, unknown> = {}) {
    const res = await app.inject({
      method: 'POST',
      url: `/api/workflows/${workflowId}/run`,
      headers: auth(token),
      payload: body,
    });
    expect(res.statusCode).toBe(202);
    const { executionId } = res.json();
    await settle(app, executionId);
    return executionId as string;
  }

  it('runs a workflow and stores per-node data in the history', async () => {
    const wf = (
      await app.inject({
        method: 'POST',
        url: '/api/workflows',
        headers: auth(token),
        payload: { name: 'Run me', nodes, connections },
      })
    ).json();
    const executionId = await runWorkflow(wf.id);

    const detail = (
      await app.inject({ url: `/api/executions/${executionId}`, headers: auth(token) })
    ).json();
    expect(detail).toMatchObject({
      status: 'success',
      mode: 'manual',
      lastNodeExecuted: 'If',
      running: false,
    });
    const runData = detail.data.resultData.runData;
    expect(runData.If[0].data.main[0]).toEqual([
      { json: { greeting: 'hi' }, pairedItem: { item: 0 } },
    ]);
    expect(runData.If[0].data.main[1]).toEqual([
      { json: { greeting: 'hello' }, pairedItem: { item: 1 } },
    ]);
    expect(detail.workflowData.nodes).toHaveLength(3);

    const list = (
      await app.inject({ url: `/api/executions?workflowId=${wf.id}`, headers: auth(token) })
    ).json();
    expect(list.data).toHaveLength(1);
    expect(list.data[0]).toMatchObject({
      id: executionId,
      workflowName: 'Run me',
      status: 'success',
    });
    expect(list.data[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it('runs unsaved editor data and supports "execute step"', async () => {
    const wf = (
      await app.inject({
        method: 'POST',
        url: '/api/workflows',
        headers: auth(token),
        payload: { name: 'Draft', nodes: [manualTrigger] },
      })
    ).json();
    const executionId = await runWorkflow(wf.id, {
      workflowData: { nodes, connections },
      destinationNode: 'Code',
    });
    const detail = (
      await app.inject({ url: `/api/executions/${executionId}`, headers: auth(token) })
    ).json();
    expect(Object.keys(detail.data.resultData.runData).sort()).toEqual(['Code', 'Manual Trigger']);
  });

  it('records errors, filters by status and retries from the failed node', async () => {
    const failing = [
      manualTrigger,
      { ...nodes[1], parameters: { jsCode: 'throw new Error("CRM is down")' } },
    ];
    const wf = (
      await app.inject({
        method: 'POST',
        url: '/api/workflows',
        headers: auth(token),
        payload: { name: 'Fails', nodes: failing, connections: [connections[0]] },
      })
    ).json();
    const executionId = await runWorkflow(wf.id);

    const detail = (
      await app.inject({ url: `/api/executions/${executionId}`, headers: auth(token) })
    ).json();
    expect(detail.status).toBe('error');
    expect(detail.errorMessage).toBe('CRM is down [line 1]');
    expect(detail.data.resultData.error).toMatchObject({
      node: 'Code',
      name: 'NodeOperationError',
    });

    const errors = (
      await app.inject({ url: '/api/executions?status=error', headers: auth(token) })
    ).json();
    expect(errors.data.map((e: { id: string }) => e.id)).toEqual([executionId]);
    expect(
      (await app.inject({ url: '/api/executions?status=bogus', headers: auth(token) })).statusCode,
    ).toBe(400);

    // Fix the workflow, then retry using the current version.
    await app.inject({
      method: 'PATCH',
      url: `/api/workflows/${wf.id}`,
      headers: auth(token),
      payload: {
        nodes: [
          manualTrigger,
          { ...nodes[1], parameters: { jsCode: 'return [{ json: { fixed: true } }]' } },
        ],
      },
    });
    const retry = await app.inject({
      method: 'POST',
      url: `/api/executions/${executionId}/retry`,
      headers: auth(token),
      payload: { useCurrentWorkflow: true },
    });
    expect(retry.statusCode).toBe(202);
    const retryId = retry.json().executionId;
    await settle(app, retryId);
    const retried = (
      await app.inject({ url: `/api/executions/${retryId}`, headers: auth(token) })
    ).json();
    expect(retried).toMatchObject({ status: 'success', mode: 'retry', retryOfId: executionId });
    expect(retried.data.resultData.runData.Code[0].data.main[0]).toEqual([
      { json: { fixed: true } },
    ]);
    const original = (
      await app.inject({ url: `/api/executions/${executionId}`, headers: auth(token) })
    ).json();
    expect(original.retrySuccessId).toBe(retryId);
  });

  it('stops a running execution', async () => {
    const wf = (
      await app.inject({
        method: 'POST',
        url: '/api/workflows',
        headers: auth(token),
        payload: {
          name: 'Slow',
          nodes: [manualTrigger, { ...nodes[1], parameters: { jsCode: 'while (true) {}' } }],
          connections: [connections[0]],
        },
      })
    ).json();
    const res = await app.inject({
      method: 'POST',
      url: `/api/workflows/${wf.id}/run`,
      headers: auth(token),
      payload: {},
    });
    const { executionId } = res.json();
    await new Promise((r) => setTimeout(r, 200));
    const stop = await app.inject({
      method: 'POST',
      url: `/api/executions/${executionId}/stop`,
      headers: auth(token),
    });
    expect(stop.statusCode).toBe(200);
    const detail = (
      await app.inject({ url: `/api/executions/${executionId}`, headers: auth(token) })
    ).json();
    expect(detail.status).toBe('canceled');
    expect(detail.errorMessage).toBe('Execution was stopped by a user');
  });

  it('pushes live node events over WebSocket', async () => {
    const wf = (
      await app.inject({
        method: 'POST',
        url: '/api/workflows',
        headers: auth(token),
        payload: { name: 'Live', nodes, connections },
      })
    ).json();
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as AddressInfo;

    const denied = new WebSocket(`ws://127.0.0.1:${port}/api/push?token=bad`);
    const closeCode = await new Promise<number>((resolve) =>
      denied.on('close', (code) => resolve(code)),
    );
    expect(closeCode).toBe(4401);

    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/push?token=${token}`);
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    ws.on('message', (raw) => events.push(JSON.parse(raw.toString())));
    await new Promise<void>((resolve) => {
      ws.once('message', () => resolve());
    });
    ws.send(JSON.stringify({ type: 'subscribe', topic: `workflow:${wf.id}` }));
    await new Promise((r) => setTimeout(r, 100));

    const executionId = await runWorkflow(wf.id);
    await new Promise((r) => setTimeout(r, 100));
    ws.close();

    const types = events.map((e) => `${e.type}${e.data?.nodeName ? `:${e.data.nodeName}` : ''}`);
    expect(types).toEqual([
      'connected',
      'executionStarted',
      'nodeExecuteBefore:Manual Trigger',
      'nodeExecuteAfter:Manual Trigger',
      'nodeExecuteBefore:Code',
      'nodeExecuteAfter:Code',
      'nodeExecuteBefore:If',
      'nodeExecuteAfter:If',
      'executionFinished',
    ]);
    const ifDone = events.find((e) => e.type === 'nodeExecuteAfter' && e.data.nodeName === 'If')!;
    expect(ifDone.data).toMatchObject({ executionId, status: 'success', itemCounts: [1, 1] });
  });

  it('marks executions interrupted by a restart as crashed', async () => {
    const wf = (
      await app.inject({
        method: 'POST',
        url: '/api/workflows',
        headers: auth(token),
        payload: { name: 'X', nodes },
      })
    ).json();
    const stuck = await prisma.execution.create({
      data: { workflowId: wf.id, mode: 'manual', status: 'running', startedAt: new Date() },
    });
    await app.services.executions.recoverCrashed();
    const row = await prisma.execution.findUniqueOrThrow({ where: { id: stuck.id } });
    expect(row.status).toBe('crashed');
  });
});

describe('rate limiting', () => {
  it('limits sign-in attempts', async () => {
    const { buildApp } = await import('../src/app');
    const { loadConfig } = await import('../src/config');
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/flowforge_test',
      JWT_SECRET: 'test-secret-test-secret-test-secret-123',
      AUTH_RATE_LIMIT: '3',
    });
    config.editorDist = null;
    const limited = await buildApp(config, { prisma, logger: false });
    const attempt = () =>
      limited.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: 'a@b.com', password: 'x' },
      });
    for (let i = 0; i < 3; i++) expect((await attempt()).statusCode).toBe(401);
    const blocked = await attempt();
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error).toBe('TooManyRequests');
    await limited.close();
  });
});
