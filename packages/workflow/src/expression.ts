import { DateTime } from 'luxon';
import type {
  ExecutionMode,
  IDataObject,
  IBinaryData,
  INodeExecutionData,
  NodeParameterValueType,
} from './interfaces';
import { getPath, isObject, parsePath } from './utils';

/**
 * Expressions
 * -----------
 * A parameter value is an expression when it is a string starting with `=`,
 * e.g. `={{ $json.phone }}` or `=Hello {{ $json.name }}!`.
 *
 * The evaluator is pluggable: phase 1 ships `SimpleExpressionEvaluator`, a
 * safe path-only resolver. Phase 2 adds a full JavaScript evaluator running
 * inside an isolated-vm sandbox behind the same interface.
 */

export interface ExpressionData {
  /** Current item. */
  item: INodeExecutionData | undefined;
  itemIndex: number;
  runIndex: number;
  /** All items on input 0 of the current node. */
  inputItems: INodeExecutionData[];
  /** Output items of another node (last run, output 0 unless specified). */
  getNodeOutput(nodeName: string, outputIndex?: number, runIndex?: number): INodeExecutionData[] | undefined;
  workflow: { id?: string; name: string; active?: boolean };
  execution: { id: string; mode: ExecutionMode };
  /** Current node parameters (raw). */
  parameters: IDataObject;
  timezone: string;
  vars: IDataObject;
}

export interface IExpressionEvaluator {
  /** Evaluate the code inside a single `{{ … }}` block. */
  evaluate(code: string, data: ExpressionData): unknown;
}

export type TemplateSegment = { kind: 'text'; value: string } | { kind: 'code'; value: string };

export function isExpression(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('=');
}

/** Split `Hello {{ $json.name }}!` into text and code segments. */
export function splitTemplate(template: string): TemplateSegment[] {
  const segments: TemplateSegment[] = [];
  let index = 0;
  while (index < template.length) {
    const open = template.indexOf('{{', index);
    if (open === -1) {
      segments.push({ kind: 'text', value: template.slice(index) });
      break;
    }
    const close = findClosing(template, open + 2);
    if (close === -1) {
      segments.push({ kind: 'text', value: template.slice(index) });
      break;
    }
    if (open > index) segments.push({ kind: 'text', value: template.slice(index, open) });
    segments.push({ kind: 'code', value: template.slice(open + 2, close).trim() });
    index = close + 2;
  }
  return segments;
}

/** Find the matching `}}`, skipping over string literals. */
function findClosing(text: string, from: number): number {
  let quote: string | null = null;
  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') quote = ch;
    else if (ch === '}' && text[i + 1] === '}') return i;
  }
  return -1;
}

/** Evaluate an expression string (with leading `=`) for one item. */
export function evaluateExpression(
  expression: string,
  data: ExpressionData,
  evaluator: IExpressionEvaluator,
): unknown {
  const template = expression.startsWith('=') ? expression.slice(1) : expression;
  const segments = splitTemplate(template);
  // A single `{{ }}` block returns the raw value (number, object, …) instead of a string.
  if (segments.length === 1 && segments[0]!.kind === 'code') {
    return normaliseResult(evaluator.evaluate(segments[0]!.value, data));
  }
  return segments
    .map((segment) =>
      segment.kind === 'text' ? segment.value : stringify(normaliseResult(evaluator.evaluate(segment.value, data))),
    )
    .join('');
}

/** Recursively resolve every expression inside a parameter value. */
export function resolveParameterValue(
  value: NodeParameterValueType,
  data: ExpressionData,
  evaluator: IExpressionEvaluator,
): unknown {
  if (isExpression(value)) return evaluateExpression(value, data, evaluator);
  if (Array.isArray(value)) return value.map((v) => resolveParameterValue(v, data, evaluator));
  if (isObject(value)) {
    const out: IDataObject = {};
    for (const [key, v] of Object.entries(value)) {
      out[key] = resolveParameterValue(v as NodeParameterValueType, data, evaluator);
    }
    return out;
  }
  return value;
}

function normaliseResult(value: unknown): unknown {
  if (DateTime.isDateTime(value)) return value.toISO();
  if (value instanceof Date) return value.toISOString();
  return value;
}

function stringify(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

// ---------------------------------------------------------------------------
// Phase-1 evaluator: safe, path-only expressions (no arbitrary JavaScript)
// ---------------------------------------------------------------------------

export class ExpressionSyntaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExpressionSyntaxError';
  }
}

/**
 * Supports:
 *   $json.a.b[0]   $json["a b"]   $binary.data.fileName
 *   $node["Name"].json.x   $('Name').item.json.x   $('Name').first().json.x   $('Name').all()
 *   $input.item.json.x   $input.first().json.x   $input.all()
 *   $now  $today  $itemIndex  $runIndex  $workflow.name  $execution.id  $vars.X  $parameter.x
 *   string / number / boolean / null literals
 */
export class SimpleExpressionEvaluator implements IExpressionEvaluator {
  evaluate(code: string, data: ExpressionData): unknown {
    const src = code.trim();
    if (src === '') return undefined;

    const literal = parseLiteral(src);
    if (literal.ok) return literal.value;

    const match = /^(\$[A-Za-z_]*)(.*)$/s.exec(src);
    if (!match) throw unsupported(src);
    const [, root, restRaw] = match as unknown as [string, string, string];
    let rest = restRaw.trim();

    let base: unknown;
    switch (root) {
      case '$json':
        base = data.item?.json ?? {};
        break;
      case '$binary':
        base = (data.item?.binary ?? {}) as Record<string, IBinaryData>;
        break;
      case '$itemIndex':
        base = data.itemIndex;
        break;
      case '$runIndex':
        base = data.runIndex;
        break;
      case '$now':
        base = DateTime.now().setZone(data.timezone);
        break;
      case '$today':
        base = DateTime.now().setZone(data.timezone).startOf('day');
        break;
      case '$workflow':
        base = data.workflow;
        break;
      case '$execution':
        base = data.execution;
        break;
      case '$vars':
        base = data.vars;
        break;
      case '$parameter':
        base = data.parameters;
        break;
      case '$input': {
        const res = accessItems(data.inputItems, data.itemIndex, rest, src);
        base = res.value;
        rest = res.rest;
        break;
      }
      case '$node': {
        const m = /^\[\s*(["'])(.+?)\1\s*\](.*)$/s.exec(rest);
        if (!m) throw unsupported(src);
        const items = this.nodeItems(data, m[2]!);
        base = { json: items[data.itemIndex]?.json ?? items[0]?.json ?? {}, binary: items[data.itemIndex]?.binary };
        rest = m[3]!.trim();
        break;
      }
      case '$': {
        const m = /^\(\s*(["'])(.+?)\1\s*\)(.*)$/s.exec(rest);
        if (!m) throw unsupported(src);
        const res = accessItems(this.nodeItems(data, m[2]!), data.itemIndex, m[3]!.trim(), src);
        base = res.value;
        rest = res.rest;
        break;
      }
      default:
        throw unsupported(src);
    }

    if (rest === '') return base;
    // Luxon helpers commonly used on $now / $today.
    if (DateTime.isDateTime(base)) return dateAccess(base, rest, src);
    if (!/^(\.[A-Za-z_$][\w$]*|\[\s*(?:\d+|"[^"]*"|'[^']*')\s*\])+$/.test(rest)) throw unsupported(src);
    return getPath(base, parsePath(rest));
  }

  private nodeItems(data: ExpressionData, name: string): INodeExecutionData[] {
    const items = data.getNodeOutput(name);
    if (!items) {
      throw new ExpressionSyntaxError(
        `Referenced node "${name}" has not been executed yet (or does not exist). Make sure it runs before this node.`,
      );
    }
    return items;
  }
}

function accessItems(
  items: INodeExecutionData[],
  itemIndex: number,
  rest: string,
  src: string,
): { value: unknown; rest: string } {
  const m = /^\.(item|first\(\)|last\(\)|all\(\))(.*)$/s.exec(rest);
  if (!m) throw unsupported(src);
  const accessor = m[1];
  const tail = m[2]!.trim();
  if (accessor === 'all()') return { value: items.map((i) => i.json), rest: tail };
  const item =
    accessor === 'item' ? (items[itemIndex] ?? items[0]) : accessor === 'first()' ? items[0] : items[items.length - 1];
  return { value: item ?? { json: {} }, rest: tail };
}

function dateAccess(date: DateTime, rest: string, src: string): unknown {
  const m = /^\.(\w+)(?:\((.*)\))?$/s.exec(rest);
  if (!m) throw unsupported(src);
  const [, member, args] = m;
  switch (member) {
    case 'toISO':
      return date.toISO();
    case 'toISODate':
      return date.toISODate();
    case 'toMillis':
      return date.toMillis();
    case 'toSeconds':
      return Math.floor(date.toSeconds());
    case 'toFormat': {
      const fmt = parseLiteral((args ?? '').trim());
      if (!fmt.ok || typeof fmt.value !== 'string') throw unsupported(src);
      return date.toFormat(fmt.value);
    }
    case 'year':
    case 'month':
    case 'day':
    case 'hour':
    case 'minute':
    case 'second':
    case 'weekday':
      return date[member];
    default:
      throw unsupported(src);
  }
}

function parseLiteral(src: string): { ok: true; value: unknown } | { ok: false } {
  if (/^-?\d+(\.\d+)?$/.test(src)) return { ok: true, value: Number(src) };
  if (src === 'true') return { ok: true, value: true };
  if (src === 'false') return { ok: true, value: false };
  if (src === 'null') return { ok: true, value: null };
  const m = /^(["'])(.*)\1$/s.exec(src);
  if (m) return { ok: true, value: m[2]!.replace(/\\(.)/g, '$1') };
  return { ok: false };
}

function unsupported(src: string) {
  return new ExpressionSyntaxError(
    `Unsupported expression "{{ ${src} }}". This build supports data references such as ` +
      `{{ $json.field }}, {{ $node["Name"].json.field }}, {{ $('Name').item.json.field }} and {{ $now }}.`,
  );
}
