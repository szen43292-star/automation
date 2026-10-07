/**
 * Core FlowForge data model.
 *
 * Everything in this file must stay JSON-serialisable: it is shared between the
 * server, the execution engine, node implementations and the editor.
 */

// ---------------------------------------------------------------------------
// Item data
// ---------------------------------------------------------------------------

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

/** Free-form object carried in `item.json`. */
export interface IDataObject {
  [key: string]: unknown;
}

export interface IBinaryData {
  /** Base64 encoded payload (inline mode). */
  data: string;
  mimeType: string;
  fileName?: string;
  fileExtension?: string;
  fileSize?: number;
}

export interface IPairedItem {
  /** Index of the item in the input that produced this item. */
  item: number;
  /** Input index (for nodes with more than one input). */
  input?: number;
}

/** A single item flowing between nodes: `{ json, binary? }`. */
export interface INodeExecutionData {
  json: IDataObject;
  binary?: Record<string, IBinaryData>;
  pairedItem?: IPairedItem | IPairedItem[] | number;
  /** Set by nodes when an item failed and the node continues on fail. */
  error?: NodeErrorJSON;
}

// ---------------------------------------------------------------------------
// Node parameters & properties
// ---------------------------------------------------------------------------

export type NodeParameterValue = string | number | boolean | null | undefined;
export type NodeParameterValueType =
  NodeParameterValue | INodeParameters | NodeParameterValue[] | INodeParameters[];

export interface INodeParameters {
  [key: string]: NodeParameterValueType;
}

export type NodePropertyType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'options'
  | 'multiOptions'
  | 'json'
  | 'code'
  | 'dateTime'
  | 'color'
  | 'notice'
  | 'collection'
  | 'fixedCollection'
  | 'filter'
  | 'assignmentCollection';

export interface INodePropertyOption {
  name: string;
  value: string | number | boolean;
  description?: string;
}

export interface IDisplayOptions {
  /** Show the property only when every listed parameter has one of the given values. */
  show?: Record<string, Array<string | number | boolean>>;
  /** Hide the property when any listed parameter has one of the given values. */
  hide?: Record<string, Array<string | number | boolean>>;
}

export interface INodePropertyTypeOptions {
  rows?: number;
  minValue?: number;
  maxValue?: number;
  numberPrecision?: number;
  password?: boolean;
  multipleValues?: boolean;
  sortable?: boolean;
  editor?: 'js' | 'json' | 'sql' | 'markdown';
  /** The editor fills a random id when the node is added (e.g. webhook paths). */
  generateId?: boolean;
  /** Options loaded from the server: GET /api/node-options/<method> (e.g. "workflows"). */
  loadOptionsMethod?: string;
}

/** A fixedCollection groups repeated value sets, e.g. `sortFields.values[]`. */
export interface INodePropertyCollection {
  name: string;
  displayName: string;
  values: INodeProperties[];
}

export interface INodeProperties {
  displayName: string;
  name: string;
  type: NodePropertyType;
  default: NodeParameterValueType;
  description?: string;
  hint?: string;
  placeholder?: string;
  required?: boolean;
  /** For options / multiOptions (INodePropertyOption), collection (INodeProperties) and fixedCollection. */
  options?: Array<INodePropertyOption | INodeProperties | INodePropertyCollection>;
  displayOptions?: IDisplayOptions;
  typeOptions?: INodePropertyTypeOptions;
  /** When true the editor does not offer the expression toggle. */
  noDataExpression?: boolean;
}

// ---------------------------------------------------------------------------
// Node types
// ---------------------------------------------------------------------------

export type NodeGroup =
  | 'trigger'
  | 'core'
  | 'flow'
  | 'transform'
  | 'data'
  | 'ai'
  | 'whatsapp'
  | 'apps'
  | 'utility'
  | 'annotation';

export type ConnectionType = 'main';

export interface INodeIO {
  type: ConnectionType;
  /** Label shown on the handle, e.g. "true" / "false". */
  displayName?: string;
}

export interface INodeCredentialDescription {
  name: string;
  required?: boolean;
  displayOptions?: IDisplayOptions;
}

export interface IDynamicOutputs {
  /** Parameter that selects how outputs are computed (e.g. Switch "mode"). */
  modeParameter?: string;
  /** Per mode (or `default`): outputs from an array parameter or a count parameter. */
  modes: Record<
    string,
    {
      /** Dotted path to an array parameter; one output per entry. */
      fromArray?: string;
      /** Field of each entry used as the label when `labelToggle` is true. */
      labelField?: string;
      labelToggle?: string;
      /** Parameter holding a number of outputs. */
      fromCount?: string;
    }
  >;
  /** Extra output (e.g. "Fallback") added when a parameter has a given value. */
  extra?: { parameter: string; equals: string | number | boolean; label: string };
}

export interface INodeTypeDescription {
  /** Unique type id, e.g. `flowforge.httpRequest`. */
  name: string;
  displayName: string;
  /** Lucide icon name (e.g. `globe`) rendered by the editor. */
  icon: string;
  iconColor?: string;
  group: NodeGroup[];
  version: number;
  description: string;
  /** Short template rendered under the node name, may reference parameters as `={{$parameter.x}}`. */
  subtitle?: string;
  defaults: { name: string; color?: string };
  inputs: INodeIO[];
  outputs: INodeIO[];
  credentials?: INodeCredentialDescription[];
  properties: INodeProperties[];
  /** Max instances allowed in one workflow. */
  maxNodes?: number;
  /**
   * How a trigger node starts executions:
   * - manual: only from the editor
   * - webhook: an HTTP request to /webhook/<path> (see `webhook`)
   * - schedule: cron rules (see INodeType.cronExpressions)
   * - subworkflow: another workflow's "Execute Workflow" node
   * - error: another workflow failed (error workflow)
   * - event: an internal event source (WhatsApp messages/calls, phase 3+)
   */
  triggerKind?: 'manual' | 'webhook' | 'schedule' | 'subworkflow' | 'error' | 'event';
  /** Webhook routing for nodes that receive HTTP requests. */
  webhook?: {
    /** Parameter holding the HTTP method (or a fixed method). */
    methodParameter?: string;
    method?: string;
    pathParameter: string;
  };
  /** Outputs computed from parameters (e.g. one output per Switch rule). */
  dynamicOutputs?: IDynamicOutputs;
  /** Alternative search terms for the node panel. */
  keywords?: string[];
  documentationUrl?: string;
}

// ---------------------------------------------------------------------------
// Workflow
// ---------------------------------------------------------------------------

export type OnErrorBehaviour = 'stopWorkflow' | 'continueRegularOutput' | 'continueErrorOutput';

export interface INodeCredentialsRef {
  id: string;
  name: string;
}

export interface INode {
  id: string;
  name: string;
  type: string;
  typeVersion: number;
  position: [number, number];
  parameters: INodeParameters;
  disabled?: boolean;
  notes?: string;
  credentials?: Record<string, INodeCredentialsRef>;
  retryOnFail?: boolean;
  /** Total attempts when retryOnFail is set (2-10). */
  maxTries?: number;
  /** Milliseconds between retries. */
  waitBetweenTries?: number;
  onError?: OnErrorBehaviour;
  /** Emit one empty item when the node produced no output, so downstream nodes still run. */
  alwaysOutputData?: boolean;
  /** Execute only for the first input item. */
  executeOnce?: boolean;
  /** Sticky notes and other annotation nodes keep their size here. */
  width?: number;
  height?: number;
}

export interface IConnection {
  /** Source node id. */
  source: string;
  sourceOutput: number;
  /** Target node id. */
  target: string;
  targetInput: number;
}

export interface IWorkflowSettings {
  /** IANA timezone used by date nodes and $now. */
  timezone?: string;
  /** Hard limit for a single execution in seconds. */
  executionTimeout?: number;
  saveManualExecutions?: boolean;
  saveDataSuccessExecution?: 'all' | 'none';
  saveDataErrorExecution?: 'all' | 'none';
  /** Workflow id started when a production execution of this workflow fails. */
  errorWorkflow?: string;
  /** Max production executions of this workflow running at the same time. */
  maxConcurrency?: number;
}

/** Map of node name → pinned output items. */
export type IPinData = Record<string, INodeExecutionData[]>;

export interface IWorkflowBase {
  id?: string;
  name: string;
  nodes: INode[];
  connections: IConnection[];
  settings?: IWorkflowSettings;
  pinData?: IPinData;
  active?: boolean;
  versionId?: string;
}

// ---------------------------------------------------------------------------
// Execution data
// ---------------------------------------------------------------------------

export type ExecutionMode = 'manual' | 'trigger' | 'webhook' | 'retry' | 'internal' | 'error';
export type ExecutionStatus =
  'new' | 'running' | 'success' | 'error' | 'canceled' | 'crashed' | 'waiting';

export interface ISourceData {
  previousNode: string;
  previousNodeOutput: number;
  previousNodeRun: number;
}

export interface ITaskDataConnections {
  main: Array<INodeExecutionData[] | null>;
}

export interface ITaskData {
  startTime: number;
  executionTime: number;
  executionStatus: 'success' | 'error' | 'canceled';
  /** Where every input came from (one entry per input index). */
  source: Array<ISourceData | null>;
  data?: ITaskDataConnections;
  error?: NodeErrorJSON;
  /** console.log output captured from Code nodes, hints, … */
  logs?: string[];
  hints?: string[];
}

/** Node name → list of runs (a node runs more than once in loops). */
export type IRunData = Record<string, ITaskData[]>;

export interface IExecuteStackEntry {
  nodeId: string;
  data: ITaskDataConnections;
  source: Array<ISourceData | null>;
}

export interface IWaitingEntry {
  nodeId: string;
  data: ITaskDataConnections;
  source: Array<ISourceData | null>;
}

export interface IRunExecutionData {
  /** Per-node state that survives between runs of a node (e.g. Loop Over Items). */
  contextData?: Record<string, IDataObject>;
  /** Set when the execution is paused by a Wait node. */
  waitTill?: string;
  /** Node the execution is waiting in (resumes there). */
  waitingNode?: string;
  resultData: {
    runData: IRunData;
    lastNodeExecuted?: string;
    error?: NodeErrorJSON;
  };
  /** Remaining work – persisted so failed executions can be retried from the failed node. */
  executionData?: {
    nodeExecutionStack: IExecuteStackEntry[];
    waitingExecution: IWaitingEntry[];
  };
}

export interface IRun {
  status: Exclude<ExecutionStatus, 'new' | 'running'>;
  mode: ExecutionMode;
  startedAt: string;
  stoppedAt: string;
  data: IRunExecutionData;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export interface NodeErrorJSON {
  name: string;
  message: string;
  description?: string;
  node?: string;
  itemIndex?: number;
  httpCode?: number;
  /** Raw response / context useful for debugging (kept small). */
  context?: IDataObject;
  timestamp: number;
  stack?: string;
}
