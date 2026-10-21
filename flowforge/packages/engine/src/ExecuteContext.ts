import {
  ExpressionError,
  NodeApiError,
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
  type IWaitOptions,
  type IWhatsAppHelper,
  type NodeParameterValueType,
  type PairedItemResult,
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
  getPairedItem: (nodeName: string, itemIndex: number) => PairedItemResult;
  nodeContext: IDataObject;
  resumeData?: INodeExecutionData[];
  logger: ILogger;
}

export function prepareBinaryData(data: Buffer, fileName?: string, mimeType?: string): IBinaryData {
  return {
    data: data.toString('base64'),
    mimeType: mimeType ?? 'application/octet-stream',
    fileName,
    fileExtension: fileName?.includes('.') ? fileName.split('.').pop() : undefined,
    fileSize: data.length,
  };
}

/** The `this` passed to `INodeType.execute()`. */
export class ExecuteContext implements IExecuteFunctions {
  readonly logs: string[] = [];
  readonly hints: string[] = [];
  readonly helpers: IExecuteHelpers;
  readonly logger: ILogger;
  waitRequest?: IWaitOptions;

  constructor(private readonly opts: ExecuteContextOptions) {
    this.logger = opts.logger;
    const { additional, signal, node } = opts;
    this.helpers = {
      httpRequest: (options: IHttpRequestOptions): Promise<IHttpResponse> =>
        additional.httpRequest(options, signal),
      httpRequestWithAuthentication: async (credentialType, options) => {
        const credentials = additional.credentials;
        if (!credentials)
          throw new NodeOperationError(node, 'Credentials are not available in this context');
        const authed = await credentials.authenticateRequest(node, credentialType, options);
        const response = await additional.httpRequest(authed, signal);
        // Expired OAuth2 access token: refresh once and retry.
        if (
          response.statusCode === 401 &&
          credentials.refreshOAuth2 &&
          (await credentials.refreshOAuth2(node, credentialType))
        ) {
          return additional.httpRequest(
            await credentials.authenticateRequest(node, credentialType, options),
            signal,
          );
        }
        return response;
      },
      executeWorkflow: async (source, items, options) => {
        if (!additional.executeWorkflow) {
          throw new NodeOperationError(node, 'Sub-workflows cannot be executed in this context');
        }
        return additional.executeWorkflow(source, items, {
          waitForCompletion: options?.waitForCompletion ?? true,
        });
      },
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
            node: { name: node.name },
            timezone: this.getTimezone(),
            vars: additional.variables ?? {},
          },
        });
        logs.forEach((line) => this.log(line));
        return { items: result as INodeExecutionData[], logs };
      },
      returnJsonArray: (data) => toItems(data),
      prepareBinaryData,
      whatsapp: additional.whatsapp ?? unavailableWhatsApp(node),
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

  async getCredentials<T extends object = IDataObject>(type: string): Promise<T> {
    const { node, additional } = this.opts;
    if (!node.credentials?.[type]) {
      throw new NodeOperationError(node, `No "${type}" credential selected`, {
        description: 'Open the node and choose (or create) a credential.',
      });
    }
    if (!additional.credentials)
      throw new NodeOperationError(node, 'Credentials are not available in this context');
    try {
      return (await additional.credentials.getDecrypted(node, type)) as T;
    } catch (error) {
      if (error instanceof NodeApiError || error instanceof NodeOperationError) throw error;
      throw new NodeOperationError(node, (error as Error).message);
    }
  }

  getContext(): IDataObject {
    return this.opts.nodeContext;
  }

  putExecutionToWait(options: IWaitOptions): void {
    this.waitRequest = options;
  }

  getResumeData(): INodeExecutionData[] | undefined {
    return this.opts.resumeData;
  }

  sendWebhookResponse(response: {
    status: number;
    body?: unknown;
    headers?: Record<string, string>;
  }): boolean {
    return this.opts.additional.sendWebhookResponse?.(response) ?? false;
  }

  getPublicUrl(): string {
    return (this.opts.additional.publicUrl ?? 'http://localhost:5678').replace(/\/+$/, '');
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
      getPairedItem: this.opts.getPairedItem,
      workflow: this.getWorkflow(),
      execution: {
        id: additional.executionId,
        mode: additional.mode,
        resumeUrl: `${this.getPublicUrl()}/webhook-waiting/${additional.executionId}`,
      },
      parameters: node.parameters as IDataObject,
      timezone: this.getTimezone(),
      vars: additional.variables ?? {},
    };
  }
}

/** Stand-in when the host has no WhatsApp support (e.g. a plain engine in tests). */
function unavailableWhatsApp(node: INode): IWhatsAppHelper {
  const fail = async (): Promise<never> => {
    throw new NodeOperationError(node, 'WhatsApp is not available here', {
      description: 'Run this workflow on a AutoForge server with a connected WhatsApp number.',
    });
  };
  return {
    send: fail,
    markRead: fail,
    uploadMedia: fail,
    downloadMedia: fail,
    listTemplates: fail,
  };
}
