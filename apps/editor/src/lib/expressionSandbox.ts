import luxonSource from 'virtual:luxon-global';
import {
  EXPRESSION_RUNTIME,
  evaluateExpression,
  referencedNodes,
  resolvePairedItem,
  splitTemplate,
  type IDataObject,
  type INodeExecutionData,
  type IRunData,
  type ISourceData,
} from '@flowforge/workflow';

/**
 * Previews expressions in the editor.
 *
 * Expressions are JavaScript written by whoever built the workflow, so they never
 * run in the editor's own context: they run in a Web Worker inside a sandboxed,
 * opaque-origin iframe whose CSP blocks all network access. Runaway code is
 * stopped after a second by terminating the worker.
 */

export interface PreviewSnapshot {
  item?: { json: IDataObject; binary?: unknown };
  inputItems: Array<{ json: IDataObject; binary?: unknown }>;
  /** Referenced nodes: their output and the item paired with item 0. */
  nodes: Record<
    string,
    { items: Array<{ json: IDataObject }>; paired?: { json: IDataObject } | null }
  >;
  ctx: {
    itemIndex: number;
    runIndex: number;
    workflow: { id?: string; name: string; active?: boolean };
    execution: { id: string; mode: string; resumeUrl?: string };
    vars: IDataObject;
    parameter: IDataObject;
    timezone: string;
  };
}

type SegmentResult = { ok: true; value: unknown } | { ok: false; error: string };

const WORKER_SOURCE = `
${luxonSource}
${EXPRESSION_RUNTIME}
var S = null;
function clean(i) { return i ? (i.binary ? { json: i.json, binary: i.binary } : { json: i.json }) : undefined; }
globalThis.__host = function (kind, a, b, c) {
  switch (kind) {
    case 'ctx': return S.ctx;
    case 'json': return (S.item && S.item.json) || {};
    case 'binary': return (S.item && S.item.binary) || {};
    case 'input': {
      var items = S.inputItems;
      if (a === 'all') return items.map(clean);
      var it = a === 'first' ? items[0] : a === 'last' ? items[items.length - 1] : (S.item || items[0]);
      return clean(it) || { json: {} };
    }
    case 'executed': return !!S.nodes[a];
    case 'node': {
      var n = S.nodes[a];
      if (!n) throw new Error('Referenced node "' + a + '" hasn\\'t been executed yet. Execute the previous nodes to preview this.');
      if (b === 'all') return n.items.map(clean);
      if (b === 'first') return clean(n.items[0]) || { json: {} };
      if (b === 'last') return clean(n.items[n.items.length - 1]) || { json: {} };
      return clean(n.paired || n.items[S.ctx.itemIndex] || n.items[0]) || { json: {} };
    }
  }
  throw new Error('Unknown host call ' + kind);
};
self.onmessage = function (e) {
  S = e.data.snapshot;
  var results = e.data.segments.map(function (code) {
    try { return { ok: true, value: __run(code) }; }
    catch (err) { return { ok: false, error: (err && err.name && err.name !== 'Error' ? err.name + ': ' : '') + (err && err.message ? err.message : String(err)) }; }
  });
  self.postMessage({ id: e.data.id, results: results });
};
`;

const IFRAME_SOURCE = `<!doctype html><html><head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob:; worker-src blob:">
</head><body><script>
var source = null, worker = null, pending = {};
function spawn() {
  worker = new Worker(URL.createObjectURL(new Blob([source], { type: 'text/javascript' })));
  worker.onmessage = function (e) { var p = pending[e.data.id]; if (p) { clearTimeout(p.timer); delete pending[e.data.id]; parent.postMessage({ id: e.data.id, results: e.data.results }, '*'); } };
}
window.addEventListener('message', function (e) {
  var msg = e.data;
  if (msg.type === 'init') { source = msg.source; spawn(); parent.postMessage({ type: 'ready' }, '*'); return; }
  if (!worker) return;
  pending[msg.id] = { timer: setTimeout(function () {
    worker.terminate(); spawn();
    for (var id in pending) { clearTimeout(pending[id].timer); parent.postMessage({ id: Number(id), timeout: true }, '*'); }
    pending = {};
  }, 1000) };
  worker.postMessage(msg);
});
<\/script></body></html>`;

class PreviewSandbox {
  private iframe?: HTMLIFrameElement;
  private ready?: Promise<void>;
  private nextId = 1;
  private readonly waiting = new Map<number, (results: SegmentResult[] | 'timeout') => void>();

  private init(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve) => {
      const iframe = document.createElement('iframe');
      iframe.setAttribute('sandbox', 'allow-scripts');
      iframe.setAttribute('aria-hidden', 'true');
      iframe.style.display = 'none';
      iframe.srcdoc = IFRAME_SOURCE;
      window.addEventListener('message', (event) => {
        if (event.source !== iframe.contentWindow) return;
        const data = event.data as {
          type?: string;
          id?: number;
          results?: SegmentResult[];
          timeout?: boolean;
        };
        if (data.type === 'ready') return resolve();
        const done = data.id !== undefined ? this.waiting.get(data.id) : undefined;
        if (!done) return;
        this.waiting.delete(data.id!);
        done(data.timeout ? 'timeout' : (data.results ?? []));
      });
      iframe.onload = () =>
        iframe.contentWindow?.postMessage({ type: 'init', source: WORKER_SOURCE }, '*');
      document.body.appendChild(iframe);
      this.iframe = iframe;
    });
    return this.ready;
  }

  async evaluate(
    segments: string[],
    snapshot: PreviewSnapshot,
  ): Promise<SegmentResult[] | 'timeout'> {
    await this.init();
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.waiting.set(id, resolve);
      // Structured clone strips anything non-cloneable.
      this.iframe!.contentWindow!.postMessage(
        { id, segments, snapshot: JSON.parse(JSON.stringify(snapshot)) },
        '*',
      );
    });
  }
}

const sandbox = new PreviewSandbox();

export type PreviewResult = { ok: true; value: unknown } | { ok: false; error: string };

/** Evaluate an expression (with leading `=`) against a snapshot of execution data. */
export async function previewExpression(
  expression: string,
  snapshot: PreviewSnapshot,
): Promise<PreviewResult> {
  const segments = splitTemplate(expression.slice(1))
    .filter((s) => s.kind === 'code')
    .map((s) => s.value);
  if (segments.length === 0) return { ok: true, value: expression.slice(1) };
  const results = await sandbox.evaluate(segments, snapshot);
  if (results === 'timeout')
    return { ok: false, error: 'The expression took longer than 1 second' };
  let index = 0;
  try {
    const value = evaluateExpression(expression, {} as never, {
      evaluate: () => {
        const result = results[index++]!;
        if (!result.ok) throw new Error(result.error);
        return result.value;
      },
    });
    return { ok: true, value };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

/** Build the data a preview needs from the editor's run data. */
export function buildSnapshot(options: {
  expression: string;
  inputItems: INodeExecutionData[];
  inputSource: ISourceData | null;
  runData: IRunData | null;
  getNodeOutput: (name: string) => INodeExecutionData[] | undefined;
  workflow: { id?: string; name: string };
  timezone: string;
  vars: IDataObject;
  parameters: IDataObject;
}): PreviewSnapshot {
  const nodes: PreviewSnapshot['nodes'] = {};
  for (const name of referencedNodes(options.expression)) {
    const items = options.getNodeOutput(name);
    if (!items) continue;
    const paired = options.runData
      ? resolvePairedItem(options.runData, options.inputSource, 0, name)
      : null;
    nodes[name] = {
      items: items.slice(0, 200).map((i) => ({ json: i.json })),
      paired: paired?.ok ? { json: paired.item.json } : null,
    };
  }
  const item = options.inputItems[0];
  return {
    item: item ? { json: item.json } : undefined,
    inputItems: options.inputItems.slice(0, 200).map((i) => ({ json: i.json })),
    nodes,
    ctx: {
      itemIndex: 0,
      runIndex: 0,
      workflow: options.workflow,
      execution: {
        id: 'preview',
        mode: 'manual',
        resumeUrl: `${location.origin}/webhook-waiting/<execution id>`,
      },
      vars: options.vars,
      parameter: options.parameters,
      timezone: options.timezone,
    },
  };
}
