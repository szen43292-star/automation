import {
  NodeOperationError,
  WorkflowOperationError,
  deepClone,
  isObject,
  resolveNodeOutputs,
  resolvePairedItem,
  sleep,
  toNodeErrorJSON,
  type IDataObject,
  type ILogger,
  type INode,
  type INodeExecutionData,
  type INodeType,
  type IExecuteStackEntry,
  type IRun,
  type IRunData,
  type IRunExecutionData,
  type ISourceData,
  type ITaskData,
  type IWaitingEntry,
  type NodeErrorJSON,
  type Workflow,
} from '@flowforge/workflow';
import { ExecuteContext } from './ExecuteContext';
import type { WorkflowExecuteAdditionalData, WorkflowRunOptions } from './types';

const noopLogger: ILogger = { debug() {}, info() {}, warn() {}, error() {} };

class ExecutionCanceledError extends Error {
  constructor(message = 'The execution was cancelled') {
    super(message);
    this.name = 'ExecutionCanceledError';
  }
}

class ExecutionTimeoutError extends Error {
  constructor(seconds: number) {
    super(`The workflow execution timed out after ${seconds} seconds`);
    this.name = 'ExecutionTimeoutError';
  }
}

interface NodeRunResult {
  outputs: Array<INodeExecutionData[] | null>;
  logs: string[];
  hints: string[];
  wait?: { waitTill: Date | null; resumeOnWebhook?: boolean };
}

/** Far-future date used for "wait for webhook without time limit". */
export const WAIT_FOREVER = '3000-01-01T00:00:00.000Z';

/**
 * Executes a workflow graph.
 *
 * Order of execution ("v1", same as n8n): depth-first. When a node finishes,
 * its children are put at the front of the stack, ordered by output index and
 * canvas position, so a branch runs to completion before the next branch.
 *
 * Nodes with several inputs (e.g. Merge) wait until every connected input has
 * data; if the stack runs dry they execute with whatever arrived.
 */
export class WorkflowExecute {
  private readonly logger: ILogger;
  private runData: IRunData = {};
  private stack: IExecuteStackEntry[] = [];
  private waiting: IWaitingEntry[] = [];
  private contextData: Record<string, IDataObject> = {};
  private lastNodeExecuted?: string;
  private waitTill?: string;
  private waitingNode?: string;
  private readonly controller = new AbortController();

  constructor(
    private readonly workflow: Workflow,
    private readonly additional: WorkflowExecuteAdditionalData,
  ) {
    this.logger = additional.logger ?? noopLogger;
  }

  /** Cancel the running execution. */
  cancel(reason = 'The execution was cancelled'): void {
    if (!this.controller.signal.aborted) this.controller.abort(new ExecutionCanceledError(reason));
  }

  async run(options: WorkflowRunOptions = {}): Promise<IRun> {
    const startedAt = new Date();
    const { additional, workflow } = this;
    const signal = this.controller.signal;

    const external = additional.signal;
    const onExternalAbort = () => this.cancel();
    if (external?.aborted) this.cancel();
    external?.addEventListener('abort', onExternalAbort, { once: true });

    let timeout: NodeJS.Timeout | undefined;
    const timeoutSeconds = workflow.settings.executionTimeout;
    if (timeoutSeconds && timeoutSeconds > 0) {
      timeout = setTimeout(() => {
        if (!signal.aborted) this.controller.abort(new ExecutionTimeoutError(timeoutSeconds));
      }, timeoutSeconds * 1000);
    }

    let status: IRun['status'] = 'success';
    let error: NodeErrorJSON | undefined;

    try {
      await additional.hooks?.workflowExecuteBefore?.();
      const allowed = this.allowedNodes(options.destinationNode);
      await this.initialise(options, allowed);
      const destination = options.destinationNode
        ? this.resolveNode(options.destinationNode)
        : undefined;
      const maxRuns = additional.maxNodeRuns ?? 100_000;
      let runs = 0;

      while (true) {
        if (signal.aborted) throw signal.reason;
        if (this.stack.length === 0) {
          if (this.waiting.length === 0) break;
          // Inputs that never received data: run the multi-input node with what it has.
          this.stack.push(this.waiting.shift()!);
        }
        const entry = this.stack.shift()!;
        const node = workflow.getNode(entry.nodeId);
        if (!node) continue;

        if (++runs > maxRuns) {
          throw new WorkflowOperationError(
            `Stopped after ${maxRuns} node runs - the workflow probably contains an infinite loop`,
            node.name,
          );
        }

        const { task, wait } = await this.executeNode(node, entry, options);
        if (task.executionStatus === 'error') {
          // Keep the failed entry so the execution can be retried from here.
          this.stack.unshift(entry);
          status = 'error';
          error = task.error;
          break;
        }
        if (wait) {
          // Pause: children run when the execution is resumed.
          this.waitTill = (wait.waitTill ?? new Date(WAIT_FOREVER)).toISOString();
          this.waitingNode = node.name;
          status = 'waiting';
          break;
        }
        if (destination && node.id === destination.id) continue;
        this.propagate(node, task, allowed);
      }
    } catch (caught) {
      const reason = signal.aborted ? signal.reason : caught;
      if (reason instanceof ExecutionCanceledError) {
        status = 'canceled';
        error = toNodeErrorJSON(reason);
      } else {
        status = 'error';
        error = toNodeErrorJSON(reason, (reason as { node?: string }).node);
      }
    } finally {
      if (timeout) clearTimeout(timeout);
      external?.removeEventListener('abort', onExternalAbort);
      try {
        additional.expressionEvaluator.dispose?.();
      } catch {
        /* ignore */
      }
    }

    const run: IRun = {
      status,
      mode: additional.mode,
      startedAt: startedAt.toISOString(),
      stoppedAt: new Date().toISOString(),
      data: this.snapshot(error),
    };
    try {
      await additional.hooks?.workflowExecuteAfter?.(run);
    } catch (hookError) {
      this.logger.error('workflowExecuteAfter hook failed', { error: String(hookError) });
    }
    return run;
  }

  // -------------------------------------------------------------------------

  private async initialise(options: WorkflowRunOptions, allowed: Set<string> | null) {
    const resume = options.resumeFrom;

    // Resume after a Wait node.
    if (resume?.waitingNode) {
      this.restore(resume);
      const node = this.workflow.getNodeByName(resume.waitingNode);
      const runs = node ? this.runData[node.name] : undefined;
      const task = runs?.[runs.length - 1];
      if (node && task) {
        if (options.resumeData) task.data = { main: [options.resumeData] };
        await this.additional.hooks?.nodeExecuteAfter?.(node.name, task, runs!.length - 1);
        this.propagate(node, task, allowed);
      }
      return;
    }

    // Retry from the node that failed.
    if (resume?.executionData?.nodeExecutionStack.length) {
      this.restore(resume);
      const retryNode = this.workflow.getNode(this.stack[0]!.nodeId);
      const runs = retryNode ? this.runData[retryNode.name] : undefined;
      if (runs?.length && runs[runs.length - 1]!.executionStatus !== 'success') runs.pop();
      return;
    }

    // Partial execution: reuse existing node outputs.
    if (options.runData && options.destinationNode && allowed) {
      if (this.initialisePartial(options, allowed)) return;
    }

    const start = this.workflow.getStartNode(this.additional.nodeTypes, options.startNode);
    const items = options.triggerItems?.length ? options.triggerItems : [{ json: {} }];
    this.stack = [{ nodeId: start.id, data: { main: [items] }, source: [null] }];
  }

  private restore(data: IRunExecutionData) {
    this.runData = deepClone(data.resultData.runData);
    this.stack = deepClone(data.executionData?.nodeExecutionStack ?? []);
    this.waiting = deepClone(data.executionData?.waitingExecution ?? []);
    this.contextData = deepClone(data.contextData ?? {});
    this.lastNodeExecuted = data.resultData.lastNodeExecuted;
  }

  /**
   * Seed the stack with the nodes that must run again, feeding them the stored
   * output of their parents. Returns false when nothing can be reused.
   */
  private initialisePartial(options: WorkflowRunOptions, allowed: Set<string>): boolean {
    const previous = options.runData!;
    const dirty = new Set(options.dirtyNodes ?? []);
    const destination = this.resolveNode(options.destinationNode!);
    const hasData = (node: INode) =>
      (Boolean(previous[node.name]?.some((t) => t.executionStatus === 'success')) &&
        !dirty.has(node.name)) ||
      Boolean(this.workflow.pinData[node.name]);

    // A node reruns when it has no reusable data, is the destination, or a parent reruns.
    const rerun = new Set<string>();
    let changed = true;
    while (changed) {
      changed = false;
      for (const id of allowed) {
        if (rerun.has(id)) continue;
        const node = this.workflow.getNode(id)!;
        const parentRerun = this.workflow
          .getParents(id)
          .some((p) => allowed.has(p) && rerun.has(p));
        if (id === destination.id || !hasData(node) || parentRerun) {
          rerun.add(id);
          changed = true;
        }
      }
    }

    const reused = [...allowed].filter((id) => !rerun.has(id));
    if (reused.length === 0) return false;
    for (const id of reused) {
      const node = this.workflow.getNode(id)!;
      const runs = previous[node.name]?.filter((t) => t.executionStatus === 'success') ?? [];
      if (runs.length) this.runData[node.name] = deepClone(runs.slice(-1));
    }

    const entries: IExecuteStackEntry[] = [];
    for (const id of rerun) {
      const node = this.workflow.getNode(id)!;
      const incoming = this.workflow.getIncoming(id).filter((c) => allowed.has(c.source));
      if (incoming.length === 0) {
        // A trigger or root node: start it normally.
        if (
          this.workflow.getStartNode(this.additional.nodeTypes).id === id ||
          this.isTrigger(node)
        ) {
          entries.push({
            nodeId: id,
            data: { main: [options.triggerItems ?? [{ json: {} }]] },
            source: [null],
          });
        }
        continue;
      }
      if (incoming.some((c) => rerun.has(c.source))) continue; // will receive data when its parent runs
      const inputCount = this.inputCount(node);
      const entry: IExecuteStackEntry = {
        nodeId: id,
        data: { main: Array.from({ length: Math.max(1, inputCount) }, () => null) },
        source: Array.from({ length: Math.max(1, inputCount) }, () => null),
      };
      for (const conn of incoming) {
        const parent = this.workflow.getNode(conn.source)!;
        const runIndex = (this.runData[parent.name]?.length ?? 1) - 1;
        const items =
          this.runData[parent.name]?.[runIndex]?.data?.main[conn.sourceOutput] ??
          this.workflow.pinData[parent.name];
        if (!items?.length) continue;
        entry.data.main[conn.targetInput] = [
          ...(entry.data.main[conn.targetInput] ?? []),
          ...items,
        ];
        entry.source[conn.targetInput] = {
          previousNode: parent.name,
          previousNodeOutput: conn.sourceOutput,
          previousNodeRun: Math.max(0, runIndex),
        };
      }
      if (entry.data.main.some((items) => items !== null)) entries.push(entry);
    }
    entries.sort((a, b) => this.positionOrder(a.nodeId) - this.positionOrder(b.nodeId));
    this.stack = entries;
    return true;
  }

  private positionOrder(id: string): number {
    const node = this.workflow.getNode(id);
    return node ? node.position[1] * 10_000 + node.position[0] : 0;
  }

  private isTrigger(node: INode): boolean {
    return Boolean(this.additional.nodeTypes.getDescription(node.type)?.group.includes('trigger'));
  }

  private resolveNode(idOrName: string): INode {
    const node = this.workflow.getNode(idOrName) ?? this.workflow.getNodeByName(idOrName);
    if (!node)
      throw new WorkflowOperationError(`Node "${idOrName}" does not exist in this workflow`);
    return node;
  }

  private allowedNodes(destination?: string): Set<string> | null {
    if (!destination) return null;
    const node = this.resolveNode(destination);
    const allowed = this.workflow.getAncestors(node.id);
    allowed.add(node.id);
    return allowed;
  }

  private snapshot(error?: NodeErrorJSON): IRunExecutionData {
    return {
      ...(Object.keys(this.contextData).length ? { contextData: this.contextData } : {}),
      ...(this.waitTill ? { waitTill: this.waitTill, waitingNode: this.waitingNode } : {}),
      resultData: { runData: this.runData, lastNodeExecuted: this.lastNodeExecuted, error },
      executionData: { nodeExecutionStack: this.stack, waitingExecution: this.waiting },
    };
  }

  private getNodeOutput = (nodeName: string, outputIndex = 0, runIndex?: number) => {
    const runs = this.runData[nodeName];
    if (!runs?.length) {
      const pinned = this.workflow.pinData[nodeName];
      return pinned && outputIndex === 0 ? pinned : undefined;
    }
    const run = runs[runIndex ?? runs.length - 1];
    return run?.data?.main[outputIndex] ?? [];
  };

  private outputCount(node: INode): number {
    const description = this.additional.nodeTypes.get(node.type)?.description;
    return description ? resolveNodeOutputs(description, node.parameters).length : 1;
  }

  private inputCount(node: INode): number {
    return this.additional.nodeTypes.get(node.type)?.description.inputs.length ?? 1;
  }

  private async executeNode(
    node: INode,
    entry: IExecuteStackEntry,
    options: WorkflowRunOptions,
  ): Promise<{ task: ITaskData; wait?: NodeRunResult['wait'] }> {
    const { hooks } = this.additional;
    const runs = (this.runData[node.name] ??= []);
    const runIndex = runs.length;
    const startTime = Date.now();
    await hooks?.nodeExecuteBefore?.(node.name);

    let task: ITaskData;
    let wait: NodeRunResult['wait'];
    try {
      const result = await this.runNodeWithRetries(node, entry, runIndex, options);
      wait = result.wait;
      task = {
        startTime,
        executionTime: Date.now() - startTime,
        executionStatus: 'success',
        source: entry.source,
        data: { main: result.outputs },
        ...(result.logs.length ? { logs: result.logs } : {}),
        ...(result.hints.length ? { hints: result.hints } : {}),
      };
    } catch (caught) {
      const signal = this.controller.signal;
      if (signal.aborted) {
        runs.push({
          startTime,
          executionTime: Date.now() - startTime,
          executionStatus: 'canceled',
          source: entry.source,
          error: toNodeErrorJSON(signal.reason, node.name),
        });
        this.lastNodeExecuted = node.name;
        this.stack.unshift(entry);
        throw signal.reason;
      }
      const errorJson = toNodeErrorJSON(caught, node.name);
      this.logger.debug('Node failed', { node: node.name, error: errorJson.message });
      const recovered = this.recoverFromError(node, entry, errorJson);
      task = {
        startTime,
        executionTime: Date.now() - startTime,
        executionStatus: recovered ? 'success' : 'error',
        source: entry.source,
        error: errorJson,
        ...(recovered ? { data: { main: recovered } } : {}),
      };
    }

    runs.push(task);
    this.lastNodeExecuted = node.name;
    await hooks?.nodeExecuteAfter?.(node.name, task, runIndex);
    return { task, wait };
  }

  /** Apply the node's "On Error" setting when the whole node failed. */
  private recoverFromError(
    node: INode,
    entry: IExecuteStackEntry,
    error: NodeErrorJSON,
  ): Array<INodeExecutionData[] | null> | null {
    if (node.onError === 'continueRegularOutput') {
      return [
        [
          {
            json: {
              error: error.message,
              ...(error.description ? { errorDescription: error.description } : {}),
            },
            pairedItem: { item: 0 },
          },
        ],
      ];
    }
    if (node.onError === 'continueErrorOutput') {
      const outputCount = this.outputCount(node);
      const input = entry.data.main[0] ?? [{ json: {} }];
      const outputs: Array<INodeExecutionData[] | null> = Array.from(
        { length: outputCount },
        () => [],
      );
      outputs.push(
        input.map((item, index) => ({
          json: { ...item.json, error: error.message },
          pairedItem: { item: index },
          error,
        })),
      );
      return outputs;
    }
    return null;
  }

  private async runNodeWithRetries(
    node: INode,
    entry: IExecuteStackEntry,
    runIndex: number,
    options: WorkflowRunOptions,
  ): Promise<NodeRunResult> {
    const signal = this.controller.signal;
    const maxTries = node.retryOnFail ? Math.min(Math.max(node.maxTries ?? 3, 2), 10) : 1;
    const wait = node.waitBetweenTries ?? 1000;
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxTries; attempt++) {
      try {
        return await this.runNode(node, entry, runIndex, options);
      } catch (error) {
        lastError = error;
        if (signal.aborted || attempt === maxTries) break;
        this.logger.debug('Retrying node', { node: node.name, attempt });
        await sleep(wait, signal);
      }
    }
    throw lastError;
  }

  private async runNode(
    node: INode,
    entry: IExecuteStackEntry,
    runIndex: number,
    _options: WorkflowRunOptions,
  ): Promise<NodeRunResult> {
    const signal = this.controller.signal;
    const pinned = this.workflow.pinData[node.name];
    if (pinned && !node.disabled) return { outputs: [deepClone(pinned)], logs: [], hints: [] };

    if (node.disabled) {
      // Disabled nodes pass their first input straight through.
      return { outputs: [entry.data.main[0] ?? []], logs: [], hints: [] };
    }

    const nodeType = this.additional.nodeTypes.get(node.type);
    if (!nodeType) {
      throw new NodeOperationError(node, `Unknown node type "${node.type}"`, {
        description:
          'The node is not installed on this server. Install it or remove the node from the workflow.',
      });
    }

    const inputData = node.executeOnce
      ? { main: entry.data.main.map((items) => (items ? items.slice(0, 1) : items)) }
      : entry.data;

    if (!nodeType.execute) {
      return { outputs: [inputData.main[0] ?? []], logs: [], hints: [] };
    }

    const context = new ExecuteContext({
      workflow: this.workflow,
      node,
      nodeType,
      inputData,
      runIndex,
      additional: this.additional,
      signal,
      getNodeOutput: this.getNodeOutput,
      getPairedItem: (nodeName, itemIndex) =>
        resolvePairedItem(this.runData, entry.source[0], itemIndex, nodeName),
      nodeContext: (this.contextData[node.name] ??= {}),
      logger: this.logger,
    });

    const abortPromise = new Promise<never>((_, reject) => {
      if (signal.aborted) reject(signal.reason);
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
    abortPromise.catch(() => undefined);

    const raw = await Promise.race([nodeType.execute.call(context), abortPromise]);
    const outputs = this.normaliseOutput(node, nodeType, raw, inputData.main[0] ?? []);
    this.routeItemErrors(node, outputs);

    if (node.alwaysOutputData && outputs.every((items) => !items || items.length === 0)) {
      outputs[0] = [{ json: {}, pairedItem: { item: 0 } }];
    }
    if (Object.keys(this.contextData[node.name] ?? {}).length === 0)
      delete this.contextData[node.name];
    return {
      outputs,
      logs: context.logs,
      hints: context.hints,
      ...(context.waitRequest ? { wait: context.waitRequest } : {}),
    };
  }

  private normaliseOutput(
    node: INode,
    nodeType: INodeType,
    raw: unknown,
    input: INodeExecutionData[],
  ): Array<INodeExecutionData[] | null> {
    if (raw === null || raw === undefined)
      return resolveNodeOutputs(nodeType.description, node.parameters).map(() => []);
    if (!Array.isArray(raw) || raw.some((output) => output !== null && !Array.isArray(output))) {
      throw new NodeOperationError(node, 'The node returned data in an invalid format', {
        description:
          'execute() must return an array with one array of items per output, e.g. [[{ json: {} }]]',
      });
    }
    return raw.map((output: unknown[] | null) => {
      if (output === null) return null;
      const items = output.map((item, index) => {
        if (!isObject(item) || !isObject(item.json)) {
          throw new NodeOperationError(node, `Item ${index} is not a valid item`, {
            description:
              'Every item must be an object with a "json" property, e.g. { json: { name: "Ada" } }',
            itemIndex: index,
          });
        }
        return item as unknown as INodeExecutionData;
      });
      // Infer item linking when the node did not set it.
      const inferable = input.length === 1 || input.length === items.length;
      return items.map((item, index) =>
        item.pairedItem === undefined && inferable && input.length > 0
          ? { ...item, pairedItem: { item: input.length === 1 ? 0 : index } }
          : item,
      );
    });
  }

  /** With "continue (using error output)", move items marked as failed to the extra error output. */
  private routeItemErrors(node: INode, outputs: Array<INodeExecutionData[] | null>) {
    if (node.onError !== 'continueErrorOutput') return;
    const outputCount = this.outputCount(node);
    while (outputs.length < outputCount) outputs.push([]);
    const failed: INodeExecutionData[] = [];
    for (let i = 0; i < outputCount; i++) {
      const items = outputs[i];
      if (!items) continue;
      outputs[i] = items.filter((item) => {
        if (item.error) failed.push(item);
        return !item.error;
      });
    }
    outputs[outputCount] = [...(outputs[outputCount] ?? []), ...failed];
  }

  /** Queue children of a finished node. */
  private propagate(node: INode, task: ITaskData, allowed: Set<string> | null) {
    const outputs = task.data?.main ?? [];
    const runIndex = this.runData[node.name]!.length - 1;
    const next: IExecuteStackEntry[] = [];

    outputs.forEach((items, outputIndex) => {
      if (!items || items.length === 0) return;
      for (const conn of this.workflow.getOutgoing(node.id, outputIndex)) {
        if (allowed && !allowed.has(conn.target)) continue;
        const target = this.workflow.getNode(conn.target)!;
        const source: ISourceData = {
          previousNode: node.name,
          previousNodeOutput: outputIndex,
          previousNodeRun: runIndex,
        };
        const inputCount = this.inputCount(target);
        if (inputCount <= 1) {
          next.push({ nodeId: target.id, data: { main: [items] }, source: [source] });
          continue;
        }
        const ready = this.addToWaiting(
          target,
          conn.targetInput,
          inputCount,
          items,
          source,
          allowed,
        );
        if (ready) next.push(ready);
      }
    });
    this.stack.unshift(...next);
  }

  private addToWaiting(
    target: INode,
    inputIndex: number,
    inputCount: number,
    items: INodeExecutionData[],
    source: ISourceData,
    allowed: Set<string> | null,
  ): IExecuteStackEntry | null {
    let entry = this.waiting.find(
      (w) => w.nodeId === target.id && w.data.main[inputIndex] === null,
    );
    if (!entry) {
      entry = {
        nodeId: target.id,
        data: { main: Array.from({ length: inputCount }, () => null) },
        source: Array.from({ length: inputCount }, () => null),
      };
      this.waiting.push(entry);
    }
    entry.data.main[inputIndex] = items;
    entry.source[inputIndex] = source;

    const complete = Array.from({ length: inputCount }, (_, i) => i).every((i) => {
      const connected = this.workflow
        .getIncoming(target.id, i)
        .some((c) => !allowed || allowed.has(c.source));
      return !connected || entry!.data.main[i] !== null;
    });
    if (!complete) return null;
    this.waiting.splice(this.waiting.indexOf(entry), 1);
    return entry;
  }
}
