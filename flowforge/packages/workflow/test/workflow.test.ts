import { describe, expect, it } from 'vitest';
import {
  Workflow,
  applyCredentialAuthentication,
  referencedNodes,
  resolveNodeOutputs,
  resolvePairedItem,
  type IRunData,
  evaluateExpression,
  evaluateFilter,
  getNodeParameters,
  getPath,
  isPropertyVisible,
  parsePath,
  setPath,
  splitTemplate,
  uniqueNodeName,
  workflowCreateSchema,
  workflowUpdateSchema,
  workflowGraphSchema,
  type ExpressionData,
  type INode,
  type INodeProperties,
  type INodeTypeDescription,
} from '../src';

const node = (id: string, x = 0, y = 0, type = 'test.node'): INode => ({
  id,
  name: id.toUpperCase(),
  type,
  typeVersion: 1,
  position: [x, y],
  parameters: {},
});

describe('paths', () => {
  it('parses dotted and bracketed paths', () => {
    expect(parsePath('a.b[0]["c d"].e')).toEqual(['a', 'b', '0', 'c d', 'e']);
  });
  it('gets and sets nested values', () => {
    const obj: Record<string, unknown> = {};
    setPath(obj, 'customer.address.city', 'Pune');
    setPath(obj, 'tags[0]', 'vip');
    expect(obj).toEqual({ customer: { address: { city: 'Pune' } }, tags: ['vip'] });
    expect(getPath(obj, 'customer.address.city')).toBe('Pune');
    expect(getPath(obj, 'missing.deep')).toBeUndefined();
  });
  it('refuses prototype pollution', () => {
    expect(() => setPath({}, '__proto__.polluted', true)).toThrow(/Invalid field name/);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
  it('generates unique node names', () => {
    expect(uniqueNodeName('HTTP Request', ['HTTP Request'])).toBe('HTTP Request1');
    expect(uniqueNodeName('HTTP Request1', ['HTTP Request', 'HTTP Request1'])).toBe(
      'HTTP Request2',
    );
    expect(uniqueNodeName('Code', [])).toBe('Code');
  });
});

describe('Workflow graph', () => {
  const lookup = {
    getDescription: (type: string) =>
      (type === 'trigger'
        ? { group: ['trigger'] }
        : { group: ['core'] }) as unknown as INodeTypeDescription,
  };
  const wf = new Workflow({
    name: 'g',
    nodes: [
      node('t', 0, 0, 'trigger'),
      node('a', 200, 100),
      node('b', 200, -100),
      node('c', 400, 0),
    ],
    connections: [
      { source: 't', sourceOutput: 0, target: 'a', targetInput: 0 },
      { source: 't', sourceOutput: 0, target: 'b', targetInput: 0 },
      { source: 'a', sourceOutput: 0, target: 'c', targetInput: 0 },
      { source: 'b', sourceOutput: 0, target: 'c', targetInput: 0 },
    ],
  });

  it('orders children by canvas position', () => {
    expect(wf.getOutgoing('t').map((c) => c.target)).toEqual(['b', 'a']);
  });
  it('finds ancestors and descendants', () => {
    expect([...wf.getAncestors('c')].sort()).toEqual(['a', 'b', 't']);
    expect([...wf.getDescendants('t')].sort()).toEqual(['a', 'b', 'c']);
  });
  it('picks the trigger as start node', () => {
    expect(wf.getStartNode(lookup).id).toBe('t');
  });
  it('rejects duplicate names', () => {
    expect(
      () =>
        new Workflow({
          name: 'x',
          nodes: [node('a'), { ...node('b'), name: 'A' }],
          connections: [],
        }),
    ).toThrow(/Duplicate node name/);
  });
});

describe('schemas', () => {
  it('validates a workflow and applies defaults', () => {
    const parsed = workflowCreateSchema.parse({ name: ' Demo ' });
    expect(parsed).toMatchObject({ name: 'Demo', nodes: [], connections: [], settings: {} });
  });
  it('leaves omitted fields out of partial updates', () => {
    expect(workflowUpdateSchema.parse({ active: true })).toEqual({ active: true });
  });
  it('detects dangling connections and duplicate names', () => {
    const result = workflowGraphSchema.safeParse({
      nodes: [node('a'), { ...node('b'), name: 'A' }],
      connections: [{ source: 'a', sourceOutput: 0, target: 'zzz', targetInput: 0 }],
    });
    expect(result.success).toBe(false);
    const messages = result.error!.issues.map((i) => i.message);
    expect(messages).toContain('Duplicate node name "A" - node names must be unique');
    expect(messages).toContain('Connection references a node that does not exist');
  });
});

describe('expression helpers', () => {
  it('splits templates', () => {
    expect(splitTemplate('Hi {{ $json.name }}!')).toEqual([
      { kind: 'text', value: 'Hi ' },
      { kind: 'code', value: '$json.name' },
      { kind: 'text', value: '!' },
    ]);
    expect(splitTemplate('{{ "}}" + $json.a }}')).toEqual([
      { kind: 'code', value: '"}}" + $json.a' },
    ]);
  });
  it('finds referenced nodes', () => {
    expect(
      referencedNodes(`$('Lookup').item.json.x + $node["CRM Lead"].json.y + $node.Sheet.json`),
    ).toEqual(['Lookup', 'CRM Lead', 'Sheet']);
  });
  it('evaluates templates with any evaluator', () => {
    const data = { item: { json: { name: 'Asha' } } } as unknown as ExpressionData;
    const evaluator = {
      evaluate: (code: string, d: ExpressionData) =>
        code === '$json.name' ? d.item!.json.name : 42,
    };
    expect(evaluateExpression('={{ $json.name }}', data, evaluator)).toBe('Asha');
    expect(evaluateExpression('=Hi {{ $json.name }}, {{ x }}', data, evaluator)).toBe(
      'Hi Asha, 42',
    );
  });
  it('resolves paired items across nodes', () => {
    const runData: IRunData = {
      Start: [
        {
          startTime: 0,
          executionTime: 0,
          executionStatus: 'success',
          source: [null],
          data: { main: [[{ json: { id: 1 } }, { json: { id: 2 } }]] },
        },
      ],
      Split: [
        {
          startTime: 0,
          executionTime: 0,
          executionStatus: 'success',
          source: [{ previousNode: 'Start', previousNodeOutput: 0, previousNodeRun: 0 }],
          data: { main: [[{ json: { p: 'a' }, pairedItem: { item: 1 } }]] },
        },
      ],
    };
    const source = { previousNode: 'Split', previousNodeOutput: 0, previousNodeRun: 0 };
    expect(resolvePairedItem(runData, source, 0, 'Start')).toEqual({
      ok: true,
      item: { json: { id: 2 } },
    });
    expect(resolvePairedItem(runData, source, 0, 'Missing')).toEqual({
      ok: false,
      reason: 'notExecuted',
    });
  });
  it('computes dynamic outputs', () => {
    const d = {
      outputs: [{ type: 'main' as const }],
      dynamicOutputs: {
        modeParameter: 'mode',
        modes: {
          rules: {
            fromArray: 'rules.values',
            labelField: 'outputKey',
            labelToggle: 'renameOutput',
          },
          expression: { fromCount: 'numberOutputs' },
        },
        extra: { parameter: 'options.fallbackOutput', equals: 'extra', label: 'Fallback' },
      },
    };
    const rules = {
      mode: 'rules',
      rules: { values: [{ renameOutput: true, outputKey: 'Sales' }, {}] },
      options: { fallbackOutput: 'extra' },
    };
    expect(resolveNodeOutputs(d, rules as never).map((o) => o.displayName)).toEqual([
      'Sales',
      '1',
      'Fallback',
    ]);
    expect(resolveNodeOutputs(d, { mode: 'expression', numberOutputs: 3 }).length).toBe(3);
  });
  it('applies credentials to requests', () => {
    const creds = { name: 'X-Api-Key', value: 'secret', user: 'u', password: 'p' };
    expect(
      applyCredentialAuthentication(
        { type: 'header', name: '{{name}}', value: '{{value}}' },
        creds,
        { url: 'x' },
      ).headers,
    ).toEqual({ 'X-Api-Key': 'secret' });
    expect(
      applyCredentialAuthentication(
        { type: 'basic', username: '{{user}}', password: '{{password}}' },
        creds,
        { url: 'x' },
      ).headers,
    ).toEqual({
      authorization: `Basic ${Buffer.from('u:p').toString('base64')}`,
    });
    expect(() => applyCredentialAuthentication({ type: 'oauth2' }, {}, { url: 'x' })).toThrow(
      /not connected/,
    );
  });
});

describe('filter conditions', () => {
  const strict = { caseSensitive: true, typeValidation: 'strict' as const };
  const loose = { caseSensitive: false, typeValidation: 'loose' as const };
  const cond = (type: string, operation: string, leftValue: unknown, rightValue?: unknown) => ({
    combinator: 'and' as const,
    conditions: [{ id: '1', leftValue, rightValue, operator: { type: type as never, operation } }],
  });

  it('compares strings', () => {
    expect(evaluateFilter(cond('string', 'contains', 'Hello World', 'World'), strict)).toBe(true);
    expect(evaluateFilter(cond('string', 'equals', 'HELLO', 'hello'), strict)).toBe(false);
    expect(evaluateFilter(cond('string', 'equals', 'HELLO', 'hello'), loose)).toBe(true);
    expect(evaluateFilter(cond('string', 'regex', '+91 98765', '^\\+91'), strict)).toBe(true);
  });
  it('compares numbers and dates', () => {
    expect(evaluateFilter(cond('number', 'gt', 10, 5), strict)).toBe(true);
    expect(evaluateFilter(cond('number', 'gt', '10', 5), loose)).toBe(true);
    expect(() => evaluateFilter(cond('number', 'gt', '10', 5), strict)).toThrow(/Wrong type/);
    // Literal right-hand values typed in the editor are always converted.
    expect(evaluateFilter(cond('number', 'equals', 1, '1'), strict)).toBe(true);
    expect(() => evaluateFilter(cond('number', 'equals', 1, 'abc'), strict)).toThrow(
      /Wrong type: 'abc'/,
    );
    expect(evaluateFilter(cond('dateTime', 'after', '2025-02-01', '2025-01-01'), strict)).toBe(
      true,
    );
  });
  it('handles existence, arrays and combinators', () => {
    expect(evaluateFilter(cond('string', 'exists', undefined), strict)).toBe(false);
    expect(evaluateFilter(cond('array', 'contains', ['a', 'b'], 'b'), strict)).toBe(true);
    expect(evaluateFilter(cond('array', 'lengthGt', [1, 2, 3], 2), strict)).toBe(true);
    const or = {
      combinator: 'or' as const,
      conditions: [
        {
          id: '1',
          leftValue: 1,
          rightValue: 2,
          operator: { type: 'number' as const, operation: 'equals' },
        },
        { id: '2', leftValue: true, operator: { type: 'boolean' as const, operation: 'true' } },
      ],
    };
    expect(evaluateFilter(or, strict)).toBe(true);
  });
});

describe('parameters', () => {
  const props: INodeProperties[] = [
    { displayName: 'Method', name: 'method', type: 'options', default: 'GET' },
    { displayName: 'Send Body', name: 'sendBody', type: 'boolean', default: false },
    {
      displayName: 'Body',
      name: 'body',
      type: 'string',
      default: '',
      displayOptions: { show: { sendBody: [true] } },
    },
    {
      displayName: 'Hidden for GET',
      name: 'x',
      type: 'string',
      default: 'y',
      displayOptions: { hide: { method: ['GET'] } },
    },
  ];
  it('applies defaults for visible properties only', () => {
    expect(getNodeParameters(props, {})).toEqual({ method: 'GET', sendBody: false });
    expect(getNodeParameters(props, { sendBody: true, method: 'POST' })).toEqual({
      method: 'POST',
      sendBody: true,
      body: '',
      x: 'y',
    });
  });
  it('evaluates display options', () => {
    expect(isPropertyVisible({ show: { a: [1] } }, { a: 1 })).toBe(true);
    expect(isPropertyVisible({ show: { a: [1] } }, { a: 2 })).toBe(false);
    expect(isPropertyVisible({ hide: { a: [1] } }, { a: 1 })).toBe(false);
  });
});
