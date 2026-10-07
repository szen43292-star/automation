import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { WebSocket } from 'ws';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CREDENTIAL_SECRET_MASK } from '@flowforge/workflow';
import { buildApp } from '../src/app';
import { loadConfig } from '../src/config';
import { startWorker } from '../src/worker';
import {
  TEST_DATABASE_URL,
  auth,
  createTestApp,
  manualTrigger,
  prisma,
  resetDb,
  settle,
  setupOwner,
} from './helpers';

let app: FastifyInstance;
let token: string;

// A small "third party API" + OAuth2 provider for credential tests.
let api: Server;
let apiUrl: string;
const apiCalls: Array<{ path: string; headers: Record<string, unknown>; body: string }> = [];
beforeAll(async () => {
  app = await createTestApp();
  api = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      apiCalls.push({ path: req.url!, headers: req.headers, body });
      res.setHeader('content-type', 'application/json');
      const url = new URL(req.url!, 'http://x');
      if (url.pathname === '/token') {
        const params = new URLSearchParams(body);
        const grant = params.get('grant_type');
        if (
          grant === 'authorization_code' &&
          params.get('code') === 'good-code' &&
          params.get('code_verifier')
        ) {
          return res.end(
            JSON.stringify({
              access_token: 'tok-1',
              refresh_token: 'refresh-1',
              expires_in: 1,
              token_type: 'Bearer',
            }),
          );
        }
        if (grant === 'refresh_token' && params.get('refresh_token') === 'refresh-1') {
          return res.end(JSON.stringify({ access_token: 'tok-2', expires_in: 3600 }));
        }
        res.statusCode = 400;
        return res.end(JSON.stringify({ error: 'invalid_grant' }));
      }
      if (url.pathname === '/me') {
        const ok =
          req.headers['x-api-key'] === 'secret-key' || req.headers.authorization === 'Bearer tok-2';
        res.statusCode = ok ? 200 : 401;
        return res.end(JSON.stringify(ok ? { name: 'Asha' } : { error: 'unauthorized' }));
      }
      res.statusCode = 404;
      res.end('{}');
    });
  });
  await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
  apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await app.close();
  await new Promise<void>((r) => api.close(() => r()));
  await prisma.$disconnect();
});
beforeEach(async () => {
  await resetDb();
  token = await setupOwner(app);
});

const H = () => auth(token);
const node = (
  name: string,
  type: string,
  parameters: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
) => ({
  id: name,
  name,
  type,
  typeVersion: 1,
  position: [0, 0] as [number, number],
  parameters,
  ...extra,
});
const chain = (...names: string[]) =>
  names
    .slice(1)
    .map((target, i) => ({ source: names[i]!, sourceOutput: 0, target, targetInput: 0 }));

async function createWorkflow(body: Record<string, unknown>, target = app, t = token) {
  const res = await target.inject({
    method: 'POST',
    url: '/api/workflows',
    headers: auth(t),
    payload: body,
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { id: string; versionId: string };
}
async function activate(id: string, target = app, t = token) {
  return target.inject({
    method: 'PATCH',
    url: `/api/workflows/${id}`,
    headers: auth(t),
    payload: { active: true },
  });
}
async function runManual(id: string, payload: Record<string, unknown> = {}) {
  const res = await app.inject({
    method: 'POST',
    url: `/api/workflows/${id}/run`,
    headers: H(),
    payload,
  });
  expect(res.statusCode, res.body).toBe(202);
  const { executionId } = res.json();
  await settle(app, executionId);
  return (await app.inject({ url: `/api/executions/${executionId}`, headers: H() })).json();
}
const lastOutput = (
  detail: {
    data: {
      resultData: {
        runData: Record<string, Array<{ data: { main: Array<Array<{ json: unknown }>> } }>>;
      };
    };
  },
  nodeName: string,
) => detail.data.resultData.runData[nodeName]?.at(-1)?.data.main[0]?.map((i) => i.json);
async function waitUntil<T>(
  fn: () => Promise<T | undefined | false>,
  timeoutMs = 10_000,
): Promise<T> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Timed out waiting for condition');
}

describe('credentials vault', () => {
  it('encrypts at rest, masks secrets, keeps masked values on update and tests connections', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/credentials',
      headers: H(),
      payload: {
        name: 'Shop API',
        type: 'httpHeaderAuth',
        data: { name: 'X-Api-Key', value: 'secret-key' },
      },
    });
    expect(created.statusCode).toBe(201);
    const cred = created.json();
    expect(cred.data).toEqual({ name: 'X-Api-Key', value: CREDENTIAL_SECRET_MASK });

    const row = await prisma.credential.findUniqueOrThrow({ where: { id: cred.id } });
    expect(row.data).toMatch(/^v1:/);
    expect(row.data).not.toContain('secret-key');

    const renamed = await app.inject({
      method: 'PATCH',
      url: `/api/credentials/${cred.id}`,
      headers: H(),
      payload: {
        name: 'Shop API (prod)',
        data: { name: 'X-Api-Key', value: CREDENTIAL_SECRET_MASK },
      },
    });
    expect(renamed.json().name).toBe('Shop API (prod)');
    const { data } = await app.services.credentials.decrypt(cred.id);
    expect(data.value).toBe('secret-key');

    const missing = await app.inject({
      method: 'POST',
      url: '/api/credentials',
      headers: H(),
      payload: { name: 'x', type: 'httpHeaderAuth', data: { name: 'a' } },
    });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().message).toBe('"Header Value" is required');

    const types = (await app.inject({ url: '/api/credential-types', headers: H() })).json();
    expect(types.data.map((t: { name: string }) => t.name)).toContain('oAuth2Api');

    // Bearer tokens can be tested against a URL.
    const test = await app.inject({
      method: 'POST',
      url: '/api/credentials/test',
      headers: H(),
      payload: { type: 'httpBearerAuth', data: { token: 'wrong', testUrl: `${apiUrl}/me` } },
    });
    expect(test.json()).toEqual({
      ok: false,
      message: 'The service answered HTTP 401 - check the credential',
    });

    // The HTTP Request node uses the credential.
    const wf = await createWorkflow({
      name: 'Uses credential',
      nodes: [
        manualTrigger,
        node(
          'HTTP',
          'flowforge.httpRequest',
          {
            url: `${apiUrl}/me`,
            authentication: 'genericCredentialType',
            genericAuthType: 'httpHeaderAuth',
          },
          {
            credentials: { httpHeaderAuth: { id: cred.id, name: 'Shop API' } },
          },
        ),
      ],
      connections: chain('trigger', 'HTTP'),
    });
    const detail = await runManual(wf.id);
    expect(detail.status).toBe('success');
    expect(lastOutput(detail, 'HTTP')).toEqual([{ name: 'Asha' }]);

    // Nodes without a selected credential fail with a clear message.
    const broken = await createWorkflow({
      name: 'No credential',
      nodes: [
        manualTrigger,
        node('HTTP', 'flowforge.httpRequest', {
          url: `${apiUrl}/me`,
          authentication: 'genericCredentialType',
          genericAuthType: 'httpHeaderAuth',
        }),
      ],
      connections: chain('trigger', 'HTTP'),
    });
    expect((await runManual(broken.id)).errorMessage).toMatch(
      /No "httpHeaderAuth" credential selected/,
    );
  });

  it('connects OAuth2 with PKCE and refreshes expired tokens', async () => {
    const cred = (
      await app.inject({
        method: 'POST',
        url: '/api/credentials',
        headers: H(),
        payload: {
          name: 'Provider',
          type: 'oAuth2Api',
          data: {
            grantType: 'authorizationCode',
            authUrl: `${apiUrl}/authorize`,
            accessTokenUrl: `${apiUrl}/token`,
            clientId: 'cid',
            clientSecret: 'csecret',
            scope: 'read',
          },
        },
      })
    ).json();
    expect(cred.data.oauthConnected).toBe(false);

    const { url } = (
      await app.inject({ url: `/api/credentials/${cred.id}/oauth2/auth-url`, headers: H() })
    ).json();
    const authorize = new URL(url);
    expect(authorize.searchParams.get('client_id')).toBe('cid');
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
    const state = authorize.searchParams.get('state')!;

    const bad = await app.inject({
      url: `/rest/oauth2-credential/callback?code=good-code&state=forged`,
    });
    expect(bad.statusCode).toBe(400);
    const callback = await app.inject({
      url: `/rest/oauth2-credential/callback?code=good-code&state=${encodeURIComponent(state)}`,
    });
    expect(callback.statusCode).toBe(200);
    expect(callback.body).toContain('Connected');
    const tokenCall = apiCalls.find((c) => c.path === '/token')!;
    expect(tokenCall.headers.authorization).toBe(
      `Basic ${Buffer.from('cid:csecret').toString('base64')}`,
    );
    expect(
      (await app.inject({ url: `/api/credentials/${cred.id}`, headers: H() })).json().data
        .oauthConnected,
    ).toBe(true);

    // tok-1 expires immediately; the request refreshes to tok-2 first.
    const wf = await createWorkflow({
      name: 'OAuth call',
      nodes: [
        manualTrigger,
        node(
          'HTTP',
          'flowforge.httpRequest',
          {
            url: `${apiUrl}/me`,
            authentication: 'genericCredentialType',
            genericAuthType: 'oAuth2Api',
          },
          {
            credentials: { oAuth2Api: { id: cred.id, name: 'Provider' } },
          },
        ),
      ],
      connections: chain('trigger', 'HTTP'),
    });
    const detail = await runManual(wf.id);
    expect(detail.status).toBe('success');
    expect(lastOutput(detail, 'HTTP')).toEqual([{ name: 'Asha' }]);
    const { data } = await app.services.credentials.decrypt(cred.id);
    expect((data.oauthTokenData as { access_token: string }).access_token).toBe('tok-2');
  });
});

describe('variables', () => {
  it('are available as $vars in expressions', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/variables',
      headers: H(),
      payload: { key: 'BUSINESS', value: 'Chai Point' },
    });
    expect(res.statusCode).toBe(201);
    const bad = await app.inject({
      method: 'POST',
      url: '/api/variables',
      headers: H(),
      payload: { key: '1bad', value: 'x' },
    });
    expect(bad.statusCode).toBe(400);
    const wf = await createWorkflow({
      name: 'Vars',
      nodes: [
        manualTrigger,
        node('Set', 'flowforge.set', {
          mode: 'manual',
          assignments: {
            assignments: [
              {
                id: '1',
                name: 'greeting',
                value: '=Welcome to {{ $vars.BUSINESS }}!',
                type: 'string',
              },
            ],
          },
        }),
      ],
      connections: chain('trigger', 'Set'),
    });
    expect(lastOutput(await runManual(wf.id), 'Set')).toEqual([
      { greeting: 'Welcome to Chai Point!' },
    ]);
  });
});

describe('webhooks', () => {
  const webhookWorkflow = (
    path: string,
    params: Record<string, unknown>,
    rest: Array<ReturnType<typeof node>> = [],
    names: string[] = [],
  ) => ({
    name: `Webhook ${path}`,
    nodes: [node('Hook', 'flowforge.webhook', { httpMethod: 'POST', path, ...params }), ...rest],
    connections: chain('Hook', ...names),
  });
  const reply = node('Reply', 'flowforge.code', {
    jsCode: "return [{ json: { greeting: 'Hi ' + $input.first().json.body.name } }];",
  });

  it('responds from the last node, immediately, or via Respond to Webhook', async () => {
    const last = await createWorkflow(
      webhookWorkflow('greet', { responseMode: 'lastNode' }, [reply], ['Reply']),
    );
    expect((await activate(last.id)).statusCode).toBe(200);
    const res = await app.inject({
      method: 'POST',
      url: '/webhook/greet',
      payload: { name: 'Asha' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ greeting: 'Hi Asha' });

    const immediate = await createWorkflow(
      webhookWorkflow('/orders/new/', { responseMode: 'onReceived', responseCode: 202 }),
    );
    await activate(immediate.id);
    const started = await app.inject({
      method: 'POST',
      url: '/webhook/orders/new',
      payload: { id: 7 },
    });
    expect(started.statusCode).toBe(202);
    const executionId = started.json().executionId;
    await settle(app, executionId);
    const detail = (
      await app.inject({ url: `/api/executions/${executionId}`, headers: H() })
    ).json();
    expect(detail).toMatchObject({ mode: 'webhook', status: 'success' });
    expect(lastOutput(detail, 'Hook')![0]).toMatchObject({ body: { id: 7 }, method: 'POST' });

    const respond = await createWorkflow(
      webhookWorkflow(
        'respond',
        { responseMode: 'responseNode' },
        [
          node('Respond', 'flowforge.respondToWebhook', {
            respondWith: 'text',
            responseText: '=OK {{ $json.body.n }}',
            options: { responseCode: 201 },
          }),
        ],
        ['Respond'],
      ),
    );
    await activate(respond.id);
    const text = await app.inject({
      method: 'POST',
      url: '/webhook/respond',
      payload: 'n=5',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(text.statusCode).toBe(201);
    expect(text.body).toBe('OK 5');
    expect(text.headers['content-type']).toContain('text/plain');
  });

  it('validates paths, methods, auth and activation state', async () => {
    const a = await createWorkflow(webhookWorkflow('shared', {}));
    await activate(a.id);
    const b = await createWorkflow(webhookWorkflow('shared', {}));
    const clash = await activate(b.id);
    expect(clash.statusCode).toBe(400);
    expect(clash.json().message).toBe(
      'The webhook POST shared is already used by the active workflow "Webhook shared"',
    );

    const wrongMethod = await app.inject({ method: 'GET', url: '/webhook/shared' });
    expect(wrongMethod.statusCode).toBe(404);
    expect(wrongMethod.json().message).toBe('This webhook is registered for POST, not GET');

    await app.inject({
      method: 'PATCH',
      url: `/api/workflows/${a.id}`,
      headers: H(),
      payload: { active: false },
    });
    const inactive = await app.inject({ method: 'POST', url: '/webhook/shared' });
    expect(inactive.statusCode).toBe(404);

    const cred = (
      await app.inject({
        method: 'POST',
        url: '/api/credentials',
        headers: H(),
        payload: { name: 'Basic', type: 'httpBasicAuth', data: { user: 'u', password: 'p' } },
      })
    ).json();
    const secured = await createWorkflow({
      name: 'Secured',
      nodes: [
        node(
          'Hook',
          'flowforge.webhook',
          { httpMethod: 'POST', path: 'secure', authentication: 'basicAuth' },
          { credentials: { httpBasicAuth: { id: cred.id, name: 'Basic' } } },
        ),
      ],
      connections: [],
    });
    await activate(secured.id);
    expect((await app.inject({ method: 'POST', url: '/webhook/secure' })).statusCode).toBe(401);
    const ok = await app.inject({
      method: 'POST',
      url: '/webhook/secure',
      headers: { authorization: `Basic ${Buffer.from('u:p').toString('base64')}` },
    });
    expect(ok.statusCode).toBe(200);
  });

  it('listens for a single test event from the editor', async () => {
    const wf = await createWorkflow(webhookWorkflow('try-me', { responseMode: 'onReceived' }));
    const notListening = await app.inject({ method: 'POST', url: '/webhook-test/try-me' });
    expect(notListening.statusCode).toBe(404);
    const listen = await app.inject({
      method: 'POST',
      url: `/api/workflows/${wf.id}/webhook-test`,
      headers: H(),
      payload: { nodeId: 'Hook' },
    });
    expect(listen.json()).toMatchObject({
      testUrl: 'http://localhost:5678/webhook-test/try-me',
      method: 'POST',
    });
    const hit = await app.inject({
      method: 'POST',
      url: '/webhook-test/try-me',
      payload: { hello: 'world' },
    });
    expect(hit.statusCode).toBe(200);
    await settle(app, hit.json().executionId);
    const detail = (
      await app.inject({ url: `/api/executions/${hit.json().executionId}`, headers: H() })
    ).json();
    expect(detail.mode).toBe('manual');
    expect((await app.inject({ method: 'POST', url: '/webhook-test/try-me' })).statusCode).toBe(
      404,
    ); // one-shot
  });
});

describe('wait and resume', () => {
  it('resumes on a webhook call with the request as output', async () => {
    const wf = await createWorkflow({
      name: 'Approval',
      nodes: [
        manualTrigger,
        node('Wait', 'flowforge.wait', { resume: 'webhook' }),
        node('After', 'flowforge.set', {
          mode: 'manual',
          assignments: {
            assignments: [
              { id: '1', name: 'approved', value: '={{ $json.body.approved }}', type: 'boolean' },
            ],
          },
        }),
      ],
      connections: chain('trigger', 'Wait', 'After'),
    });
    const waiting = await runManual(wf.id);
    expect(waiting.status).toBe('waiting');
    expect(waiting.data.waitingNode).toBe('Wait');

    const resume = await app.inject({
      method: 'POST',
      url: `/webhook-waiting/${waiting.id}`,
      payload: { approved: true },
    });
    expect(resume.statusCode).toBe(200);
    expect(
      (await app.inject({ method: 'POST', url: `/webhook-waiting/${waiting.id}` })).statusCode,
    ).toBe(404);
    await settle(app, waiting.id);
    const done = (await app.inject({ url: `/api/executions/${waiting.id}`, headers: H() })).json();
    expect(done.status).toBe('success');
    expect(lastOutput(done, 'After')).toEqual([{ approved: true }]);
  });

  it('resumes timed waits through the wait tracker', async () => {
    const wf = await createWorkflow({
      name: 'Later',
      nodes: [
        manualTrigger,
        node('Wait', 'flowforge.wait', { resume: 'timeInterval', amount: 2, unit: 'minutes' }),
        node('After', 'flowforge.noOp'),
      ],
      connections: chain('trigger', 'Wait', 'After'),
    });
    const waiting = await runManual(wf.id);
    expect(waiting.status).toBe('waiting');
    expect(new Date(waiting.waitTill).getTime()).toBeGreaterThan(Date.now() + 100_000);
    await prisma.execution.update({
      where: { id: waiting.id },
      data: { waitTill: new Date(Date.now() - 1000) },
    });
    await app.waitTracker.poll();
    await waitUntil(
      async () =>
        (await prisma.execution.findUnique({ where: { id: waiting.id } }))?.status === 'success',
    );
    app.waitTracker.stop();
  });
});

describe('schedules', () => {
  it('runs active scheduled workflows and stops when deactivated', async () => {
    const wf = await createWorkflow({
      name: 'Every second',
      nodes: [
        node('Schedule', 'flowforge.scheduleTrigger', {
          rule: { interval: [{ field: 'seconds', secondsInterval: 1 }] },
        }),
      ],
      connections: [],
    });
    expect((await activate(wf.id)).statusCode).toBe(200);
    expect(app.services.activeWorkflows.scheduleCount(wf.id)).toBe(1);
    const runs = await waitUntil(async () => {
      const n = await prisma.execution.count({
        where: { workflowId: wf.id, mode: 'trigger', status: 'success' },
      });
      return n >= 2 ? n : false;
    }, 5_000);
    expect(runs).toBeGreaterThanOrEqual(2);
    await app.inject({
      method: 'PATCH',
      url: `/api/workflows/${wf.id}`,
      headers: H(),
      payload: { active: false },
    });
    expect(app.services.activeWorkflows.scheduleCount(wf.id)).toBe(0);

    const invalid = await createWorkflow({
      name: 'Bad cron',
      nodes: [
        node('Schedule', 'flowforge.scheduleTrigger', {
          rule: { interval: [{ field: 'cronExpression', expression: 'every day' }] },
        }),
      ],
      connections: [],
    });
    const res = await activate(invalid.id);
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/invalid schedule "every day"/);
  });
});

describe('sub-workflows and error workflows', () => {
  it('executes a sub-workflow and returns its output', async () => {
    const child = await createWorkflow({
      name: 'Double',
      nodes: [
        node('In', 'flowforge.executeWorkflowTrigger'),
        node('Double', 'flowforge.code', {
          mode: 'runOnceForEachItem',
          jsCode: 'return { json: { doubled: $json.n * 2 } };',
        }),
      ],
      connections: chain('In', 'Double'),
    });
    const parent = await createWorkflow({
      name: 'Parent',
      nodes: [
        manualTrigger,
        node('Items', 'flowforge.code', {
          jsCode: 'return [{ json: { n: 2 } }, { json: { n: 5 } }];',
        }),
        node('Call', 'flowforge.executeWorkflow', {
          source: 'database',
          workflowId: child.id,
          mode: 'once',
        }),
      ],
      connections: chain('trigger', 'Items', 'Call'),
    });
    const detail = await runManual(parent.id);
    expect(detail.status).toBe('success');
    expect(lastOutput(detail, 'Call')).toEqual([{ doubled: 4 }, { doubled: 10 }]);
    const childRun = await prisma.execution.findFirstOrThrow({ where: { workflowId: child.id } });
    expect(childRun).toMatchObject({
      parentExecutionId: detail.id,
      mode: 'internal',
      status: 'success',
    });

    const options = (await app.inject({ url: '/api/node-options/workflows', headers: H() })).json();
    expect(options.data).toContainEqual({ name: 'Double', value: child.id });
  });

  it('starts the error workflow when a production execution fails', async () => {
    const handler = await createWorkflow({
      name: 'On error',
      nodes: [node('Error Trigger', 'flowforge.errorTrigger'), node('Log', 'flowforge.noOp')],
      connections: chain('Error Trigger', 'Log'),
    });
    const failing = await createWorkflow({
      name: 'Fragile',
      settings: { errorWorkflow: handler.id },
      nodes: [
        node('Hook', 'flowforge.webhook', { httpMethod: 'POST', path: 'fragile' }),
        node('Boom', 'flowforge.stopAndError', { errorMessage: 'Payment failed' }),
      ],
      connections: chain('Hook', 'Boom'),
    });
    await activate(failing.id);
    const res = await app.inject({ method: 'POST', url: '/webhook/fragile' });
    await settle(app, res.json().executionId);
    const errorRun = await waitUntil(() =>
      prisma.execution
        .findFirst({ where: { workflowId: handler.id }, include: { data: true } })
        .then((r) => (r?.status === 'success' ? r : undefined)),
    );
    expect(errorRun.mode).toBe('error');
    const runData = (
      errorRun.data!.data as {
        resultData: {
          runData: Record<
            string,
            Array<{ data: { main: Array<Array<{ json: Record<string, unknown> }>> } }>
          >;
        };
      }
    ).resultData.runData;
    expect(runData.Log![0]!.data.main[0]![0]!.json).toMatchObject({
      execution: {
        id: res.json().executionId,
        error: { message: 'Payment failed', node: 'Boom' },
        mode: 'webhook',
      },
      workflow: { id: failing.id, name: 'Fragile' },
    });
  });
});

describe('concurrency limits', () => {
  it('runs at most maxConcurrency production executions of a workflow at once', async () => {
    const wf = await createWorkflow({
      name: 'Serial',
      settings: { maxConcurrency: 1 },
      nodes: [
        node('Hook', 'flowforge.webhook', { httpMethod: 'POST', path: 'serial' }),
        node('Wait', 'flowforge.wait', { resume: 'timeInterval', amount: 0.3, unit: 'seconds' }),
      ],
      connections: chain('Hook', 'Wait'),
    });
    await activate(wf.id);
    const ids: string[] = [];
    for (let i = 0; i < 3; i++)
      ids.push((await app.inject({ method: 'POST', url: '/webhook/serial' })).json().executionId);
    await Promise.all(ids.map((id) => settle(app, id)));
    const rows = await prisma.execution.findMany({
      where: { id: { in: ids } },
      orderBy: { startedAt: 'asc' },
    });
    expect(rows.every((r) => r.status === 'success')).toBe(true);
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i]!.startedAt!.getTime()).toBeGreaterThanOrEqual(
        rows[i - 1]!.stoppedAt!.getTime(),
      );
    }
  });
});

describe('partial execution', () => {
  it('reuses the editor run data for upstream nodes', async () => {
    const wf = await createWorkflow({
      name: 'Partial',
      nodes: [
        manualTrigger,
        node('Slow', 'flowforge.code', { jsCode: 'return [{ json: { at: Date.now() } }];' }),
        node('Next', 'flowforge.noOp'),
      ],
      connections: chain('trigger', 'Slow', 'Next'),
    });
    const first = await runManual(wf.id);
    const second = await runManual(wf.id, {
      destinationNode: 'Next',
      runData: first.data.resultData.runData,
    });
    expect(Object.keys(second.data.resultData.runData).sort()).toEqual([
      'Manual Trigger',
      'Next',
      'Slow',
    ]);
    expect(lastOutput(second, 'Next')).toEqual(lastOutput(first, 'Slow'));
    expect(second.data.resultData.runData.Slow[0].startTime).toBe(
      first.data.resultData.runData.Slow[0].startTime,
    );
  });
});

describe('queue mode', () => {
  it('runs production executions on a worker, relays live events and cancels', async () => {
    const env = {
      NODE_ENV: 'test',
      DATABASE_URL: TEST_DATABASE_URL,
      JWT_SECRET: 'test-secret-test-secret-test-secret-123',
      LOG_LEVEL: 'silent',
      EXECUTIONS_MODE: 'queue',
      REDIS_URL: process.env.REDIS_URL ?? 'redis://localhost:6379',
      CODE_TIMEOUT_MS: '20000',
      AUTH_RATE_LIMIT: '1000',
    };
    const prefix = `fftest${Date.now()}`;
    const config = loadConfig(env);
    config.editorDist = null;
    const main = await buildApp(config, { prisma, logger: false, queuePrefix: prefix });
    await main.queue!.subscribe({ onPush: (topics, event) => main.push.publish(topics, event) });
    const worker = await startWorker({
      prisma,
      queuePrefix: prefix,
      env,
      logger: {
        info() {},
        warn() {},
        error() {},
        debug() {},
        child() {
          return this;
        },
      } as never,
    });
    try {
      const login = await main.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: 'owner@example.com', password: 'Sup3rSecret!' },
      });
      const t = login.json().token;
      const wf = await createWorkflow(
        {
          name: 'Queued',
          nodes: [
            node('Hook', 'flowforge.webhook', { httpMethod: 'POST', path: 'queued' }),
            node('Work', 'flowforge.code', { jsCode: "return [{ json: { pid: 'worker' } }];" }),
          ],
          connections: chain('Hook', 'Work'),
        },
        main,
        t,
      );
      expect((await activate(wf.id, main, t)).statusCode).toBe(200);

      await main.listen({ port: 0, host: '127.0.0.1' });
      const { port } = main.server.address() as AddressInfo;
      const ws = new WebSocket(`ws://127.0.0.1:${port}/api/push?token=${t}`);
      const events: Array<{ type: string; data: { executionId?: string } }> = [];
      ws.on('message', (raw) => events.push(JSON.parse(raw.toString())));
      await new Promise<void>((r) => ws.once('message', () => r()));
      ws.send(JSON.stringify({ type: 'subscribe', topic: `workflow:${wf.id}` }));
      await new Promise((r) => setTimeout(r, 100));

      const res = await main.inject({ method: 'POST', url: '/webhook/queued' });
      const executionId = res.json().executionId;
      expect(main.services.executions.isRunning(executionId)).toBe(false); // not in the main process
      const row = await waitUntil(() =>
        prisma.execution
          .findUnique({ where: { id: executionId } })
          .then((r) => (r?.status === 'success' ? r : undefined)),
      );
      expect(row.mode).toBe('webhook');
      await waitUntil(async () =>
        events.some((e) => e.type === 'executionFinished' && e.data.executionId === executionId),
      );
      ws.close();

      // Cancel a long-running queued execution.
      const slow = await createWorkflow(
        {
          name: 'Slow queued',
          nodes: [
            node('Hook', 'flowforge.webhook', { httpMethod: 'POST', path: 'slow-queued' }),
            node('Spin', 'flowforge.code', { jsCode: 'while (true) {}' }),
          ],
          connections: chain('Hook', 'Spin'),
        },
        main,
        t,
      );
      await activate(slow.id, main, t);
      const slowId = (await main.inject({ method: 'POST', url: '/webhook/slow-queued' })).json()
        .executionId;
      await waitUntil(() =>
        prisma.execution.findUnique({ where: { id: slowId } }).then((r) => r?.status === 'running'),
      );
      const stop = await main.inject({
        method: 'POST',
        url: `/api/executions/${slowId}/stop`,
        headers: auth(t),
      });
      expect(stop.statusCode).toBe(200);
      const canceled = await waitUntil(() =>
        prisma.execution
          .findUnique({ where: { id: slowId } })
          .then((r) => (r?.status === 'canceled' ? r : undefined)),
      );
      expect(canceled.errorMessage).toBe('Execution was stopped by a user');
    } finally {
      await worker.close();
      await main.close();
    }
  }, 40_000);
});
