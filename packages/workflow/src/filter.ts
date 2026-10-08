import { DateTime } from 'luxon';
import { typeOf } from './utils';

/**
 * Structured conditions used by IF, Filter and (later) Switch nodes.
 * Shared by the engine (evaluation) and the editor (operator catalogue).
 */

export type FilterOperatorType = 'string' | 'number' | 'boolean' | 'dateTime' | 'array' | 'object';

export interface FilterOperator {
  type: FilterOperatorType;
  operation: string;
}

export interface FilterCondition {
  id: string;
  leftValue: unknown;
  rightValue?: unknown;
  operator: FilterOperator;
}

export interface FilterValue {
  combinator: 'and' | 'or';
  conditions: FilterCondition[];
}

export interface FilterOptions {
  caseSensitive: boolean;
  /** `strict` errors on type mismatches, `loose` converts ("5" → 5). */
  typeValidation: 'strict' | 'loose';
}

interface OperatorDef {
  operation: string;
  label: string;
  /** No right-hand value needed. */
  singleValue?: boolean;
}

const COMMON: OperatorDef[] = [
  { operation: 'exists', label: 'exists', singleValue: true },
  { operation: 'notExists', label: 'does not exist', singleValue: true },
  { operation: 'empty', label: 'is empty', singleValue: true },
  { operation: 'notEmpty', label: 'is not empty', singleValue: true },
];

export const FILTER_OPERATORS: Record<FilterOperatorType, OperatorDef[]> = {
  string: [
    ...COMMON,
    { operation: 'equals', label: 'is equal to' },
    { operation: 'notEquals', label: 'is not equal to' },
    { operation: 'contains', label: 'contains' },
    { operation: 'notContains', label: 'does not contain' },
    { operation: 'startsWith', label: 'starts with' },
    { operation: 'notStartsWith', label: 'does not start with' },
    { operation: 'endsWith', label: 'ends with' },
    { operation: 'notEndsWith', label: 'does not end with' },
    { operation: 'regex', label: 'matches regex' },
    { operation: 'notRegex', label: 'does not match regex' },
  ],
  number: [
    ...COMMON,
    { operation: 'equals', label: 'is equal to' },
    { operation: 'notEquals', label: 'is not equal to' },
    { operation: 'gt', label: 'is greater than' },
    { operation: 'lt', label: 'is less than' },
    { operation: 'gte', label: 'is greater than or equal to' },
    { operation: 'lte', label: 'is less than or equal to' },
  ],
  dateTime: [
    ...COMMON,
    { operation: 'equals', label: 'is equal to' },
    { operation: 'notEquals', label: 'is not equal to' },
    { operation: 'after', label: 'is after' },
    { operation: 'before', label: 'is before' },
    { operation: 'afterOrEquals', label: 'is after or equal to' },
    { operation: 'beforeOrEquals', label: 'is before or equal to' },
  ],
  boolean: [
    ...COMMON,
    { operation: 'true', label: 'is true', singleValue: true },
    { operation: 'false', label: 'is false', singleValue: true },
    { operation: 'equals', label: 'is equal to' },
    { operation: 'notEquals', label: 'is not equal to' },
  ],
  array: [
    ...COMMON,
    { operation: 'contains', label: 'contains' },
    { operation: 'notContains', label: 'does not contain' },
    { operation: 'lengthEquals', label: 'length equal to' },
    { operation: 'lengthNotEquals', label: 'length not equal to' },
    { operation: 'lengthGt', label: 'length greater than' },
    { operation: 'lengthLt', label: 'length less than' },
  ],
  object: [...COMMON],
};

export function isSingleValueOperator(op: FilterOperator): boolean {
  return FILTER_OPERATORS[op.type]?.find((o) => o.operation === op.operation)?.singleValue === true;
}

export class FilterError extends Error {
  constructor(
    message: string,
    readonly conditionIndex: number,
  ) {
    super(message);
    this.name = 'FilterError';
  }
}

export function evaluateFilter(filter: FilterValue, options: FilterOptions): boolean {
  const conditions = filter.conditions ?? [];
  if (conditions.length === 0) return true;
  const results = conditions.map((condition, index) =>
    evaluateCondition(condition, options, index),
  );
  return filter.combinator === 'or' ? results.some(Boolean) : results.every(Boolean);
}

function isEmptyValue(value: unknown): boolean {
  if (value === undefined || value === null || value === '') return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value as object).length === 0;
  return false;
}

export function evaluateCondition(
  condition: FilterCondition,
  options: FilterOptions,
  index = 0,
): boolean {
  const { operator } = condition;
  const { operation } = operator;

  switch (operation) {
    case 'exists':
      return condition.leftValue !== undefined && condition.leftValue !== null;
    case 'notExists':
      return condition.leftValue === undefined || condition.leftValue === null;
    case 'empty':
      return isEmptyValue(condition.leftValue);
    case 'notEmpty':
      return !isEmptyValue(condition.leftValue);
  }

  const left = coerce(condition.leftValue, operator.type, options, index, 'left');
  const right = isSingleValueOperator(operator)
    ? undefined
    : operator.type === 'array' && operation.startsWith('length')
      ? coerce(
          condition.rightValue,
          'number',
          { ...options, typeValidation: 'loose' },
          index,
          'right',
        )
      : operator.type === 'array'
        ? condition.rightValue
        : // The right-hand side is usually a literal typed in the editor ("5"), so always convert it.
          coerce(
            condition.rightValue,
            operator.type,
            { ...options, typeValidation: 'loose' },
            index,
            'right',
          );

  switch (operator.type) {
    case 'string': {
      let l = (left as string | null) ?? '';
      let r = (right as string | null) ?? '';
      if (!options.caseSensitive && !operation.toLowerCase().includes('regex')) {
        l = l.toLowerCase();
        r = r.toLowerCase();
      }
      switch (operation) {
        case 'equals':
          return l === r;
        case 'notEquals':
          return l !== r;
        case 'contains':
          return l.includes(r);
        case 'notContains':
          return !l.includes(r);
        case 'startsWith':
          return l.startsWith(r);
        case 'notStartsWith':
          return !l.startsWith(r);
        case 'endsWith':
          return l.endsWith(r);
        case 'notEndsWith':
          return !l.endsWith(r);
        case 'regex':
          return toRegex(r, options, index).test(l);
        case 'notRegex':
          return !toRegex(r, options, index).test(l);
      }
      break;
    }
    case 'number': {
      const l = left as number | null;
      const r = right as number | null;
      switch (operation) {
        case 'equals':
          return l === r;
        case 'notEquals':
          return l !== r;
      }
      if (l === null || r === null) return false;
      switch (operation) {
        case 'gt':
          return l > r;
        case 'lt':
          return l < r;
        case 'gte':
          return l >= r;
        case 'lte':
          return l <= r;
      }
      break;
    }
    case 'dateTime': {
      const l = (left as DateTime | null)?.toMillis() ?? null;
      const r = (right as DateTime | null)?.toMillis() ?? null;
      switch (operation) {
        case 'equals':
          return l === r;
        case 'notEquals':
          return l !== r;
      }
      if (l === null || r === null) return false;
      switch (operation) {
        case 'after':
          return l > r;
        case 'before':
          return l < r;
        case 'afterOrEquals':
          return l >= r;
        case 'beforeOrEquals':
          return l <= r;
      }
      break;
    }
    case 'boolean': {
      switch (operation) {
        case 'true':
          return left === true;
        case 'false':
          return left === false;
        case 'equals':
          return left === right;
        case 'notEquals':
          return left !== right;
      }
      break;
    }
    case 'array': {
      const l = (left as unknown[] | null) ?? [];
      switch (operation) {
        case 'contains':
          return l.some((v) => looseEquals(v, right));
        case 'notContains':
          return !l.some((v) => looseEquals(v, right));
        case 'lengthEquals':
          return l.length === right;
        case 'lengthNotEquals':
          return l.length !== right;
        case 'lengthGt':
          return l.length > (right as number);
        case 'lengthLt':
          return l.length < (right as number);
      }
      break;
    }
  }
  throw new FilterError(`Unknown operator "${operator.type}.${operation}"`, index);
}

function looseEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === 'object' || typeof b === 'object')
    return JSON.stringify(a) === JSON.stringify(b);
  return String(a) === String(b);
}

function toRegex(pattern: string, options: FilterOptions, index: number): RegExp {
  const m = /^\/(.+)\/([gimsuy]*)$/s.exec(pattern);
  try {
    if (m) return new RegExp(m[1]!, m[2]!.replace('g', ''));
    return new RegExp(pattern, options.caseSensitive ? '' : 'i');
  } catch {
    throw new FilterError(`Invalid regular expression "${pattern}"`, index);
  }
}

function coerce(
  value: unknown,
  type: FilterOperatorType,
  options: FilterOptions,
  index: number,
  side: 'left' | 'right',
): unknown {
  if (value === undefined || value === null) return null;
  const strict = options.typeValidation === 'strict';
  const fail = (): never => {
    throw new FilterError(
      `Wrong type: '${preview(value)}' is ${article(typeOf(value))} but was expecting ${article(type)} ` +
        `(condition ${index + 1}, ${side} value). Switch "Convert types where required" on to convert it automatically.`,
      index,
    );
  };

  switch (type) {
    case 'string':
      if (typeof value === 'string') return value;
      if (strict) fail();
      return typeof value === 'object' ? JSON.stringify(value) : String(value);
    case 'number': {
      if (typeof value === 'number') return value;
      if (value === '' && !strict) return null;
      if (strict) fail();
      const n = Number(value);
      if (Number.isNaN(n)) fail();
      return n;
    }
    case 'boolean': {
      if (typeof value === 'boolean') return value;
      if (strict) fail();
      if (value === 'true' || value === 1 || value === '1') return true;
      if (value === 'false' || value === 0 || value === '0' || value === '') return false;
      return fail();
    }
    case 'dateTime': {
      if (DateTime.isDateTime(value)) return value;
      if (value instanceof Date) return DateTime.fromJSDate(value);
      if (typeof value === 'number') return DateTime.fromMillis(value);
      if (typeof value === 'string') {
        if (value === '') return null;
        const d = DateTime.fromISO(value);
        if (d.isValid) return d;
        const d2 = DateTime.fromJSDate(new Date(value));
        if (d2.isValid) return d2;
      }
      return fail();
    }
    case 'array': {
      if (Array.isArray(value)) return value;
      if (!strict && typeof value === 'string') {
        try {
          const parsed = JSON.parse(value);
          if (Array.isArray(parsed)) return parsed;
        } catch {
          /* fall through */
        }
      }
      return fail();
    }
    case 'object':
      if (typeof value === 'object') return value;
      return fail();
  }
}

function preview(value: unknown): string {
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return text.length > 40 ? `${text.slice(0, 40)}…` : text;
}

function article(word: string): string {
  return /^[aeiou]/i.test(word) ? `an ${word}` : `a ${word}`;
}
