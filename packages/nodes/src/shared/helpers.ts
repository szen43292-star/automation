import { DateTime } from 'luxon';
import {
  NodeOperationError,
  toNodeErrorJSON,
  type FilterOptions,
  type FilterValue,
  type IExecuteFunctions,
  type INodeExecutionData,
  type INodeProperties,
} from '@flowforge/workflow';

/** Standard "conditions" parameter used by IF and Filter. */
export const conditionsProperty: INodeProperties = {
  displayName: 'Conditions',
  name: 'conditions',
  type: 'filter',
  default: {
    combinator: 'and',
    conditions: [
      {
        id: 'c1',
        leftValue: '',
        rightValue: '',
        operator: { type: 'string', operation: 'equals' },
      },
    ],
  },
};

export const conditionOptionsProperties: INodeProperties[] = [
  {
    displayName: 'Convert Types Where Required',
    name: 'looseTypeValidation',
    type: 'boolean',
    default: false,
    description: 'Try to convert values (e.g. the string "5" to the number 5) instead of failing on a type mismatch',
  },
  {
    displayName: 'Options',
    name: 'options',
    type: 'collection',
    default: {},
    placeholder: 'Add option',
    options: [
      {
        displayName: 'Ignore Case',
        name: 'ignoreCase',
        type: 'boolean',
        default: true,
        description: 'Whether to ignore letter case when comparing strings',
      },
    ],
  },
];

export function getFilterParameters(
  ctx: IExecuteFunctions,
  itemIndex: number,
): { filter: FilterValue; options: FilterOptions } {
  const filter = ctx.getNodeParameter<FilterValue>('conditions', itemIndex);
  const loose = ctx.getNodeParameter<boolean>('looseTypeValidation', itemIndex, false);
  const ignoreCase = ctx.getNodeParameter<boolean>('options.ignoreCase', itemIndex, true);
  return {
    filter,
    options: { caseSensitive: !ignoreCase, typeValidation: loose ? 'loose' : 'strict' },
  };
}

/** Item for "continue on fail": keeps the input data and attaches the error. */
export function errorItem(
  ctx: IExecuteFunctions,
  error: unknown,
  itemIndex: number,
  item?: INodeExecutionData,
): INodeExecutionData {
  const json = toNodeErrorJSON(error, ctx.getNode().name);
  return {
    json: { ...(item?.json ?? {}), error: json.message },
    pairedItem: { item: itemIndex },
    error: { ...json, itemIndex },
  };
}

/** Wrap anything thrown inside a node into a NodeOperationError tied to the item. */
export function wrapItemError(ctx: IExecuteFunctions, error: unknown, itemIndex: number): Error {
  if (error instanceof NodeOperationError) return error;
  if (error instanceof Error && error.name.startsWith('Node')) return error;
  if (error instanceof Error && error.name === 'ExpressionError') return error;
  return new NodeOperationError(ctx.getNode(), error instanceof Error ? error.message : String(error), {
    itemIndex,
    cause: error,
  });
}

/** Parse ISO strings, epoch millis, JS dates and luxon DateTimes. */
export function parseDate(value: unknown, zone: string): DateTime | null {
  if (value === null || value === undefined || value === '') return null;
  if (DateTime.isDateTime(value)) return value.setZone(zone);
  if (value instanceof Date) return DateTime.fromJSDate(value, { zone });
  if (typeof value === 'number') {
    // Treat 10-digit numbers as seconds.
    return DateTime.fromMillis(value < 1e11 ? value * 1000 : value, { zone });
  }
  if (typeof value === 'string') {
    if (/^\d+$/.test(value)) return parseDate(Number(value), zone);
    const iso = DateTime.fromISO(value, { zone, setZone: true });
    if (iso.isValid) return iso.setZone(zone);
    for (const parser of [DateTime.fromRFC2822, DateTime.fromHTTP, DateTime.fromSQL]) {
      const parsed = parser(value, { zone });
      if (parsed.isValid) return parsed;
    }
    const js = new Date(value);
    if (!Number.isNaN(js.getTime())) return DateTime.fromJSDate(js, { zone });
  }
  return null;
}
