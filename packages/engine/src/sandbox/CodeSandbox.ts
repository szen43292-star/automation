import ivm from 'isolated-vm';
import type { CodeMode, IDataObject, INodeExecutionData } from '@flowforge/workflow';

export interface CodeSandboxOptions {
  /** Memory limit of each isolate in MB. */
  memoryLimitMb?: number;
  /** Default wall-clock limit for one Code node run. */
  timeoutMs?: number;
}

export interface SandboxRunInput {
  code: string;
  mode: CodeMode;
  items: INodeExecutionData[];
  timeoutMs?: number;
  meta: {
    workflow: { id?: string; name: string; active: boolean };
    execution: { id: string; mode: string };
    node: { name: string };
    timezone: string;
    vars: IDataObject;
  };
  signal?: AbortSignal;
}

export interface SandboxRunOutput {
  /** Raw (structured-cloned) value returned by the user code. */
  result: unknown;
  logs: string[];
}

export class CodeExecutionError extends Error {
  constructor(
    message: string,
    readonly lineNumber?: number,
    readonly itemIndex?: number,
  ) {
    super(message);
    this.name = 'CodeExecutionError';
  }
}

const FILENAME = 'code.js';
const MAX_LOG_LINES = 500;

/**
 * Runs user JavaScript inside a fresh V8 isolate (isolated-vm).
 * The isolate has no access to Node APIs, the file system or the network.
 */
export class CodeSandbox {
  private readonly memoryLimitMb: number;
  private readonly timeoutMs: number;

  constructor(options: CodeSandboxOptions = {}) {
    this.memoryLimitMb = options.memoryLimitMb ?? 128;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  async run(input: SandboxRunInput): Promise<SandboxRunOutput> {
    const timeoutMs = input.timeoutMs ?? this.timeoutMs;
    const isolate = new ivm.Isolate({ memoryLimit: this.memoryLimitMb });
    const logs: string[] = [];
    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;

    try {
      const context = await isolate.createContext();
      const jail = context.global;
      await jail.set('globalThis', jail.derefInto());
      await jail.set(
        '__log',
        new ivm.Callback((line: string) => {
          if (logs.length < MAX_LOG_LINES) logs.push(String(line).slice(0, 10_000));
        }),
      );
      await jail.set(
        '__input',
        new ivm.ExternalCopy({ items: input.items, meta: input.meta }).copyInto({ release: true }),
      );

      const { source, lineOffset } = buildScript(input.code, input.mode);
      const script = await isolate.compileScript(source, { filename: FILENAME }).catch((error: Error) => {
        throw toCodeError(error, lineOffset);
      });

      const execution = script.run(context, { timeout: timeoutMs, promise: true, copy: true });

      const guard = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new CodeExecutionError(`Code execution timed out after ${timeoutMs / 1000} seconds`));
        }, timeoutMs);
        if (input.signal) {
          onAbort = () => reject(input.signal!.reason ?? new Error('Execution was cancelled'));
          if (input.signal.aborted) onAbort();
          else input.signal.addEventListener('abort', onAbort, { once: true });
        }
      });

      const result = await Promise.race([execution, guard]).catch((error: unknown) => {
        throw toCodeError(error, lineOffset);
      });
      return { result, logs };
    } finally {
      if (timer) clearTimeout(timer);
      if (onAbort) input.signal?.removeEventListener('abort', onAbort);
      if (!isolate.isDisposed) isolate.dispose();
    }
  }
}

function buildScript(code: string, mode: CodeMode): { source: string; lineOffset: number } {
  const prelude = `(async () => {
"use strict";
const __fmt = (v) => { if (typeof v === 'string') return v; try { return JSON.stringify(v); } catch { return String(v); } };
const console = Object.freeze({
  log: (...a) => __log(a.map(__fmt).join(' ')),
  info: (...a) => __log(a.map(__fmt).join(' ')),
  debug: (...a) => __log(a.map(__fmt).join(' ')),
  warn: (...a) => __log('[warn] ' + a.map(__fmt).join(' ')),
  error: (...a) => __log('[error] ' + a.map(__fmt).join(' ')),
});
const $workflow = __input.meta.workflow;
const $execution = __input.meta.execution;
const $node = __input.meta.node;
const $vars = __input.meta.vars;
const $now = new Date();
const items = __input.items;
`;
  if (mode === 'runOnceForAllItems') {
    const head = `${prelude}const $input = Object.freeze({ all: () => items, first: () => items[0], last: () => items[items.length - 1] });
return await (async function () {
`;
    return { source: `${head}${code}\n}).call({});\n})()`, lineOffset: countLines(head) };
  }
  const head = `${prelude}const __results = [];
for (let __i = 0; __i < items.length; __i++) {
  const item = items[__i];
  const $input = Object.freeze({ item, all: () => items, first: () => items[0], last: () => items[items.length - 1] });
  try {
    __results.push(await (async function ($json, $binary, $itemIndex) {
`;
  const tail = `
    }).call({}, item.json, item.binary, __i));
  } catch (e) {
    const err = e instanceof Error ? e : new Error(__fmt(e));
    err.message = err.message + ' {{item:' + __i + '}}';
    throw err;
  }
}
return __results;
})()`;
  return { source: `${head}${code}${tail}`, lineOffset: countLines(head) };
}

function countLines(text: string): number {
  return text.split('\n').length - 1;
}

function toCodeError(error: unknown, lineOffset: number): Error {
  if (error instanceof CodeExecutionError) return error;
  if (!(error instanceof Error)) return new CodeExecutionError(String(error));
  if (error.name === 'AbortError' || error.message === 'Execution was cancelled') return error;

  const stack = error.stack ?? '';
  const match = new RegExp(`${FILENAME.replace('.', '\\.')}:(\\d+)`).exec(stack);
  const line = match ? Number(match[1]) - lineOffset : undefined;
  let message = error.message;
  if (/Isolate was disposed|memory limit/i.test(message)) {
    message = 'Code used too much memory and was stopped';
  } else if (/could not be cloned/i.test(message)) {
    message = 'Code returned a value that cannot be converted to JSON (e.g. a function). Return plain objects only.';
  } else if (/Script execution timed out/i.test(message)) {
    message = 'Code execution timed out';
  }
  let itemIndex: number | undefined;
  message = message.replace(/ \{\{item:(\d+)\}\}/, (_, index: string) => {
    itemIndex = Number(index);
    return '';
  });
  const where = line && line > 0 ? ` [line ${line}]` : '';
  return new CodeExecutionError(`${message}${where}`, line && line > 0 ? line : undefined, itemIndex);
}
