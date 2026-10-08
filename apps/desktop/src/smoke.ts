/**
 * Smoke test for the bundled runtime, run with plain Node (CI runs it on Windows before packaging):
 *   node dist/smoke.cjs [resourcesDir] [dataDir]
 * Starts the private database and server, signs up, runs a workflow with a Code node and an
 * expression, stores an encrypted credential, then restarts and checks everything is still there.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { LocalRuntime } from './runtime';

const resourcesDir = resolve(process.argv[2] ?? join(__dirname, '..', 'resources'));
const dataDir = process.argv[3]
  ? resolve(process.argv[3])
  : mkdtempSync(join(tmpdir(), 'flowforge-smoke-'));
const keepData = Boolean(process.argv[3]);
const log = (message: string) => console.log(`[smoke] ${message}`);

const owner = { name: 'Smoke Test', email: 'smoke@example.com', password: 'Smoke-Test-1' };

async function api<T>(
  base: string,
  path: string,
  init: { method?: string; body?: unknown; token?: string } = {},
): Promise<T> {
  const method = init.method ?? (init.body ? 'POST' : 'GET');
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} -> ${response.status}: ${text}`);
  return (text ? JSON.parse(text) : null) as T;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

async function firstRun(base: string) {
  const status = await api<{ setupRequired: boolean; version: string }>(base, '/api/auth/status');
  log(`server ${status.version}, setup required: ${status.setupRequired}`);
  assert(status.setupRequired, 'a fresh install asks for the owner account');
  const { token } = await api<{ token: string }>(base, '/api/auth/setup', { body: owner });

  const editor = await fetch(`${base}/workflows`);
  assert(editor.ok && (await editor.text()).includes('<div id="root">'), 'the editor is served');

  const workflow = await api<{ id: string }>(base, '/api/workflows', {
    token,
    body: {
      name: 'Smoke',
      nodes: [
        {
          id: 't',
          name: 'Trigger',
          type: 'flowforge.manualTrigger',
          typeVersion: 1,
          position: [0, 0],
          parameters: {},
        },
        {
          id: 'c',
          name: 'Code',
          type: 'flowforge.code',
          typeVersion: 1,
          position: [220, 0],
          parameters: { jsCode: 'return [{ json: { n: 6 * 7 } }];' },
        },
        {
          id: 's',
          name: 'Set',
          type: 'flowforge.set',
          typeVersion: 1,
          position: [440, 0],
          parameters: {
            mode: 'manual',
            includeOtherFields: true,
            options: {},
            assignments: {
              assignments: [
                {
                  id: 'a',
                  name: 'msg',
                  value: '=answer {{ $json.n }} at {{ DateTime.now().year > 2000 }}',
                  type: 'string',
                },
              ],
            },
          },
        },
      ],
      connections: [
        { source: 't', sourceOutput: 0, target: 'c', targetInput: 0 },
        { source: 'c', sourceOutput: 0, target: 's', targetInput: 0 },
      ],
    },
  });
  const { executionId } = await api<{ executionId: string }>(
    base,
    `/api/workflows/${workflow.id}/run`,
    { token, body: {} },
  );
  let execution: {
    status: string;
    data?: {
      resultData: {
        runData: Record<
          string,
          Array<{ data?: { main: Array<Array<{ json: Record<string, unknown> }>> } }>
        >;
      };
    };
  } | null = null;
  for (let i = 0; i < 100; i++) {
    execution = await api(base, `/api/executions/${executionId}`, { token });
    if (execution && !['new', 'running', 'waiting'].includes(execution.status)) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  assert(execution?.status === 'success', `workflow run succeeded (status ${execution?.status})`);
  const output = execution.data?.resultData.runData.Set?.[0]?.data?.main[0]?.[0]?.json;
  assert(
    output?.msg === 'answer 42 at true',
    `sandboxed code + expression output (${JSON.stringify(output)})`,
  );
  log('workflow with Code node and expression: ok');

  await api(base, '/api/credentials', {
    token,
    body: {
      name: 'Smoke key',
      type: 'httpHeaderAuth',
      data: { name: 'X-Key', value: 'secret-value' },
    },
  });
  log('encrypted credential saved: ok');
}

async function secondRun(base: string) {
  const status = await api<{ setupRequired: boolean }>(base, '/api/auth/status');
  assert(!status.setupRequired, 'data survives a restart');
  const { token } = await api<{ token: string }>(base, '/api/auth/login', {
    body: { email: owner.email, password: owner.password },
  });
  const credentials = await api<{ data: Array<{ id: string; name: string }> }>(
    base,
    '/api/credentials',
    { token },
  );
  const credential = credentials.data.find((c) => c.name === 'Smoke key');
  assert(credential, 'credential still listed');
  const detail = await api<{ data: Record<string, unknown> }>(
    base,
    `/api/credentials/${credential.id}`,
    { token },
  );
  assert(detail.data.name === 'X-Key', 'credential decrypts with the stored key');
  log('restart: data, sign-in and credential decryption: ok');
}

async function main() {
  log(`resources: ${resourcesDir}`);
  log(`data: ${dataDir}`);
  for (const [index, check] of [firstRun, secondRun].entries()) {
    const runtime = new LocalRuntime({ resourcesDir, dataDir, log, preferredPort: 5690 });
    const started = Date.now();
    try {
      const url = await runtime.start();
      log(`start #${index + 1} took ${((Date.now() - started) / 1000).toFixed(1)}s`);
      await check(url);
    } finally {
      await runtime.stop();
    }
  }
  log('PASSED');
}

main()
  .catch((error: unknown) => {
    console.error(`[smoke] FAILED: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  })
  .finally(() => {
    if (!keepData) rmSync(dataDir, { recursive: true, force: true });
  });
