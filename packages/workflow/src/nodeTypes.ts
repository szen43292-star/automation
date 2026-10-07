import type {
  ExecutionMode,
  IBinaryData,
  IDataObject,
  INode,
  INodeExecutionData,
  INodeTypeDescription,
} from './interfaces';
import type { INodeTypeLookup } from './Workflow';

/**
 * Contract every node module implements (`packages/nodes`).
 * Implementations never import the engine: everything they need is provided
 * through `this` (IExecuteFunctions) at runtime.
 */
export interface INodeType {
  description: INodeTypeDescription;
  /**
   * Process input items and return one item array per output.
   * Return `null` to stop the branch without output.
   */
  execute?(this: IExecuteFunctions): Promise<INodeExecutionData[][] | null>;
}

export interface INodeTypes extends INodeTypeLookup {
  get(type: string): INodeType | undefined;
  getAll(): INodeType[];
}

export interface ILogger {
  debug(message: string, meta?: IDataObject): void;
  info(message: string, meta?: IDataObject): void;
  warn(message: string, meta?: IDataObject): void;
  error(message: string, meta?: IDataObject): void;
}

export interface IGetNodeParameterOptions {
  /** Return the raw value without resolving expressions. */
  rawExpressions?: boolean;
}

export interface IExecuteFunctions {
  getInputData(inputIndex?: number): INodeExecutionData[];
  /** Number of inputs that received data (for multi-input nodes). */
  getInputCount(): number;
  getNodeParameter<T = unknown>(
    name: string,
    itemIndex: number,
    fallback?: T,
    options?: IGetNodeParameterOptions,
  ): T;
  getNode(): INode;
  getWorkflow(): { id?: string; name: string; active: boolean };
  getExecutionId(): string;
  getMode(): ExecutionMode;
  getTimezone(): string;
  getRunIndex(): number;
  /** True when the node is configured to keep going after an error. */
  continueOnFail(): boolean;
  /** Aborted when the execution is cancelled or times out. */
  getSignal(): AbortSignal;
  /** Messages shown in the editor's output panel (e.g. console.log of Code node). */
  log(message: string): void;
  addHint(message: string): void;
  logger: ILogger;
  helpers: IExecuteHelpers;
}

export interface IHttpRequestOptions {
  url: string;
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';
  headers?: Record<string, string>;
  qs?: Record<string, string | number | boolean | Array<string | number | boolean>>;
  /** Objects are sent as JSON unless a content-type header says otherwise. */
  body?: unknown;
  /** Milliseconds. */
  timeout?: number;
  followRedirects?: boolean;
  maxRedirects?: number;
  responseType?: 'auto' | 'json' | 'text' | 'binary';
}

export interface IHttpResponse {
  statusCode: number;
  statusMessage: string;
  headers: Record<string, string>;
  body: unknown;
  /** Present when responseType is binary (or auto-detected as binary). */
  binary?: Buffer;
}

export type CodeMode = 'runOnceForAllItems' | 'runOnceForEachItem';

export interface ICodeRunOptions {
  code: string;
  mode: CodeMode;
  items: INodeExecutionData[];
  timeoutMs?: number;
}

export interface ICodeRunResult {
  /** For runOnceForAllItems: the returned items. For runOnceForEachItem: one result per input item. */
  items: INodeExecutionData[];
  logs: string[];
}

export interface IExecuteHelpers {
  httpRequest(options: IHttpRequestOptions): Promise<IHttpResponse>;
  runCode(options: ICodeRunOptions): Promise<ICodeRunResult>;
  returnJsonArray(data: IDataObject | IDataObject[]): INodeExecutionData[];
  prepareBinaryData(data: Buffer, fileName?: string, mimeType?: string): IBinaryData;
}
