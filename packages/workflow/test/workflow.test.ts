import { describe, expect, it } from 'vitest';
import {
  SimpleExpressionEvaluator,
  Workflow,
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

describe('expressions', () => {
  const evaluator = new SimpleExpressionEvaluator();
  const data: ExpressionData = {
    item: {
      json: { name: 'Asha', phone: '+919999999999', order: { id: 42, items: ['tea', 'cake'] } },
    },
    itemIndex: 0,
    runIndex: 0,
    inputItems: [{ json: { name: 'Asha' } }, { json: { name: 'Ravi' } }],
    getNodeOutput: (name) => (name === 'Lookup' ? [{ json: { customer: 'Asha K' } }] : undefined),
    workflow: { id: 'w1', name: 'Receptionist' },
    execution: { id: 'e1', mode: 'manual' },
    parameters: {},
    timezone: 'Asia/Kolkata',
    vars: { BUSINESS: 'Chai Point' },
  };
  const ev = (expr: string) => evaluateExpression(expr, data, evaluator);

  it('splits templates', () => {
    expect(splitTemplate('Hi {{ $json.name }}!')).toEqual([
      { kind: 'text', value: 'Hi ' },
      { kind: 'code', value: '$json.name' },
      { kind: 'text', value: '!' },
    ]);
  });
  it('returns raw values for single blocks', () => {
    expect(ev('={{ $json.order.id }}')).toBe(42);
    expect(ev('={{ $json.order.items }}')).toEqual(['tea', 'cake']);
    expect(ev('={{ $json.order.items[1] }}')).toBe('cake');
  });
  it('interpolates templates', () => {
    expect(ev('=Hello {{ $json.name }}, order {{ $json.order.id }}')).toBe('Hello Asha, order 42');
    expect(ev('=Items: {{ $json.order.items }}')).toBe('Items: ["tea","cake"]');
  });
  it('references other nodes and context', () => {
    expect(ev('={{ $node["Lookup"].json.customer }}')).toBe('Asha K');
    expect(ev("={{ $('Lookup').item.json.customer }}")).toBe('Asha K');
    expect(ev('={{ $input.last().json.name }}')).toBe('Ravi');
    expect(ev('={{ $workflow.name }}')).toBe('Receptionist');
    expect(ev('={{ $vars.BUSINESS }}')).toBe('Chai Point');
  });
  it('supports $now', () => {
    expect(typeof ev('={{ $now }}')).toBe('string');
    expect(ev("={{ $now.toFormat('yyyy') }}")).toBe(String(new Date().getFullYear()));
  });
  it('gives a helpful error for unsupported code and missing nodes', () => {
    expect(() => ev('={{ $json.a + 1 }}')).toThrow(/Unsupported expression/);
    expect(() => ev('={{ $node["Nope"].json.x }}')).toThrow(/has not been executed/);
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
