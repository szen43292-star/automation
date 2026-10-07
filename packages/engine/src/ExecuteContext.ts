import {
  ExpressionError,
  NodeOperationError,
  findProperty,
  getPath,
  resolveParameterValue,
  toItems,
  type ExpressionData,
  type IBinaryData,
  type ICodeRunOptions,
  type ICodeRunResult,
  type IDataObject,
  type IExecuteFunctions,
  type IExecuteHelpers,
  type IGetNodeParameterOptions,
  type IHttpRequestOptions,
  type IHttpResponse,
  type ILogger,
  type INode,
  type INodeExecutionData,
  type INodeType,
  type ITaskDataConnections,
  type NodeParameterValueType,
  type Workflow,
} from '@flowforge/workflow';
import type { WorkflowExecuteAdditionalData } from './types';

export interface ExecuteContextOptions {
  workflow: Workflow;
  node: INode;
  nodeType: INodeType;
  inputData: ITaskDataConnections;
  runIndex: number;
  additional: WorkflowExecuteAdditionalData;
  signal: AbortSignal;
  getNodeOutput: ExpressionData['getNodeOutput'];
  logger: ILogger;
}

/** The `this` passed to `INodeType.execute()`. */
export class ExecuteContext implements IExecuteFunctions {
  readonly logs: string[] = [];
  readonly hints: string[] = [];
  readonly helpers: IExecuteHelpers;
  readonly logger: ILogger;

  constructor(private readonly opts: ExecuteContextOptions) {
    this.logger = opts.logger;
    const { additional, signal } = opts;
    this.helpers = {
      httpRequest: (options: IHttpRequestOptions): Promise<IHttpResponse> =>
        additional.httpRequest(options, signal),
      runCode: async (options: ICodeRunOptions): Promise<ICodeRunResult> => {
        const { result, logs } = await additional.codeSandbox.run({
          code: options.code,
          mode: options.mode,
          items: options.items,
          timeoutMs: options.timeoutMs,
          signal,
          meta: {
            workflow: this.getWorkflow(),
            execution: { id: additional.executionId, mode: additional.mode },
            node: { name: opts.node.name },
            timezone: this.getTimezone(),
            vars: additional.variables ?? {},
          },
        });
        logs.forEach((line) => this.log(line));
        return { items: result as INodeExecutionData[], logs };
      },
      returnJsonArray: (data) => toItems(data),
      prepareBinaryData: (data: Buffer, fileName?: string, mimeType?: string): IBinaryData => ({
        data: data.toString('base64'),
        mimeType: mimeType ?? 'application/octet-stream',
        fileName,
        fileExtension: fileName?.includes('.') ? fileName.split('.').pop() : undefined,
        fileSize: data.length,
      }),
    };
  }

  getInputData(inputIndex = 0): INodeExecutionData[] {
    return this.opts.inputData.main[inputIndex] ?? [];
  }

  getInputCount(): number {
    return this.opts.inputData.main.filter((input) => input !== null).length;
  }

  getNodeParameter<T = unknown>(
    name: string,
    itemIndex: number,
    fallback?: T,
    options: IGetNodeParameterOptions = {},
  ): T {
    const { node, nodeType } = this.opts;
    let value = getPath(node.parameters, name) as NodeParameterValueType;
    if (value === undefined) {
      value = findProperty(nodeType.description.properties, name)
        ?.default as NodeParameterValueType;
    }
    if (value === undefined) {
      if (fallback !== undefined) return fallback;
      throw new NodeOperationError(node, `Could not get parameter "${name}"`);
    }
    if (options.rawExpressions) return value as T;

    try {
      return resolveParameterValue(
        value,
        this.expressionData(itemIndex),
        this.opts.additional.expressionEvaluator,
      ) as T;
    } catch (error) {
      const displayName = findProperty(nodeType.description.properties, name)?.displayName ?? name;
      throw new ExpressionError(node, (error as Error).message, {
        description: `Problem in parameter "${displayName}" for item ${itemIndex}`,
        itemIndex,
        cause: error,
      });
    }
  }

  getNode(): INode {
    return this.opts.node;
  }

  getWorkflow() {
    const { workflow, additional } = this.opts;
    return { id: workflow.id, name: workflow.name, active: additional.workflowActive ?? false };
  }

  getExecutionId(): string {
    return this.opts.additional.executionId;
  }

  getMode() {
    return this.opts.additional.mode;
  }

  getTimezone(): string {
    return this.opts.workflow.settings.timezone ?? this.opts.additional.defaultTimezone ?? 'UTC';
  }

  getRunIndex(): number {
    return this.opts.runIndex;
  }

  continueOnFail(): boolean {
    const onError = this.opts.node.onError;
    return onError === 'continueRegularOutput' || onError === 'continueErrorOutput';
  }

  getSignal(): AbortSignal {
    return this.opts.signal;
  }

  log(message: string): void {
    if (this.logs.length < 1000) this.logs.push(message);
  }

  addHint(message: string): void {
    if (!this.hints.includes(message)) this.hints.push(message);
  }

  private expressionData(itemIndex: number): ExpressionData {
    const items = this.getInputData(0);
    const { additional, node, runIndex } = this.opts;
    return {
      item: items[itemIndex],
      itemIndex,
      runIndex,
      inputItems: items,
      getNodeOutput: this.opts.getNodeOutput,
      workflow: this.getWorkflow(),
      execution: { id: additional.executionId, mode: additional.mode },
      parameters: node.parameters as IDataObject,
      timezone: this.getTimezone(),
      vars: additional.variables ?? {},
    };
  }
}
