import { describe, expect, it } from 'vitest';
import { getNodeParameters, type INodeParameters } from '@flowforge/workflow';
import { builtinNodes } from '../src';
import { errorOf, runNode } from './harness';

const cond = (leftValue: unknown, type: string, operation: string, rightValue?: unknown) =>
  ({
    combinator: 'and',
    conditions: [{ id: '1', leftValue, rightValue, operator: { type, operation } }],
  }) as unknown as INodeParameters;

describe('node descriptions', () => {
  it('are unique, complete and produce valid default parameters', () => {
    const names = new Set<string>();
    for (const node of builtinNodes) {
      const d = node.description;
      expect(names.has(d.name), d.name).toBe(false);
      names.add(d.name);
      expect(d.displayName && d.icon && d.description && d.defaults.name, d.name).toBeTruthy();
      expect(() => getNodeParameters(d.properties, {})).not.toThrow();
      // Descriptions are sent to the editor, so they must survive JSON.
      expect(JSON.parse(JSON.stringify(d))).toEqual(d);
    }
  });
});

describe('If', () => {
  it('routes items to true and false outputs', async () => {
    const { run, output } = await runNode(
      'flowforge.if',
      { conditions: cond('={{ $json.amount }}', 'number', 'gt', 100) },
      [{ amount: 50 }, { amount: 500 }],
    );
    expect(run.status).toBe('success');
    expect(output(0)).toEqual([{ amount: 500 }]);
    expect(output(1)).toEqual([{ amount: 50 }]);
  });

  it('explains type errors and supports loose conversion', async () => {
    const strict = await runNode(
      'flowforge.if',
      { conditions: cond('={{ $json.amount }}', 'number', 'gt', 100) },
      [{ amount: '500' }],
    );
    expect(errorOf(strict.run)?.message).toMatch(
      /Wrong type: '500' is a string but was expecting a number/,
    );

    const loose = await runNode(
      'flowforge.if',
      { conditions: cond('={{ $json.amount }}', 'number', 'gt', 100), looseTypeValidation: true },
      [{ amount: '500' }],
    );
    expect(loose.output(0)).toEqual([{ amount: '500' }]);
  });
});

describe('Filter', () => {
  it('keeps matching items (case-insensitive by default)', async () => {
    const { output } = await runNode(
      'flowforge.filter',
      { conditions: cond('={{ $json.city }}', 'string', 'equals', 'pune') },
      [{ city: 'Pune' }, { city: 'Delhi' }],
    );
    expect(output()).toEqual([{ city: 'Pune' }]);
  });
});

describe('Edit Fields', () => {
  it('sets typed fields with dot notation', async () => {
    const { output } = await runNode(
      'flowforge.set',
      {
        mode: 'manual',
        assignments: {
          assignments: [
            { id: '1', name: 'customer.name', value: '={{ $json.name }}', type: 'string' },
            { id: '2', name: 'total', value: '42.5', type: 'number' },
            { id: '3', name: 'vip', value: 'true', type: 'boolean' },
            { id: '4', name: 'tags', value: '["a","b"]', type: 'array' },
          ],
        },
      },
      [{ name: 'Asha', other: 1 }],
    );
    expect(output()).toEqual([
      { customer: { name: 'Asha' }, total: 42.5, vip: true, tags: ['a', 'b'] },
    ]);
  });

  it('can include other fields and use raw JSON', async () => {
    const { output } = await runNode(
      'flowforge.set',
      { mode: 'raw', jsonOutput: '{"status": "done"}', includeOtherFields: true },
      [{ id: 7 }],
    );
    expect(output()).toEqual([{ id: 7, status: 'done' }]);
  });

  it('reports bad conversions', async () => {
    const { run } = await runNode('flowforge.set', {
      assignments: { assignments: [{ id: '1', name: 'n', value: 'abc', type: 'number' }] },
    });
    expect(errorOf(run)?.message).toMatch(/cannot be converted to number/);
  });
});

describe('Sort', () => {
  it('sorts by multiple fields with missing values last', async () => {
    const { output } = await runNode(
      'flowforge.sort',
      {
        sortFieldsUi: {
          sortField: [
            { fieldName: 'group', order: 'ascending' },
            { fieldName: 'score', order: 'descending' },
          ],
        },
      },
      [
        { group: 'b', score: 1 },
        { group: 'a', score: 2 },
        { group: 'a', score: 10 },
        { score: 99 },
      ],
    );
    expect(output()).toEqual([
      { group: 'a', score: 10 },
      { group: 'a', score: 2 },
      { group: 'b', score: 1 },
      { score: 99 },
    ]);
  });
});

describe('Aggregate', () => {
  it('aggregates individual fields', async () => {
    const { output } = await runNode(
      'flowforge.aggregate',
      {
        aggregate: 'aggregateIndividualFields',
        fieldsToAggregate: {
          fieldToAggregate: [
            { fieldToAggregate: 'email', renameField: true, outputFieldName: 'emails' },
          ],
        },
      },
      [{ email: 'a@x.com' }, { email: 'b@x.com' }, {}],
    );
    expect(output()).toEqual([{ emails: ['a@x.com', 'b@x.com'] }]);
  });
  it('aggregates all item data', async () => {
    const { output } = await runNode('flowforge.aggregate', { aggregate: 'aggregateAllItemData' }, [
      { a: 1 },
      { a: 2 },
    ]);
    expect(output()).toEqual([{ data: [{ a: 1 }, { a: 2 }] }]);
  });
});

describe('Date & Time', () => {
  it('adds to a date in the given timezone', async () => {
    const { output } = await runNode('flowforge.dateTime', {
      operation: 'addToDate',
      magnitude: '2025-01-31T10:00:00Z',
      timeUnit: 'days',
      duration: 1,
      outputFieldName: 'next',
      options: { timezone: 'Asia/Kolkata', includeInputFields: false },
    });
    expect(output()).toEqual([{ next: '2025-02-01T15:30:00.000+05:30' }]);
  });
  it('formats and diffs dates', async () => {
    const formatted = await runNode('flowforge.dateTime', {
      operation: 'formatDate',
      magnitude: '2025-01-31T10:00:00Z',
      format: 'custom',
      customFormat: 'dd LLL yyyy',
      outputFieldName: 'pretty',
      options: { timezone: 'UTC' },
    });
    expect(formatted.output()).toEqual([{ pretty: '31 Jan 2025' }]);

    const diff = await runNode('flowforge.dateTime', {
      operation: 'getTimeBetweenDates',
      startDate: '2025-01-01',
      endDate: '2025-01-03T12:00:00',
      units: ['days', 'hours'],
      outputFieldName: 'gap',
    });
    expect(diff.output()).toEqual([{ gap: { days: 2, hours: 12 } }]);
  });
  it('rejects invalid dates with a clear message', async () => {
    const { run } = await runNode('flowforge.dateTime', {
      operation: 'formatDate',
      magnitude: 'not a date',
    });
    expect(errorOf(run)?.message).toBe('"not a date" is not a valid date');
  });
});

describe('Limit / Split Out / Stop and Error', () => {
  it('limits items', async () => {
    const { output } = await runNode('flowforge.limit', { maxItems: 2, keep: 'lastItems' }, [
      { i: 1 },
      { i: 2 },
      { i: 3 },
    ]);
    expect(output()).toEqual([{ i: 2 }, { i: 3 }]);
  });
  it('splits out lists', async () => {
    const { output } = await runNode(
      'flowforge.splitOut',
      { fieldToSplitOut: 'orders', include: 'allOtherFields', destinationFieldName: 'order' },
      [{ customer: 'Asha', orders: [{ id: 1 }, { id: 2 }] }],
    );
    expect(output()).toEqual([
      { customer: 'Asha', orders: [{ id: 1 }, { id: 2 }], order: { id: 1 } },
      { customer: 'Asha', orders: [{ id: 1 }, { id: 2 }], order: { id: 2 } },
    ]);
  });
  it('stops with a custom error', async () => {
    const { run } = await runNode('flowforge.stopAndError', { errorMessage: 'Caller is blocked' });
    expect(run.status).toBe('error');
    expect(errorOf(run)?.message).toBe('Caller is blocked');
  });
});
