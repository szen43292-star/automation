import type {
  ExecutionMode,
  IBinaryData,
  IDataObject,
  INode,
  INodeExecutionData,
  INodeParameters,
  INodeProperties,
  INodeTypeDescription,
  IWorkflowBase,
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
  /** Webhook triggers: turn an incoming HTTP request into items (or reject it). */
  webhook?(this: IWebhookFunctions): Promise<IWebhookResult>;
  /** Schedule triggers: cron expressions (5 or 6 fields) derived from the parameters. */
  cronExpressions?(parameters: INodeParameters): string[];
  /** Event triggers (triggerKind "event"): which events start the workflow. */
  eventSubscription?(parameters: INodeParameters): IEventSubscription;
}

/**
 * What an event trigger listens to, e.g. WhatsApp messages on one number:
 * `{ source: 'whatsapp', scope: '<accountId>' | '*', events: ['message'], filter: { messageType: ['text'] } }`.
 * See `matchesSubscription` for the matching rules.
 */
export interface IEventSubscription {
  source: string;
  scope: string;
  events: string[];
  filter?: Record<string, string[]>;
}

/** A WhatsApp message sent through a connected number. */
export interface IWhatsAppSendResult {
  messageId: string;
  to: string;
  accountId: string;
  /** The business number it was sent from. */
  from: string;
  /** True for the built-in simulator (nothing went to WhatsApp). */
  simulated: boolean;
}

export interface IWhatsAppMedia {
  data: Buffer;
  mimeType: string;
  fileName?: string;
  sha256?: string;
}

/**
 * WhatsApp access for nodes. Tokens never reach the node: the server looks up the connected
 * number by id and makes the Cloud API call itself.
 */
export interface IWhatsAppHelper {
  /** Send a Cloud API message object (`{ type: 'text', text: { body } }`, templates, media, …). */
  send(accountId: string, to: string, message: IDataObject): Promise<IWhatsAppSendResult>;
  /** Mark a received message as read (blue ticks), optionally showing "typing…". */
  markRead(accountId: string, messageId: string, options?: { typing?: boolean }): Promise<void>;
  uploadMedia(
    accountId: string,
    media: { data: Buffer; mimeType: string; fileName?: string },
  ): Promise<{ id: string }>;
  downloadMedia(accountId: string, mediaId: string): Promise<IWhatsAppMedia>;
  listTemplates(accountId: string): Promise<IDataObject[]>;
}

export interface IWebhookRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  query: Record<string, unknown>;
  body: unknown;
  rawBody?: Buffer;
  ip?: string;
}

export interface IWebhookResult {
  /** Items to start the workflow with (one array per output). */
  workflowData?: INodeExecutionData[][];
  /** Respond immediately without starting the workflow (e.g. 401). */
  response?: { status: number; body?: unknown; headers?: Record<string, string> };
}

export interface IWebhookFunctions {
  getRequest(): IWebhookRequest;
  getNode(): INode;
  /** Webhook parameters are resolved with the request as `$json` ({ headers, query, body }). */
  getNodeParameter<T = unknown>(name: string, fallback?: T): T;
  getCredentials<T extends object = IDataObject>(type: string): Promise<T>;
  getWorkflow(): { id?: string; name: string; active: boolean };
  getMode(): ExecutionMode;
  helpers: Pick<IExecuteHelpers, 'prepareBinaryData' | 'returnJsonArray'>;
}

/** Credential type definition (e.g. "httpHeaderAuth", "oAuth2Api"). */
export interface ICredentialType {
  name: string;
  displayName: string;
  icon?: string;
  documentationUrl?: string;
  properties: INodeProperties[];
  /** How the credential is applied to HTTP requests. */
  authenticate?: ICredentialAuthenticate;
  /** Request used by "Test connection". */
  test?: { request: IHttpRequestOptions; expectStatus?: number };
  /** OAuth2 credentials store tokens in `oauthTokenData`. */
  oauth2?: boolean;
}

export type ICredentialAuthenticate =
  | { type: 'header'; name: string; value: string }
  | { type: 'query'; name: string; value: string }
  | { type: 'basic'; username: string; password: string }
  | { type: 'bearer'; token: string }
  | { type: 'oauth2' };

export interface ICredentialTypes {
  get(name: string): ICredentialType | undefined;
  getAll(): ICredentialType[];
}

export interface IExecuteWorkflowSource {
  workflowId?: string;
  workflowData?: IWorkflowBase;
}

export interface IExecuteWorkflowResult {
  executionId: string;
  /** Output of the sub-workflow's last executed node (null when it produced nothing). */
  data: INodeExecutionData[][] | null;
}

export interface IWaitOptions {
  /** Resume at this time (null = no time limit). */
  waitTill: Date | null;
  /** Resume when /webhook-waiting/<executionId> is called. */
  resumeOnWebhook?: boolean;
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
  /** Decrypted credentials attached to this node (`node.credentials[type]`). */
  getCredentials<T extends object = IDataObject>(type: string): Promise<T>;
  /** Mutable state of this node that survives between its runs in one execution. */
  getContext(): IDataObject;
  /** Pause the execution after this node (Wait node). */
  putExecutionToWait(options: IWaitOptions): void;
  /** Items passed in when the execution resumes after a Wait (e.g. the resume webhook request). */
  getResumeData(): INodeExecutionData[] | undefined;
  /** Send the HTTP response of the webhook that started this execution ("Respond to Webhook"). */
  sendWebhookResponse(response: {
    status: number;
    body?: unknown;
    headers?: Record<string, string>;
  }): boolean;
  /** Base URL of the server (for resume URLs etc.). */
  getPublicUrl(): string;
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
  /** HTTP request with the given credential applied (refreshes OAuth2 tokens when needed). */
  httpRequestWithAuthentication(
    credentialType: string,
    options: IHttpRequestOptions,
  ): Promise<IHttpResponse>;
  /** Run another workflow and wait for its result. */
  executeWorkflow(
    source: IExecuteWorkflowSource,
    items: INodeExecutionData[],
    options?: { waitForCompletion?: boolean },
  ): Promise<IExecuteWorkflowResult>;
  runCode(options: ICodeRunOptions): Promise<ICodeRunResult>;
  returnJsonArray(data: IDataObject | IDataObject[]): INodeExecutionData[];
  prepareBinaryData(data: Buffer, fileName?: string, mimeType?: string): IBinaryData;
  /** Connected WhatsApp numbers (throws when the host has none configured). */
  whatsapp: IWhatsAppHelper;
}
