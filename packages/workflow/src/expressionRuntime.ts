import type { ExpressionData } from './expression';
import type { INodeExecutionData } from './interfaces';

/**
 * JavaScript evaluated once inside every expression sandbox (the isolated-vm
 * isolate on the server, a sandboxed iframe in the editor). It expects:
 *   - `luxon` (global build) to be loaded
 *   - `__host(kind, a, b, c)` returning copies of execution data
 * and defines `$json`, `$input`, `$('Node')`, `$now`, … plus `__run(code)`.
 */
export const EXPRESSION_RUNTIME = String.raw`
(function () {
  'use strict';
  var G = globalThis;
  var luxon = G.luxon;
  var DateTime = luxon.DateTime;
  var cache = {};
  function memo(key, fn) {
    if (!Object.prototype.hasOwnProperty.call(cache, key)) cache[key] = fn();
    return cache[key];
  }
  function ctx() { return memo('ctx', function () { return G.__host('ctx'); }); }
  function host(kind, a, b, c) { return G.__host(kind, a, b, c); }

  function nodeAccessor(name) {
    name = String(name);
    var key = 'node:' + name + ':';
    return {
      get item() { return memo(key + 'item', function () { return host('node', name, 'item'); }); },
      first: function () { return memo(key + 'first', function () { return host('node', name, 'first'); }); },
      last: function () { return memo(key + 'last', function () { return host('node', name, 'last'); }); },
      all: function () { return memo(key + 'all', function () { return host('node', name, 'all'); }); },
      itemMatching: function (index) { return host('node', name, 'itemMatching', Number(index)); },
      get json() { return this.item.json; },
      get binary() { return this.item.binary; },
      get isExecuted() { return host('executed', name); },
    };
  }

  var defs = {
    $json: function () { return memo('json', function () { return host('json'); }); },
    $binary: function () { return memo('binary', function () { return host('binary'); }); },
    $itemIndex: function () { return ctx().itemIndex; },
    $runIndex: function () { return ctx().runIndex; },
    $workflow: function () { return ctx().workflow; },
    $execution: function () { return ctx().execution; },
    $vars: function () { return ctx().vars; },
    $parameter: function () { return ctx().parameter; },
    $now: function () { return DateTime.now().setZone(ctx().timezone); },
    $today: function () { return DateTime.now().setZone(ctx().timezone).startOf('day'); },
    $input: function () {
      return {
        get item() { return memo('input:item', function () { return host('input', 'item'); }); },
        first: function () { return memo('input:first', function () { return host('input', 'first'); }); },
        last: function () { return memo('input:last', function () { return host('input', 'last'); }); },
        all: function () { return memo('input:all', function () { return host('input', 'all'); }); },
      };
    },
    $node: function () {
      return new Proxy({}, { get: function (_t, name) { return typeof name === 'string' ? nodeAccessor(name) : undefined; } });
    },
  };
  Object.keys(defs).forEach(function (name) {
    Object.defineProperty(G, name, { get: defs[name], configurable: false, enumerable: false });
  });

  G.$ = function (name) { return nodeAccessor(name); };
  G.$if = function (condition, whenTrue, whenFalse) { return condition ? whenTrue : whenFalse; };
  G.$ifEmpty = function (value, fallback) {
    if (value === undefined || value === null || value === '') return fallback;
    if (Array.isArray(value)) return value.length ? value : fallback;
    if (typeof value === 'object' && !(value instanceof Date) && !DateTime.isDateTime(value)) {
      return Object.keys(value).length ? value : fallback;
    }
    return value;
  };
  G.$max = function () { return Math.max.apply(null, arguments); };
  G.$min = function () { return Math.min.apply(null, arguments); };
  G.DateTime = luxon.DateTime;
  G.Duration = luxon.Duration;
  G.Interval = luxon.Interval;

  function normalise(value, depth) {
    if (depth > 50) throw new Error('The expression result is nested too deeply');
    if (value === undefined || value === null) return value;
    if (typeof value === 'function') throw new Error('The expression returned a function - did you forget to call it, e.g. .toISO() instead of .toISO?');
    if (typeof value === 'symbol' || typeof value === 'bigint') return String(value);
    if (DateTime.isDateTime(value)) return value.toISO();
    if (luxon.Duration.isDuration(value)) return value.toISO();
    if (value instanceof Date) return isNaN(value.getTime()) ? null : value.toISOString();
    if (typeof value === 'number' && !isFinite(value)) return null;
    if (Array.isArray(value)) return value.map(function (v) { return normalise(v, depth + 1); });
    if (typeof value === 'object') {
      var out = {};
      Object.keys(value).forEach(function (k) { out[k] = normalise(value[k], depth + 1); });
      return out;
    }
    return value;
  }

  var compiled = new Map();
  G.__run = function (code) {
    var fn = compiled.get(code);
    if (!fn) {
      fn = new Function('return (' + code + '\n);');
      if (compiled.size > 2000) compiled.clear();
      compiled.set(code, fn);
    }
    cache = {};
    return normalise(fn(), 0);
  };
})();
`;

/** Node names referenced via `$('Name')` or `$node["Name"]` in an expression. */
export function referencedNodes(code: string): string[] {
  const names = new Set<string>();
  const re =
    /\$\(\s*(["'`])((?:\\.|(?!\1).)*)\1\s*\)|\$node\[\s*(["'`])((?:\\.|(?!\3).)*)\3\s*\]|\$node\.([A-Za-z_$][\w$]*)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(code)))
    names.add((match[2] ?? match[4] ?? match[5])!.replace(/\\(.)/g, '$1'));
  return [...names];
}

function cleanItem(item: INodeExecutionData | undefined) {
  if (!item) return undefined;
  return { json: item.json, ...(item.binary ? { binary: item.binary } : {}) };
}

/**
 * Host side of `__host(kind, …)`: returns plain data for the sandbox runtime.
 * Throws errors with user-facing messages.
 */
export function createExpressionHost(data: ExpressionData) {
  const outputOf = (name: string) => {
    const items = data.getNodeOutput(name);
    if (!items) {
      throw new Error(
        `Referenced node "${name}" hasn't been executed yet. Make sure it runs before this node (or that the name is spelled correctly).`,
      );
    }
    return items;
  };
  return (kind: string, a?: unknown, b?: unknown, c?: unknown): unknown => {
    switch (kind) {
      case 'ctx':
        return {
          itemIndex: data.itemIndex,
          runIndex: data.runIndex,
          workflow: data.workflow,
          execution: data.execution,
          vars: data.vars,
          parameter: data.parameters,
          timezone: data.timezone,
        };
      case 'json':
        return data.item?.json ?? {};
      case 'binary':
        return data.item?.binary ?? {};
      case 'input': {
        const items = data.inputItems;
        if (a === 'all') return items.map(cleanItem);
        const item =
          a === 'first'
            ? items[0]
            : a === 'last'
              ? items[items.length - 1]
              : (data.item ?? items[data.itemIndex]);
        return cleanItem(item) ?? { json: {} };
      }
      case 'executed':
        return Boolean(data.getNodeOutput(String(a)));
      case 'node': {
        const name = String(a);
        const items = outputOf(name);
        switch (b) {
          case 'all':
            return items.map(cleanItem);
          case 'first':
            return cleanItem(items[0]) ?? { json: {} };
          case 'last':
            return cleanItem(items[items.length - 1]) ?? { json: {} };
          case 'itemMatching':
          case 'item': {
            const index = b === 'itemMatching' ? Number(c) : data.itemIndex;
            const paired = data.getPairedItem?.(name, index);
            if (paired?.ok) return cleanItem(paired.item);
            if (paired && paired.reason === 'notAncestor') {
              throw new Error(
                `Can't tell which item of "${name}" belongs to item ${index}: "${name}" is not on this item's path. Use $('${name}').first() or .all() instead.`,
              );
            }
            // No pairing information: fall back to the item at the same position.
            return cleanItem(items[index] ?? items[0]) ?? { json: {} };
          }
          default:
            throw new Error(`Unknown accessor "${String(b)}"`);
        }
      }
      default:
        throw new Error(`Unknown expression host call "${kind}"`);
    }
  };
}
