import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import ivm from 'isolated-vm';
import {
  EXPRESSION_RUNTIME,
  createExpressionHost,
  type ExpressionData,
  type IExpressionEvaluator,
} from '@flowforge/workflow';

const require = createRequire(import.meta.url);
let luxonSource: string | undefined;
function getLuxonSource(): string {
  // The global (browser) build defines `luxon` on globalThis; it isn't listed in luxon's "exports".
  luxonSource ??= readFileSync(
    join(dirname(require.resolve('luxon')), '../global/luxon.min.js'),
    'utf8',
  );
  return luxonSource;
}

export interface ExpressionSandboxOptions {
  memoryLimitMb?: number;
  /** Max time for evaluating a single expression. */
  timeoutMs?: number;
}

/**
 * Evaluates `{{ … }}` expressions as JavaScript inside a V8 isolate.
 *
 * One isolate is created lazily per execution and disposed when the execution
 * ends, so workflows cannot see each other's state. Data is pulled into the
 * isolate on demand (`$json`, `$('Node').item`, …) through a host callback.
 */
export class IsolatedExpressionEvaluator implements IExpressionEvaluator {
  private isolate?: ivm.Isolate;
  private context?: ivm.Context;
  private run?: ivm.Reference<(code: string) => unknown>;
  private current?: (kind: string, a?: unknown, b?: unknown, c?: unknown) => unknown;
  private readonly timeoutMs: number;
  private readonly memoryLimitMb: number;

  constructor(options: ExpressionSandboxOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 1_000;
    this.memoryLimitMb = options.memoryLimitMb ?? 64;
  }

  private setup() {
    if (this.run && this.isolate && !this.isolate.isDisposed) return;
    const isolate = new ivm.Isolate({ memoryLimit: this.memoryLimitMb });
    const context = isolate.createContextSync();
    const jail = context.global;
    jail.setSync('globalThis', jail.derefInto());
    jail.setSync(
      '__hostRef',
      new ivm.Reference((kind: string, a?: unknown, b?: unknown, c?: unknown) => {
        if (!this.current) throw new Error('No expression is being evaluated');
        const value = this.current(kind, a, b, c);
        return value === undefined
          ? undefined
          : new ivm.ExternalCopy(value).copyInto({ release: true });
      }),
    );
    context.evalSync(
      `globalThis.__host = function (kind, a, b, c) {
         return __hostRef.applySync(undefined, [kind, a, b, c], { arguments: { copy: true } });
       };`,
    );
    context.evalSync(getLuxonSource());
    context.evalSync(EXPRESSION_RUNTIME);
    this.isolate = isolate;
    this.context = context;
    this.run = jail.getSync('__run', { reference: true }) as ivm.Reference<
      (code: string) => unknown
    >;
  }

  evaluate(code: string, data: ExpressionData): unknown {
    this.setup();
    this.current = createExpressionHost(data);
    try {
      return this.run!.applySync(undefined, [code], {
        arguments: { copy: true },
        result: { copy: true },
        timeout: this.timeoutMs,
      });
    } catch (error) {
      throw this.toFriendlyError(error);
    } finally {
      this.current = undefined;
    }
  }

  private toFriendlyError(error: unknown): Error {
    const message = error instanceof Error ? error.message : String(error);
    if (/Script execution timed out/i.test(message)) {
      this.dispose(); // the isolate may be in a bad state
      return new Error(`The expression took longer than ${this.timeoutMs}ms and was stopped`);
    }
    if (/Isolate was disposed|memory limit/i.test(message)) {
      this.dispose();
      return new Error('The expression used too much memory and was stopped');
    }
    if (/could not be cloned/i.test(message)) {
      return new Error('The expression returned a value that cannot be stored (e.g. a function)');
    }
    const name = error instanceof Error && error.name !== 'Error' ? `${error.name}: ` : '';
    return new Error(`${name}${message}`);
  }

  dispose() {
    this.run?.release();
    this.context?.release();
    if (this.isolate && !this.isolate.isDisposed) this.isolate.dispose();
    this.run = undefined;
    this.context = undefined;
    this.isolate = undefined;
  }
}
