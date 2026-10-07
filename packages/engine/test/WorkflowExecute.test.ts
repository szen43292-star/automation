import { describe, expect, it, vi } from 'vitest';
import {
  NodeOperationError,
  Workflow,
  type IConnection,
  type IExecuteFunctions,
  type INode,
  type INodeType,
  type INodeTypes,
  type IRun,
  type IWorkflowBase,
} from '@flowforge/workflow';
import { WorkflowExecute, createAdditionalData, type IExecutionHooks } from '../src';

// --- Fake node types -------------------------------------------------------

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
  properties: [
    { displayName: 'Value', name: 'value', type: 'string' as const, default: '' },
    { displayName: 'Field', name: 'field', type: 'string' as const, default: 'value' },
  ],
});

const trigger: INodeType = {
  description: description('test.trigger', 0, 1, ['trigger']),
  async execute(this: IExecuteFunctions) {
    return [this.getInputData()];
  },
};

/** Sets json[field] = value (expressions resolved per item). */
const set: INodeType = {
  description: description('test.set'),
  async execute(this: IExecuteFunctions) {
    return [
      this.getInputData().map((item, i) => ({
        json: { ...item.json, [this.getNodeParameter<string>('field', i)]: this.getNodeParameter('value', i) },
      })),
    ];
  },
};

/** Routes items with json.ok === true to output 0, others to output 1. */
const branch: INodeType = {
  description: description('test.branch', 1, 2),
  async execute(this: IExecuteFunctions) {
    const items = this.getInputData();
    return [items.filter((i) => i.json.ok === true), items.filter((i) => i.json.ok !== true)];
  },
};

/** Two inputs: outputs [...input0, ...input1] and records how many inputs had data. */
const merge: INodeType = {
  description: description('test.merge', 2, 1),
  async execute(this: IExecuteFunctions) {
    return [[...this.getInputData(0), ...this.getInputData(1), { json: { inputs: this.getInputCount() } }]];
  },
};

const fail: INodeType = {
  description: description('test.fail'),
  async execute(this: IExecuteFunctions) {
    throw new NodeOperationError(this.getNode(), 'Boom', { description: 'it failed' });
  },
};

const empty: INodeType = {
  description: description('test.empty'),
  async execute() {
    return [[]];
  },
};

const slow: INodeType = {
  description: description('test.slow'),
  async execute(this: IExecuteFunctions) {
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    return [this.getInputData()];
  },
};

/** Fails the first `failures` calls, then succeeds. */
function flaky(failures: number) {
  let calls = 0;
  const node: INodeType = {
    description: description('test.flaky'),
    async execute(this: IExecuteFunctions) {
      calls++;
      if (calls <= failures) throw new Error(`Attempt ${calls} failed`);
      return [this.getInputData().map((i) => ({ json: { ...i.json, attempts: calls } }))];
    },
  };
  return { node, calls: () => calls };
}

/** Marks every item with error, except items where json.ok is true. */
const partialFail: INodeType = {
  description: description('test.partialFail'),
  async execute(this: IExecuteFunctions) {
    return [
      this.getInputData().map((item) =>
        item.json.ok ? item : { json: item.json, error: { name: 'E', message: 'bad item', timestamp: 0 } },
      ),
    ];
  },
};

function registry(extra: INodeType[] = []): INodeTypes {
  const map = new Map<string, INodeType>();
  [trigger, set, branch, merge, fail, empty, slow, partialFail, ...extra].forEach((n) =>
    map.set(n.description.name, n),
  );
  return {
    get: (t) => map.get(t),
    getDescription: (t) => map.get(t)?.description,
    getAll: () => [...map.values()],
  };
}

// --- Helpers ---------------------------------------------------------------

let y = 0;
function n(name: string, type: string, extra: Partial<INode> = {}): INode {
  return { id: name, name, type, typeVersion: 1, position: [0, (y += 10)], parameters: {}, ...extra };
}
const c = (source: string, target: string, sourceOutput = 0, targetInput = 0): IConnection => ({
  source,
  target,
  sourceOutput,
  targetInput,
});

async function run(
  wf: Omit<IWorkflowBase, 'name'>,
  opts: { types?: INodeTypes; hooks?: IExecutionHooks; options?: Parameters<WorkflowExecute['run']>[0] } = {},
) {
  const order: string[] = [];
  const executor = new WorkflowExecute(
    new Workflow({ name: 'test', ...wf }),
    createAdditionalData({
      executionId: 'exec-1',
      mode: 'manual',
      nodeTypes: opts.types ?? registry(),
      hooks: { nodeExecuteBefore: (name) => void order.push(name), ...opts.hooks },
    }),
  );
  const result = await executor.run(opts.options);
  return { result, order, executor };
}

const out = (result: IRun, node: string, output = 0, runIndex = 0) =>
  result.data.resultData.runData[node]?.[runIndex]?.data?.main[output]?.map((i) => i.json);

// --- Tests -----------------------------------------------------------------

describe('WorkflowExecute', () => {
  it('passes items along a linear chain', async () => {
    const { result } = await run({
      nodes: [
        n('Start', 'test.trigger'),
        n('A', 'test.set', { parameters: { field: 'a', value: 1 } }),
        n('B', 'test.set', { parameters: { field: 'b', value: '={{ $json.a }}' } }),
      ],
      connections: [c('Start', 'A'), c('A', 'B')],
    });
    expect(result.status).toBe('success');
    expect(out(result, 'B')).toEqual([{ a: 1, b: 1 }]);
    expect(result.data.resultData.lastNodeExecuted).toBe('B');
    expect(result.data.resultData.runData.B![0]!.source).toEqual([
      { previousNode: 'A', previousNodeOutput: 0, previousNodeRun: 0 },
    ]);
  });

  it('uses trigger items and resolves $node references', async () => {
    const { result } = await run(
      {
        nodes: [
          n('Start', 'test.trigger'),
          n('A', 'test.set', { parameters: { field: 'x', value: 'one' } }),
          n('B', 'test.set', { parameters: { field: 'fromStart', value: '=Hi {{ $node["Start"].json.name }}' } }),
        ],
        connections: [c('Start', 'A'), c('A', 'B')],
      },
      { options: { triggerItems: [{ json: { name: 'Asha' } }] } },
    );
    expect(out(result, 'B')).toEqual([{ name: 'Asha', x: 'one', fromStart: 'Hi Asha' }]);
  });

  it('executes branches depth-first ordered by position', async () => {
    y = 0;
    const { result, order } = await run(
      {
        nodes: [
          n('Start', 'test.trigger'),
          n('Branch', 'test.branch'),
          n('TrueA', 'test.set'),
          n('TrueB', 'test.set'),
          n('FalseA', 'test.set'),
        ],
        connections: [c('Start', 'Branch'), c('Branch', 'TrueA', 0), c('TrueA', 'TrueB'), c('Branch', 'FalseA', 1)],
      },
      { options: { triggerItems: [{ json: { ok: true } }, { json: { ok: false } }] } },
    );
    expect(result.status).toBe('success');
    expect(order).toEqual(['Start', 'Branch', 'TrueA', 'TrueB', 'FalseA']);
    expect(out(result, 'Branch', 0)).toEqual([{ ok: true }]);
    expect(out(result, 'Branch', 1)).toEqual([{ ok: false }]);
  });

  it('does not run children of empty outputs unless alwaysOutputData is set', async () => {
    const { result, order } = await run({
      nodes: [n('Start', 'test.trigger'), n('Empty', 'test.empty'), n('After', 'test.set')],
      connections: [c('Start', 'Empty'), c('Empty', 'After')],
    });
    expect(order).toEqual(['Start', 'Empty']);
    expect(result.status).toBe('success');

    const second = await run({
      nodes: [n('Start', 'test.trigger'), n('Empty', 'test.empty', { alwaysOutputData: true }), n('After', 'test.set')],
      connections: [c('Start', 'Empty'), c('Empty', 'After')],
    });
    expect(second.order).toEqual(['Start', 'Empty', 'After']);
  });

  it('waits for all inputs of multi-input nodes', async () => {
    const { result, order } = await run({
      nodes: [
        n('Start', 'test.trigger'),
        n('Left', 'test.set', { parameters: { field: 'side', value: 'left' } }),
        n('Right', 'test.set', { parameters: { field: 'side', value: 'right' } }),
        n('Merge', 'test.merge'),
      ],
      connections: [c('Start', 'Left'), c('Start', 'Right'), c('Left', 'Merge', 0, 0), c('Right', 'Merge', 0, 1)],
    });
    expect(order.filter((x) => x === 'Merge')).toHaveLength(1);
    expect(out(result, 'Merge')).toEqual([{ side: 'left' }, { side: 'right' }, { inputs: 2 }]);
  });

  it('runs a multi-input node with partial data when a branch produced nothing', async () => {
    const { result } = await run(
      {
        nodes: [n('Start', 'test.trigger'), n('Branch', 'test.branch'), n('Merge', 'test.merge')],
        connections: [c('Start', 'Branch'), c('Branch', 'Merge', 0, 0), c('Branch', 'Merge', 1, 1)],
      },
      { options: { triggerItems: [{ json: { ok: true } }] } },
    );
    expect(out(result, 'Merge')).toEqual([{ ok: true }, { inputs: 1 }]);
  });

  it('stops on error, records it and can be retried from the failed node', async () => {
    const flakyNode = flaky(1);
    const types = registry([flakyNode.node]);
    const wf = {
      nodes: [
        n('Start', 'test.trigger'),
        n('A', 'test.set', { parameters: { field: 'a', value: 1 } }),
        n('Flaky', 'test.flaky'),
        n('After', 'test.set', { parameters: { field: 'done', value: true } }),
      ],
      connections: [c('Start', 'A'), c('A', 'Flaky'), c('Flaky', 'After')],
    };
    const first = await run(wf, { types });
    expect(first.result.status).toBe('error');
    expect(first.result.data.resultData.error?.message).toBe('Attempt 1 failed');
    expect(first.result.data.resultData.error?.node).toBe('Flaky');
    expect(first.result.data.executionData?.nodeExecutionStack[0]?.nodeId).toBe('Flaky');

    const retry = await run(wf, { types, options: { resumeFrom: first.result.data } });
    expect(retry.order).toEqual(['Flaky', 'After']);
    expect(retry.result.status).toBe('success');
    expect(out(retry.result, 'After')).toEqual([{ a: 1, attempts: 2, done: true }]);
    expect(retry.result.data.resultData.runData.Flaky).toHaveLength(1);
  });

  it('retries a node when retryOnFail is set', async () => {
    const flakyNode = flaky(2);
    const { result } = await run(
      {
        nodes: [n('Start', 'test.trigger'), n('Flaky', 'test.flaky', { retryOnFail: true, maxTries: 3, waitBetweenTries: 1 })],
        connections: [c('Start', 'Flaky')],
      },
      { types: registry([flakyNode.node]) },
    );
    expect(result.status).toBe('success');
    expect(flakyNode.calls()).toBe(3);
  });

  it('continues with the regular output on error', async () => {
    const { result } = await run({
      nodes: [n('Start', 'test.trigger'), n('Fail', 'test.fail', { onError: 'continueRegularOutput' }), n('After', 'test.set')],
      connections: [c('Start', 'Fail'), c('Fail', 'After')],
    });
    expect(result.status).toBe('success');
    expect(out(result, 'After')).toEqual([{ error: 'Boom', errorDescription: 'it failed', value: '' }]);
  });

  it('routes failures to the error output', async () => {
    const { result } = await run(
      {
        nodes: [
          n('Start', 'test.trigger'),
          n('Partial', 'test.partialFail', { onError: 'continueErrorOutput' }),
          n('Ok', 'test.set', { parameters: { field: 'branch', value: 'ok' } }),
          n('Err', 'test.set', { parameters: { field: 'branch', value: 'error' } }),
        ],
        connections: [c('Start', 'Partial'), c('Partial', 'Ok', 0), c('Partial', 'Err', 1)],
      },
      { options: { triggerItems: [{ json: { ok: true } }, { json: { ok: false } }] } },
    );
    expect(out(result, 'Ok')).toEqual([{ ok: true, branch: 'ok' }]);
    expect(out(result, 'Err')).toEqual([{ ok: false, branch: 'error' }]);
  });

  it('passes data through disabled nodes', async () => {
    const { result } = await run({
      nodes: [n('Start', 'test.trigger'), n('Fail', 'test.fail', { disabled: true }), n('After', 'test.set')],
      connections: [c('Start', 'Fail'), c('Fail', 'After')],
    });
    expect(result.status).toBe('success');
    expect(out(result, 'After')).toEqual([{ value: '' }]);
  });

  it('uses pinned data instead of executing the node', async () => {
    const { result } = await run({
      nodes: [n('Start', 'test.trigger'), n('Fail', 'test.fail'), n('After', 'test.set')],
      connections: [c('Start', 'Fail'), c('Fail', 'After')],
      pinData: { Fail: [{ json: { pinned: true } }] },
    });
    expect(result.status).toBe('success');
    expect(out(result, 'After')).toEqual([{ pinned: true, value: '' }]);
  });

  it('only runs ancestors of the destination node', async () => {
    const { order } = await run(
      {
        nodes: [n('Start', 'test.trigger'), n('A', 'test.set'), n('B', 'test.set'), n('Other', 'test.set')],
        connections: [c('Start', 'A'), c('A', 'B'), c('Start', 'Other')],
      },
      { options: { destinationNode: 'A' } },
    );
    expect(order).toEqual(['Start', 'A']);
  });

  it('can be cancelled', async () => {
    const executor = new WorkflowExecute(
      new Workflow({
        name: 't',
        nodes: [n('Start', 'test.trigger'), n('Slow', 'test.slow')],
        connections: [c('Start', 'Slow')],
      }),
      createAdditionalData({ executionId: 'x', mode: 'manual', nodeTypes: registry() }),
    );
    const promise = executor.run();
    setTimeout(() => executor.cancel(), 50);
    const result = await promise;
    expect(result.status).toBe('canceled');
    expect(result.data.resultData.runData.Slow![0]!.executionStatus).toBe('canceled');
  });

  it('enforces the workflow timeout', async () => {
    const { result } = await run({
      nodes: [n('Start', 'test.trigger'), n('Slow', 'test.slow')],
      connections: [c('Start', 'Slow')],
      settings: { executionTimeout: 1 },
    });
    expect(result.status).toBe('error');
    expect(result.data.resultData.error?.message).toMatch(/timed out after 1 seconds/);
  }, 10_000);

  it('protects against infinite loops', async () => {
    const executor = new WorkflowExecute(
      new Workflow({
        name: 'loop',
        nodes: [n('Start', 'test.trigger'), n('A', 'test.set'), n('B', 'test.set')],
        connections: [c('Start', 'A'), c('A', 'B'), c('B', 'A')],
      }),
      createAdditionalData({ executionId: 'x', mode: 'manual', nodeTypes: registry(), maxNodeRuns: 50 }),
    );
    const result = await executor.run();
    expect(result.status).toBe('error');
    expect(result.data.resultData.error?.message).toMatch(/infinite loop/);
  });

  it('reports unknown node types clearly', async () => {
    const { result } = await run({
      nodes: [n('Start', 'test.trigger'), n('Mystery', 'acme.mystery')],
      connections: [c('Start', 'Mystery')],
    });
    expect(result.status).toBe('error');
    expect(result.data.resultData.error?.message).toBe('Unknown node type "acme.mystery"');
  });

  it('fails clearly when there is no trigger', async () => {
    const { result } = await run({ nodes: [], connections: [] });
    expect(result.status).toBe('error');
    expect(result.data.resultData.error?.message).toMatch(/no trigger node/);
  });

  it('calls hooks in order', async () => {
    const events: string[] = [];
    await run(
      {
        nodes: [n('Start', 'test.trigger'), n('A', 'test.set')],
        connections: [c('Start', 'A')],
      },
      {
        hooks: {
          workflowExecuteBefore: () => void events.push('before'),
          nodeExecuteAfter: (name, task) => void events.push(`${name}:${task.executionStatus}`),
          workflowExecuteAfter: (r) => void events.push(`after:${r.status}`),
        },
      },
    );
    expect(events).toEqual(['before', 'Start:success', 'A:success', 'after:success']);
  });

  it('reports expression errors with the parameter name', async () => {
    const { result } = await run({
      nodes: [n('Start', 'test.trigger'), n('A', 'test.set', { parameters: { value: '={{ $json.a * 2 }}' } })],
      connections: [c('Start', 'A')],
    });
    expect(result.status).toBe('error');
    expect(result.data.resultData.error).toMatchObject({
      name: 'ExpressionError',
      node: 'A',
      description: 'Problem in parameter "Value" for item 0',
    });
  });

  it('does not let hook failures break the run result', async () => {
    const spy = vi.fn(() => {
      throw new Error('db down');
    });
    const { result } = await run(
      { nodes: [n('Start', 'test.trigger')], connections: [] },
      { hooks: { workflowExecuteAfter: spy } },
    );
    expect(spy).toHaveBeenCalled();
    expect(result.status).toBe('success');
  });
});
