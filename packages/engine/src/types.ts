import type {
  ExecutionMode,
  IDataObject,
  IExecuteWorkflowResult,
  IExecuteWorkflowSource,
  IExpressionEvaluator,
  IHttpRequestOptions,
  IHttpResponse,
  ILogger,
  INode,
  INodeExecutionData,
  INodeTypes,
  IRun,
  IRunData,
  IRunExecutionData,
  ITaskData,
} from '@flowforge/workflow';
import type { CodeSandbox } from './sandbox/CodeSandbox';

export interface IExecutionHooks {
  workflowExecuteBefore?(): void | Promise<void>;
  nodeExecuteBefore?(nodeName: string): void | Promise<void>;
  nodeExecuteAfter?(nodeName: string, task: ITaskData, runIndex: number): void | Promise<void>;
  workflowExecuteAfter?(run: IRun): void | Promise<void>;
}

/** Server-side access to the credentials vault. */
export interface ICredentialsHelper {
  /** Decrypted credential data attached to `node` for `type`. */
  getDecrypted(node: INode, type: string): Promise<IDataObject>;
  /** Apply the credential to a request; refreshes expired OAuth2 tokens. */
  authenticateRequest(
    node: INode,
    type: string,
    options: IHttpRequestOptions,
    retryAfterRefresh?: boolean,
  ): Promise<IHttpRequestOptions>;
  /** Force an OAuth2 refresh (called after a 401). Returns false if not refreshable. */
  refreshOAuth2?(node: INode, type: string): Promise<boolean>;
}

/** Everything the engine needs from its host (server, worker, tests). */
export interface WorkflowExecuteAdditionalData {
  executionId: string;
  mode: ExecutionMode;
  nodeTypes: INodeTypes;
  expressionEvaluator: IExpressionEvaluator;
  httpRequest(options: IHttpRequestOptions, signal?: AbortSignal): Promise<IHttpResponse>;
  codeSandbox: CodeSandbox;
  hooks?: IExecutionHooks;
  logger?: ILogger;
  /** External cancellation (user pressed "stop"). */
  signal?: AbortSignal;
  variables?: IDataObject;
  defaultTimezone?: string;
  workflowActive?: boolean;
  /** Infinite-loop protection. */
  maxNodeRuns?: number;
  credentials?: ICredentialsHelper;
  /** Run a sub-workflow (Execute Workflow node). */
  executeWorkflow?(
    source: IExecuteWorkflowSource,
    items: INodeExecutionData[],
    options: { waitForCompletion: boolean },
  ): Promise<IExecuteWorkflowResult>;
  /** Respond to the webhook that started this execution ("Respond to Webhook" node). */
  sendWebhookResponse?(response: {
    status: number;
    body?: unknown;
    headers?: Record<string, string>;
  }): boolean;
  publicUrl?: string;
}

export interface WorkflowRunOptions {
  /** Node id or name to start from (defaults to the first trigger). */
  startNode?: string;
  /** Node id or name to stop at: only this node and its ancestors run ("execute step"). */
  destinationNode?: string;
  /** Items fed into the start node (defaults to one empty item). */
  triggerItems?: INodeExecutionData[];
  /** Continue a previous execution (retry from the failed node, or resume after a Wait). */
  resumeFrom?: IRunExecutionData;
  /** Output of the waiting node when resuming (e.g. the resume webhook request). */
  resumeData?: INodeExecutionData[];
  /**
   * Partial execution: reuse these node outputs instead of running the nodes again.
   * Nodes listed in `dirtyNodes` (changed since that run) and their descendants run again.
   */
  runData?: IRunData;
  dirtyNodes?: string[];
}
