import { describe, expect, it } from 'vitest';
import {
  Workflow,
  type IConnection,
  type IExecuteFunctions,
  type INode,
  type INodeType,
  type INodeTypes,
  type IRun,
  type IWorkflowBase,
} from '@flowforge/workflow';
import {
  IsolatedExpressionEvaluator,
  WorkflowExecute,
  createAdditionalData,
  type WorkflowRunOptions,
} from '../src';

const description = (name: string, inputs = 1, outputs = 1, group: string[] = ['core']) => ({
  name,
  displayName: name,
  icon: 'box',
  group: group as never,
  version: 1,
  description: name,
  defaults: { name },
  inputs: Array.from({ length: inputs }, () => ({ type: 'main' as const })),
  outputs: Array.from({ length: outputs }, () => ({ type: 'main' as const })),
  properties: [{ displayName: 'Value', name: 'value', type: 'string' as const, default: '' }],
});

let executions = 0;
const types: INodeType[] = [
  {
    description: description('t.trigger', 0, 1, ['trigger']),
    async execute(this: IExecuteFunctions) {
      return [this.getInputData()];
    },
  },
  {
    // Sets json.value = resolved "value" parameter for each item.
    description: description('t.set'),
    async execute(this: IExecuteFunctions) {
      executions++;
      return [
        this.getInputData().map((item, i) => ({
          json: { ...item.json, value: this.getNodeParameter('value', i) },
        })),
      ];
    },
  },
  {
    // Turns 1 item into 2 (without setting pairedItem: the engine infers it only when counts match).
    description: description('t.explode'),
    async execute(this: IExecuteFunctions) {
      return [
        this.getInputData().flatMap((item, i) => [
          { json: { part: 1, ...item.json }, pairedItem: { item: i } },
          { json: { part: 2, ...item.json }, pairedItem: { item: i } },
        ]),
      ];
    },
  },
  {
    // Counts its runs in node context.
    description: description('t.counter'),
    async execute(this: IExecuteFunctions) {
      const ctx = this.getContext();
      ctx.runs = Number(ctx.runs ?? 0) + 1;
      return [[{ json: { runs: ctx.runs } }]];
    },
  },
  {
    // Pauses the execution until resumed.
    description: description('t.wait'),
    async execute(this: IExecuteFunctions) {
      this.putExecutionToWait({ waitTill: new Date(Date.now() + 60_000), resumeOnWebhook: true });
      return [this.getInputData()];
    },
  },
];

const registry: INodeTypes = {
  get: (t) => types.find((n) => n.description.name === t),
  getDescription: (t) => types.find((n) => n.description.name === t)?.description,
  getAll: () => types,
};

let y = 0;
const n = (name: string, type: string, extra: Partial<INode> = {}): INode => ({
  id: name,
  name,
  type,
  typeVersion: 1,
  position: [0, (y += 10)],
  parameters: {},
  ...extra,
});
const c = (source: string, target: string, sourceOutput = 0, targetInput = 0): IConnection => ({
  source,
  target,
  sourceOutput,
  targetInput,
});

async function run(wf: Omit<IWorkflowBase, 'name'>, options: WorkflowRunOptions = {}) {
  const order: string[] = [];
  const result = await new WorkflowExecute(
    new Workflow({ name: 'Phase 2', id: 'wf1', ...wf }),
    createAdditionalData({
      executionId: 'exec-1',
      mode: 'manual',
      nodeTypes: registry,
      variables: { REGION: 'IN' },
      hooks: { nodeExecuteBefore: (name) => void order.push(name) },
    }),
  ).run(options);
  return { result, order };
}

const out = (r: IRun, node: string, output = 0, runIndex = 0) =>
  r.data.resultData.runData[node]?.[runIndex]?.data?.main[output]?.map((i) => i.json);

describe('JavaScript expressions (isolated-vm)', () => {
  const evalOne = async (
    expression: string,
    input: Record<string, unknown> = { name: 'asha', price: 10, qty: 3 },
  ) => {
    const { result } = await run(
      {
        nodes: [n('Start', 't.trigger'), n('Set', 't.set', { parameters: { value: expression } })],
        connections: [c('Start', 'Set')],
      },
      { triggerItems: [{ json: input }] },
    );
    if (result.status !== 'success') return { error: result.data.resultData.error?.message };
    return { value: out(result, 'Set')![0]!.value };
  };

  it('evaluates JavaScript', async () => {
    expect(await evalOne('={{ $json.price * $json.qty }}')).toEqual({ value: 30 });
    expect(await evalOne('={{ $json.name.toUpperCase() }}')).toEqual({ value: 'ASHA' });
    expect(await evalOne('=Total: {{ ($json.price * $json.qty).toFixed(2) }} INR')).toEqual({
      value: 'Total: 30.00 INR',
    });
    expect(await evalOne('={{ [1,2,3].map(x => x * 2) }}')).toEqual({ value: [2, 4, 6] });
    expect(await evalOne('={{ $if($json.qty > 2, "bulk", "single") }}')).toEqual({ value: 'bulk' });
    expect(await evalOne('={{ $ifEmpty($json.missing, "n/a") }}')).toEqual({ value: 'n/a' });
    expect(await evalOne('={{ $vars.REGION + "-" + $workflow.name }}')).toEqual({
      value: 'IN-Phase 2',
    });
    expect(await evalOne('={{ $itemIndex }}')).toEqual({ value: 0 });
  });

  it('provides luxon dates', async () => {
    expect(
      await evalOne("={{ DateTime.fromISO('2025-01-31').plus({ days: 1 }).toISODate() }}"),
    ).toEqual({ value: '2025-02-01' });
    const now = await evalOne('={{ $now }}');
    expect(typeof now.value).toBe('string');
    expect(Math.abs(new Date(now.value as string).getTime() - Date.now())).toBeLessThan(10_000);
    expect(await evalOne('={{ $today.toFormat("yyyy") }}')).toEqual({
      value: String(new Date().getUTCFullYear()),
    });
  });

  it('is sandboxed', async () => {
    expect(await evalOne('={{ typeof process + typeof require + typeof fetch }}')).toEqual({
      value: 'undefinedundefinedundefined',
    });
    expect((await evalOne('={{ (() => { while (true) {} })() }}')).error).toMatch(
      /took longer than/,
    );
    expect((await evalOne('={{ $json.a.b }}')).error).toMatch(
      /Cannot read properties of undefined/,
    );
    expect((await evalOne('={{ $json.name.toUpperCase }}')).error).toMatch(/returned a function/);
    expect((await evalOne('={{ 1 + }}')).error).toMatch(/SyntaxError/);
  });

  it('resolves $("Node").item through paired items', async () => {
    const { result } = await run(
      {
        nodes: [
          n('Start', 't.trigger'),
          n('Lookup', 't.set', { parameters: { value: '={{ "customer-" + $json.id }}' } }),
          n('Explode', 't.explode'),
          n('Use', 't.set', {
            parameters: {
              value:
                "={{ $('Lookup').item.json.value + '/' + $json.part + '/' + $('Start').all().length }}",
            },
          }),
        ],
        connections: [c('Start', 'Lookup'), c('Lookup', 'Explode'), c('Explode', 'Use')],
      },
      { triggerItems: [{ json: { id: 1 } }, { json: { id: 2 } }] },
    );
    expect(result.status).toBe('success');
    expect(out(result, 'Use')!.map((j) => j.value)).toEqual([
      'customer-1/1/2',
      'customer-1/2/2',
      'customer-2/1/2',
      'customer-2/2/2',
    ]);
  });

  it('gives a clear error for nodes that did not run', async () => {
    const r = await evalOne("={{ $('Nope').item.json.x }}");
    expect(r.error).toMatch(/Referenced node "Nope" hasn't been executed yet/);
  });

  it('isolates executions from each other', async () => {
    const a = new IsolatedExpressionEvaluator();
    const data = {
      item: { json: {} },
      itemIndex: 0,
      runIndex: 0,
      inputItems: [],
      getNodeOutput: () => undefined,
      workflow: { name: 'x' },
      execution: { id: 'e', mode: 'manual' as const },
      parameters: {},
      timezone: 'UTC',
      vars: {},
    };
    a.evaluate('globalThis.leak = 42', data);
    expect(a.evaluate('typeof leak', data)).toBe('number');
    const b = new IsolatedExpressionEvaluator();
    expect(b.evaluate('typeof leak', data)).toBe('undefined');
    a.dispose();
    b.dispose();
  });
});

describe('partial execution', () => {
  it('reuses stored parent output and reruns dirty nodes', async () => {
    const wf = {
      nodes: [
        n('Start', 't.trigger'),
        n('A', 't.set', { parameters: { value: 'a' } }),
        n('B', 't.set', { parameters: { value: '={{ $json.value + "b" }}' } }),
        n('C', 't.set', { parameters: { value: '={{ $json.value + "c" }}' } }),
      ],
      connections: [c('Start', 'A'), c('A', 'B'), c('B', 'C')],
    };
    const first = await run(wf);
    expect(out(first.result, 'C')).toEqual([{ value: 'abc' }]);

    const again = await run(wf, {
      destinationNode: 'C',
      runData: first.result.data.resultData.runData,
    });
    expect(again.order).toEqual(['C']);
    expect(out(again.result, 'C')).toEqual([{ value: 'abc' }]);
    expect(Object.keys(again.result.data.resultData.runData).sort()).toEqual([
      'A',
      'B',
      'C',
      'Start',
    ]);

    const dirty = await run(wf, {
      destinationNode: 'C',
      runData: first.result.data.resultData.runData,
      dirtyNodes: ['B'],
    });
    expect(dirty.order).toEqual(['B', 'C']);
  });

  it('runs from the trigger when nothing can be reused', async () => {
    const { order } = await run(
      { nodes: [n('Start', 't.trigger'), n('A', 't.set')], connections: [c('Start', 'A')] },
      { destinationNode: 'A', runData: {} },
    );
    expect(order).toEqual(['Start', 'A']);
  });
});

describe('wait and resume', () => {
  const wf = {
    nodes: [
      n('Start', 't.trigger'),
      n('Wait', 't.wait'),
      n('After', 't.set', { parameters: { value: '={{ $json.resumed ?? "timer" }}' } }),
    ],
    connections: [c('Start', 'Wait'), c('Wait', 'After')],
  };

  it('pauses after a Wait node and resumes with or without data', async () => {
    const first = await run(wf);
    expect(first.result.status).toBe('waiting');
    expect(first.result.data.waitingNode).toBe('Wait');
    expect(new Date(first.result.data.waitTill!).getTime()).toBeGreaterThan(Date.now());
    expect(first.order).toEqual(['Start', 'Wait']);

    const timer = await run(wf, { resumeFrom: first.result.data });
    expect(timer.order).toEqual(['After']);
    expect(out(timer.result, 'After')).toEqual([{ value: 'timer' }]);
    expect(timer.result.data.waitTill).toBeUndefined();

    const webhook = await run(wf, {
      resumeFrom: first.result.data,
      resumeData: [{ json: { resumed: 'webhook' } }],
    });
    expect(out(webhook.result, 'After')).toEqual([{ resumed: 'webhook', value: 'webhook' }]);
  });
});

describe('node context', () => {
  it('keeps state between runs of a node in a loop', async () => {
    const r = await new WorkflowExecute(
      new Workflow({
        name: 'ctx',
        nodes: [n('Start', 't.trigger'), n('Counter', 't.counter')],
        connections: [c('Start', 'Counter'), c('Counter', 'Counter')],
      }),
      createAdditionalData({
        executionId: 'x',
        mode: 'manual',
        nodeTypes: registry,
        maxNodeRuns: 6,
      }),
    ).run();
    expect(r.data.contextData?.Counter).toEqual({ runs: 5 });
    expect(r.data.resultData.runData.Counter!.map((t) => t.data!.main[0]![0]!.json.runs)).toEqual([
      1, 2, 3, 4, 5,
    ]);
  });
});

describe('item linking inference', () => {
  it('pairs items automatically when counts match', async () => {
    executions = 0;
    const { result } = await run(
      { nodes: [n('Start', 't.trigger'), n('A', 't.set')], connections: [c('Start', 'A')] },
      { triggerItems: [{ json: { i: 0 } }, { json: { i: 1 } }] },
    );
    expect(result.data.resultData.runData.A![0]!.data!.main[0]!.map((i) => i.pairedItem)).toEqual([
      { item: 0 },
      { item: 1 },
    ]);
    expect(executions).toBe(1);
  });
});
