import { describe, expect, it } from 'vitest';
import type { IWebhookFunctions, INodeParameters } from '@flowforge/workflow';
import { Webhook, scheduleToCron } from '../src';
import { errorOf, runGraph, runNode } from './harness';

const trigger = { name: 'Start', type: 'flowforge.manualTrigger', parameters: {} };
const code = (name: string, js: string) => ({
  name,
  type: 'flowforge.code',
  parameters: { mode: 'runOnceForAllItems', jsCode: js },
});

describe('Merge', () => {
  const graph = (parameters: INodeParameters) =>
    runGraph(
      [
        trigger,
        code(
          'A',
          "return [{ json: { id: 1, name: 'Asha' } }, { json: { id: 2, name: 'Ravi' } }, { json: { id: 3, name: 'Meera' } }];",
        ),
        code(
          'B',
          "return [{ json: { customerId: 1, orders: 4 } }, { json: { customerId: '3', orders: 1 } }, { json: { customerId: 9, orders: 7 } }];",
        ),
        { name: 'Merge', type: 'flowforge.merge', parameters },
      ],
      [
        ['Start', 'A'],
        ['Start', 'B'],
        ['A', 'Merge', 0, 0],
        ['B', 'Merge', 0, 1],
      ],
    );
  const byFields = (joinMode: string, fuzzy = false) =>
    graph({
      mode: 'combineByFields',
      fieldsToMatch: { values: [{ field1: 'id', field2: 'customerId' }] },
      joinMode,
      options: { fuzzyCompare: fuzzy },
    });

  it('appends inputs', async () => {
    const { output } = await graph({ mode: 'append' });
    expect(output('Merge')).toHaveLength(6);
  });
  it('joins by matching fields', async () => {
    expect((await byFields('keepMatches')).output('Merge')).toEqual([
      { id: 1, name: 'Asha', customerId: 1, orders: 4 },
    ]);
    expect((await byFields('keepMatches', true)).output('Merge')).toHaveLength(2); // "3" == 3 with fuzzy compare
    expect((await byFields('enrichInput1')).output('Merge')!.map((j) => j.name)).toEqual([
      'Asha',
      'Ravi',
      'Meera',
    ]);
    expect((await byFields('keepNonMatches')).output('Merge')).toHaveLength(4);
    expect((await byFields('keepEverything')).output('Merge')).toHaveLength(5);
    expect((await byFields('enrichInput2')).output('Merge')!.map((j) => j.orders)).toEqual([
      4, 1, 7,
    ]);
  });
  it('combines by position and chooses branches', async () => {
    expect((await graph({ mode: 'combineByPosition' })).output('Merge')![1]).toEqual({
      id: 2,
      name: 'Ravi',
      customerId: '3',
      orders: 1,
    });
    expect(
      (await graph({ mode: 'chooseBranch', chooseBranch: 'input2' })).output('Merge'),
    ).toHaveLength(3);
  });
});

describe('Switch', () => {
  const rule = (value: string, rename?: string) => ({
    conditions: {
      combinator: 'and',
      conditions: [
        {
          id: '1',
          leftValue: '={{ $json.intent }}',
          rightValue: value,
          operator: { type: 'string', operation: 'equals' },
        },
      ],
    },
    renameOutput: Boolean(rename),
    outputKey: rename ?? '',
  });
  it('routes by rules with a fallback output', async () => {
    const { output } = await runNode(
      'flowforge.switch',
      {
        mode: 'rules',
        rules: { values: [rule('sales', 'Sales'), rule('support')] },
        options: { fallbackOutput: 'extra' },
      } as never,
      [{ intent: 'sales' }, { intent: 'support' }, { intent: 'billing' }, { intent: 'SALES' }],
    );
    expect(output(0)).toEqual([{ intent: 'sales' }, { intent: 'SALES' }]);
    expect(output(1)).toEqual([{ intent: 'support' }]);
    expect(output(2)).toEqual([{ intent: 'billing' }]);
  });
  it('routes by expression', async () => {
    const { output, run } = await runNode(
      'flowforge.switch',
      { mode: 'expression', numberOutputs: 2, output: '={{ $json.n % 2 }}' },
      [{ n: 1 }, { n: 2 }, { n: 3 }],
    );
    expect(run.status).toBe('success');
    expect(output(1)).toEqual([{ n: 1 }, { n: 3 }]);
    const bad = await runNode(
      'flowforge.switch',
      { mode: 'expression', numberOutputs: 2, output: '={{ 5 }}' },
      [{}],
    );
    expect(errorOf(bad.run)?.message).toMatch(/Output index 5 is not between 0 and 1/);
  });
});

describe('Loop Over Items', () => {
  it('processes items in batches and outputs everything on done', async () => {
    const { run, output } = await runGraph(
      [
        trigger,
        code('Items', 'return [1,2,3,4,5].map(n => ({ json: { n } }));'),
        { name: 'Loop', type: 'flowforge.splitInBatches', parameters: { batchSize: 2 } },
        {
          name: 'Double',
          type: 'flowforge.set',
          parameters: {
            mode: 'manual',
            includeOtherFields: true,
            assignments: {
              assignments: [
                { id: '1', name: 'double', value: '={{ $json.n * 2 }}', type: 'number' },
              ],
            },
          },
        },
        { name: 'Done', type: 'flowforge.noOp', parameters: {} },
      ],
      [
        ['Start', 'Items'],
        ['Items', 'Loop'],
        ['Loop', 'Done', 0],
        ['Loop', 'Double', 1],
        ['Double', 'Loop'],
      ],
    );
    expect(run.status).toBe('success');
    expect(run.data.resultData.runData.Double).toHaveLength(3);
    expect(output('Done')!.map((j) => j.double)).toEqual([2, 4, 6, 8, 10]);
  });
});

describe('Wait', () => {
  it('waits in memory for short intervals', async () => {
    const started = Date.now();
    const { run } = await runNode('flowforge.wait', {
      resume: 'timeInterval',
      amount: 0.3,
      unit: 'seconds',
    });
    expect(run.status).toBe('success');
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
  });
  it('pauses the execution for long waits and webhooks', async () => {
    const long = await runNode('flowforge.wait', {
      resume: 'timeInterval',
      amount: 2,
      unit: 'hours',
    });
    expect(long.run.status).toBe('waiting');
    expect(new Date(long.run.data.waitTill!).getTime()).toBeGreaterThan(Date.now() + 3_500_000);
    const hook = await runNode('flowforge.wait', { resume: 'webhook' });
    expect(hook.run.status).toBe('waiting');
    expect(hook.run.data.waitTill!.startsWith('3000')).toBe(true);
  });
});

describe('Schedule Trigger', () => {
  it('converts rules to cron expressions', () => {
    expect(
      scheduleToCron({
        rule: {
          interval: [
            { field: 'seconds', secondsInterval: 10 },
            { field: 'minutes', minutesInterval: 15 },
            { field: 'hours', hoursInterval: 2, triggerAtMinute: 30 },
            { field: 'days', daysInterval: 1, triggerAtHour: 9, triggerAtMinute: 0 },
            { field: 'weeks', triggerAtDay: [5, 1], triggerAtHour: 18, triggerAtMinute: 45 },
            {
              field: 'months',
              monthsInterval: 1,
              triggerAtDayOfMonth: 15,
              triggerAtHour: 8,
              triggerAtMinute: 0,
            },
            { field: 'cronExpression', expression: ' 0 9 * * 1-5 ' },
          ],
        },
      } as never),
    ).toEqual([
      '*/10 * * * * *',
      '0 */15 * * * *',
      '0 30 */2 * * *',
      '0 0 9 */1 * *',
      '0 45 18 * * 1,5',
      '0 0 8 15 */1 *',
      '0 9 * * 1-5',
    ]);
  });
  it('outputs the trigger time when executed', async () => {
    const { output } = await runNode('flowforge.scheduleTrigger', {});
    expect(output()![0]).toHaveProperty('timestamp');
  });
});

describe('Webhook', () => {
  const call = (
    parameters: Record<string, unknown>,
    request: Partial<ReturnType<IWebhookFunctions['getRequest']>>,
    credentials: Record<string, unknown> = {},
  ) => {
    const ctx = {
      getRequest: () => ({
        method: 'POST',
        path: 'x',
        headers: {},
        query: {},
        body: {},
        ...request,
      }),
      getNode: () => ({
        id: 'w',
        name: 'Webhook',
        type: 'flowforge.webhook',
        typeVersion: 1,
        position: [0, 0],
        parameters: {},
      }),
      getNodeParameter: (name: string, fallback?: unknown) =>
        name
          .split('.')
          .reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], parameters) ?? fallback,
      getCredentials: async () => credentials,
      getWorkflow: () => ({ name: 'w', active: true }),
      getMode: () => 'webhook',
      helpers: {
        prepareBinaryData: (data: Buffer, fileName?: string, mimeType?: string) => ({
          data: data.toString('base64'),
          mimeType: mimeType ?? '',
          fileName,
          fileSize: data.length,
        }),
        returnJsonArray: () => [],
      },
    } as unknown as IWebhookFunctions;
    return Webhook.webhook!.call(ctx);
  };

  it('turns a request into an item', async () => {
    const result = await call(
      {},
      {
        body: { name: 'Asha' },
        query: { a: '1' },
        headers: { 'content-type': 'application/json' },
      },
    );
    expect(result.workflowData![0]![0]!.json).toMatchObject({
      body: { name: 'Asha' },
      query: { a: '1' },
      method: 'POST',
    });
  });
  it('enforces basic and header auth', async () => {
    const basic = { user: 'u', password: 'p' };
    expect((await call({ authentication: 'basicAuth' }, {}, basic)).response?.status).toBe(401);
    const ok = await call(
      { authentication: 'basicAuth' },
      { headers: { authorization: `Basic ${Buffer.from('u:p').toString('base64')}` } },
      basic,
    );
    expect(ok.workflowData).toBeDefined();
    const header = { name: 'X-Token', value: 'secret' };
    expect(
      (await call({ authentication: 'headerAuth' }, { headers: { 'x-token': 'nope' } }, header))
        .response?.status,
    ).toBe(403);
    expect(
      (await call({ authentication: 'headerAuth' }, { headers: { 'x-token': 'secret' } }, header))
        .workflowData,
    ).toBeDefined();
  });
  it('enforces the IP allowlist and stores binary bodies', async () => {
    expect(
      (await call({ options: { ipWhitelist: '10.0.0.1' } }, { ip: '10.0.0.2' })).response?.status,
    ).toBe(403);
    const file = await call(
      {},
      { body: Buffer.from('%PDF'), headers: { 'content-type': 'application/pdf' } },
    );
    expect(file.workflowData![0]![0]!.binary!.data).toMatchObject({
      mimeType: 'application/pdf',
      fileSize: 4,
    });
  });
});

describe('Respond to Webhook', () => {
  it('sends the response through the host', async () => {
    const sent: unknown[] = [];
    const { run } = await runNode(
      'flowforge.respondToWebhook',
      {
        respondWith: 'json',
        responseBody: '={{ JSON.stringify({ greeting: "hi " + $json.name }) }}',
        options: { responseCode: 201 },
      },
      [{ name: 'Asha' }],
      {},
      { sendWebhookResponse: (r) => (sent.push(r), true) },
    );
    expect(run.status).toBe('success');
    expect(sent).toEqual([{ status: 201, body: { greeting: 'hi Asha' }, headers: {} }]);
  });
  it('adds a hint when there is no webhook to respond to', async () => {
    const { run } = await runNode('flowforge.respondToWebhook', { respondWith: 'noData' });
    expect(run.data.resultData.runData.Node![0]!.hints![0]).toMatch(/No HTTP response was sent/);
  });
});

describe('Execute Sub-workflow', () => {
  it('passes items to the sub-workflow and returns its output', async () => {
    const calls: unknown[] = [];
    const { output } = await runNode(
      'flowforge.executeWorkflow',
      { source: 'database', workflowId: 'wf-sub', mode: 'each' },
      [{ n: 1 }, { n: 2 }],
      {},
      {
        executeWorkflow: async (source, items) => {
          calls.push(source);
          return {
            executionId: 'sub',
            data: [items.map((i) => ({ json: { doubled: Number(i.json.n) * 2 } }))],
          };
        },
      },
    );
    expect(calls).toEqual([{ workflowId: 'wf-sub' }, { workflowId: 'wf-sub' }]);
    expect(output()).toEqual([{ doubled: 2 }, { doubled: 4 }]);
  });
});

describe('HTTP Request with credentials', () => {
  it('uses the credentials helper', async () => {
    const seen: Array<Record<string, string> | undefined> = [];
    const { output } = await runNode(
      'flowforge.httpRequest',
      {
        url: 'https://api.example.com/me',
        authentication: 'genericCredentialType',
        genericAuthType: 'httpHeaderAuth',
      },
      [{}],
      { credentials: { httpHeaderAuth: { id: 'c1', name: 'Key' } } },
      {
        credentials: {
          getDecrypted: async () => ({ name: 'X-Key', value: 'k' }),
          authenticateRequest: async (_node, _type, options) => ({
            ...options,
            headers: { ...options.headers, 'X-Key': 'k' },
          }),
        },
        httpRequest: async (options) => {
          seen.push(options.headers);
          return { statusCode: 200, statusMessage: 'OK', headers: {}, body: { ok: true } };
        },
      },
    );
    expect(seen[0]).toMatchObject({ 'X-Key': 'k' });
    expect(output()).toEqual([{ ok: true }]);
  });
});
