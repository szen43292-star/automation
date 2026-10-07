import type { IDataObject, INodeExecutionData } from './interfaces';

/** Split a dotted / bracketed path: `a.b[0]["c d"]` → ['a','b','0','c d']. */
export function parsePath(path: string): string[] {
  const parts: string[] = [];
  const re = /\[\s*(?:"([^"]*)"|'([^']*)'|(\d+))\s*\]|([^.[\]]+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(path)) !== null) {
    const part = match[1] ?? match[2] ?? match[3] ?? match[4];
    if (part !== undefined && part !== '') parts.push(part);
  }
  return parts;
}

export function getPath(obj: unknown, path: string | string[]): unknown {
  const parts = Array.isArray(path) ? path : parsePath(path);
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

export function setPath(obj: IDataObject, path: string | string[], value: unknown): void {
  const parts = Array.isArray(path) ? path : parsePath(path);
  if (parts.length === 0) return;
  let current: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i]!;
    if (FORBIDDEN_KEYS.has(key)) throw new Error(`Invalid field name "${key}"`);
    const next = current[key];
    if (next === null || typeof next !== 'object') {
      current[key] = /^\d+$/.test(parts[i + 1]!) ? [] : {};
    }
    current = current[key] as Record<string, unknown>;
  }
  const last = parts[parts.length - 1]!;
  if (FORBIDDEN_KEYS.has(last)) throw new Error(`Invalid field name "${last}"`);
  current[last] = value;
}

export function unsetPath(obj: IDataObject, path: string): void {
  const parts = parsePath(path);
  const last = parts.pop();
  if (last === undefined) return;
  const parent = parts.length ? getPath(obj, parts) : obj;
  if (parent && typeof parent === 'object') delete (parent as Record<string, unknown>)[last];
}

export function deepClone<T>(value: T): T {
  return structuredClone(value);
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Wrap plain objects into `{ json }` items. */
export function toItems(data: unknown): INodeExecutionData[] {
  const list = Array.isArray(data) ? data : [data];
  return list.map((entry) => {
    if (isObject(entry) && isObject(entry.json)) return entry as unknown as INodeExecutionData;
    if (isObject(entry)) return { json: entry };
    return { json: { value: entry as unknown } };
  });
}

/**
 * Generate a node name that does not collide with existing names:
 * `HTTP Request` → `HTTP Request1` → `HTTP Request2` (same convention as n8n).
 */
export function uniqueNodeName(base: string, existing: Iterable<string>): string {
  const taken = new Set(existing);
  if (!taken.has(base)) return base;
  const stem = base.replace(/\d+$/, '');
  let i = 1;
  while (taken.has(`${stem}${i}`)) i++;
  return `${stem}${i}`;
}

export function randomId(): string {
  return globalThis.crypto.randomUUID();
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Human readable type name for error messages. */
export function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (value instanceof Date) return 'date';
  return typeof value;
}
