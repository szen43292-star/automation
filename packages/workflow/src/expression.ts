import type {
  ExecutionMode,
  IDataObject,
  INodeExecutionData,
  NodeParameterValueType,
} from './interfaces';
import type { PairedItemResult } from './pairedItem';
import { isObject } from './utils';

/**
 * Expressions
 * -----------
 * A parameter value is an expression when it is a string starting with `=`,
 * e.g. `={{ $json.phone }}` or `=Hello {{ $json.name }}!`.
 *
 * Expressions are JavaScript. On the server they run in an isolated-vm isolate
 * (`IsolatedExpressionEvaluator` in @flowforge/engine); the editor previews them
 * in a sandboxed iframe. Both load `EXPRESSION_RUNTIME`.
 */

export interface ExpressionData {
  /** Current item. */
  item: INodeExecutionData | undefined;
  itemIndex: number;
  runIndex: number;
  /** All items on input 0 of the current node. */
  inputItems: INodeExecutionData[];
  /** Output items of another node (last run, output 0 unless specified). */
  getNodeOutput(
    nodeName: string,
    outputIndex?: number,
    runIndex?: number,
  ): INodeExecutionData[] | undefined;
  /** Item of `nodeName` the given input item was derived from (via pairedItem links). */
  getPairedItem?(nodeName: string, itemIndex: number): PairedItemResult;
  workflow: { id?: string; name: string; active?: boolean };
  execution: { id: string; mode: ExecutionMode; resumeUrl?: string };
  /** Current node parameters (raw). */
  parameters: IDataObject;
  timezone: string;
  vars: IDataObject;
}

export interface IExpressionEvaluator {
  /** Evaluate the code inside a single `{{ … }}` block. */
  evaluate(code: string, data: ExpressionData): unknown;
  /** Release resources (e.g. the isolate) at the end of an execution. */
  dispose?(): void;
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
      segment.kind === 'text'
        ? segment.value
        : stringify(normaliseResult(evaluator.evaluate(segment.value, data))),
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
  if (value instanceof Date) return value.toISOString();
  return value;
}

function stringify(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
