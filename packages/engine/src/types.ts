import type {
  ExecutionMode,
  IDataObject,
  IExpressionEvaluator,
  IHttpRequestOptions,
  IHttpResponse,
  ILogger,
  INodeExecutionData,
  INodeTypes,
  IRun,
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
}

export interface WorkflowRunOptions {
  /** Node id or name to start from (defaults to the first trigger). */
  startNode?: string;
  /** Node id or name to stop at: only this node and its ancestors run ("execute step"). */
  destinationNode?: string;
  /** Items fed into the start node (defaults to one empty item). */
  triggerItems?: INodeExecutionData[];
  /** Continue a previous execution (retry from the failed node). */
  resumeFrom?: IRunExecutionData;
}
