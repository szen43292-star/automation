import {
  NodeOperationError,
  WorkflowOperationError,
  deepClone,
  isObject,
  sleep,
  toNodeErrorJSON,
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
}

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
  private lastNodeExecuted?: string;
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
      this.initialise(options);
      const allowed = this.allowedNodes(options.destinationNode);
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

        const task = await this.executeNode(node, entry);
        if (task.executionStatus === 'error') {
          // Keep the failed entry so the execution can be retried from here.
          this.stack.unshift(entry);
          status = 'error';
          error = task.error;
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

  private initialise(options: WorkflowRunOptions) {
    const resume = options.resumeFrom;
    if (resume?.executionData?.nodeExecutionStack.length) {
      this.runData = deepClone(resume.resultData.runData);
      this.stack = deepClone(resume.executionData.nodeExecutionStack);
      this.waiting = deepClone(resume.executionData.waitingExecution);
      this.lastNodeExecuted = resume.resultData.lastNodeExecuted;
      // Drop the failed attempt of the node we are retrying.
      const retryNode = this.workflow.getNode(this.stack[0]!.nodeId);
      const runs = retryNode ? this.runData[retryNode.name] : undefined;
      if (runs?.length && runs[runs.length - 1]!.executionStatus === 'error') runs.pop();
      return;
    }
    const start = this.workflow.getStartNode(this.additional.nodeTypes, options.startNode);
    const items = options.triggerItems?.length ? options.triggerItems : [{ json: {} }];
    this.stack = [{ nodeId: start.id, data: { main: [items] }, source: [null] }];
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
      resultData: { runData: this.runData, lastNodeExecuted: this.lastNodeExecuted, error },
      executionData: { nodeExecutionStack: this.stack, waitingExecution: this.waiting },
    };
  }

  private getNodeOutput = (nodeName: string, outputIndex = 0, runIndex?: number) => {
    const pinned = this.workflow.pinData[nodeName];
    if (pinned && outputIndex === 0) return pinned;
    const runs = this.runData[nodeName];
    if (!runs?.length) return undefined;
    const run = runs[runIndex ?? runs.length - 1];
    return run?.data?.main[outputIndex] ?? [];
  };

  private async executeNode(node: INode, entry: IExecuteStackEntry): Promise<ITaskData> {
    const { hooks } = this.additional;
    const runs = (this.runData[node.name] ??= []);
    const runIndex = runs.length;
    const startTime = Date.now();
    await hooks?.nodeExecuteBefore?.(node.name);

    let task: ITaskData;
    try {
      const result = await this.runNodeWithRetries(node, entry, runIndex);
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
    return task;
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

  private outputCount(node: INode): number {
    return this.additional.nodeTypes.get(node.type)?.description.outputs.length ?? 1;
  }

  private async runNodeWithRetries(
    node: INode,
    entry: IExecuteStackEntry,
    runIndex: number,
  ): Promise<NodeRunResult> {
    const signal = this.controller.signal;
    const maxTries = node.retryOnFail ? Math.min(Math.max(node.maxTries ?? 3, 2), 10) : 1;
    const wait = node.waitBetweenTries ?? 1000;
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxTries; attempt++) {
      try {
        return await this.runNode(node, entry, runIndex);
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
      logger: this.logger,
    });

    const abortPromise = new Promise<never>((_, reject) => {
      if (signal.aborted) reject(signal.reason);
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
    abortPromise.catch(() => undefined);

    const raw = await Promise.race([nodeType.execute.call(context), abortPromise]);
    const outputs = this.normaliseOutput(node, nodeType, raw);
    this.routeItemErrors(node, outputs);

    if (node.alwaysOutputData && outputs.every((items) => !items || items.length === 0)) {
      outputs[0] = [{ json: {} }];
    }
    return { outputs, logs: context.logs, hints: context.hints };
  }

  private normaliseOutput(
    node: INode,
    nodeType: INodeType,
    raw: unknown,
  ): Array<INodeExecutionData[] | null> {
    if (raw === null || raw === undefined) return nodeType.description.outputs.map(() => []);
    if (!Array.isArray(raw) || raw.some((output) => output !== null && !Array.isArray(output))) {
      throw new NodeOperationError(node, 'The node returned data in an invalid format', {
        description:
          'execute() must return an array with one array of items per output, e.g. [[{ json: {} }]]',
      });
    }
    return raw.map((output: unknown[] | null) =>
      output === null
        ? null
        : output.map((item, index) => {
            if (!isObject(item) || !isObject(item.json)) {
              throw new NodeOperationError(node, `Item ${index} is not a valid item`, {
                description:
                  'Every item must be an object with a "json" property, e.g. { json: { name: "Ada" } }',
                itemIndex: index,
              });
            }
            return item as unknown as INodeExecutionData;
          }),
    );
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
        const inputCount =
          this.additional.nodeTypes.get(target.type)?.description.inputs.length ?? 1;
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
