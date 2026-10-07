import type { IDataObject, INode, NodeErrorJSON } from './interfaces';

export interface NodeErrorOptions {
  description?: string;
  itemIndex?: number;
  context?: IDataObject;
  cause?: unknown;
}

/** Base error for anything that went wrong while executing a node. */
export class NodeError extends Error {
  readonly node?: string;
  readonly description?: string;
  readonly itemIndex?: number;
  readonly context?: IDataObject;
  readonly timestamp = Date.now();

  constructor(node: INode | string | undefined, message: string, options: NodeErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'NodeError';
    this.node = typeof node === 'string' ? node : node?.name;
    this.description = options.description;
    this.itemIndex = options.itemIndex;
    this.context = options.context;
  }

  toJSON(): NodeErrorJSON {
    return {
      name: this.name,
      message: this.message,
      description: this.description,
      node: this.node,
      itemIndex: this.itemIndex,
      context: this.context,
      timestamp: this.timestamp,
      stack: this.stack,
    };
  }
}

/** The node was configured incorrectly or the input data did not fit. */
export class NodeOperationError extends NodeError {
  constructor(node: INode | string | undefined, message: string, options: NodeErrorOptions = {}) {
    super(node, message, options);
    this.name = 'NodeOperationError';
  }
}

const HTTP_MESSAGES: Record<number, string> = {
  400: 'Bad request - please check your parameters',
  401: 'Authorization failed - please check your credentials',
  403: 'Forbidden - perhaps check your credentials?',
  404: 'The resource you are requesting could not be found',
  405: 'Method not allowed - please check you are using the right HTTP method',
  408: 'The request timed out',
  409: 'Conflict - the resource is in a conflicting state',
  413: 'The request payload is too large',
  422: 'The service could not process the request (unprocessable entity)',
  429: 'The service is receiving too many requests from you',
  500: 'The service was not able to process your request',
  502: 'Bad gateway - the service failed to handle your request',
  503: 'Service unavailable - try again later',
  504: 'Gateway timed out - perhaps try again later?',
};

export interface NodeApiErrorOptions extends NodeErrorOptions {
  httpCode?: number;
  responseBody?: unknown;
}

/** An external API returned an error. */
export class NodeApiError extends NodeError {
  readonly httpCode?: number;

  constructor(
    node: INode | string | undefined,
    message: string | undefined,
    options: NodeApiErrorOptions = {},
  ) {
    const code = options.httpCode;
    const friendly = code
      ? (HTTP_MESSAGES[code] ?? `Request failed with status code ${code}`)
      : undefined;
    super(node, message ?? friendly ?? 'The service returned an error', {
      ...options,
      description: options.description ?? describeBody(options.responseBody),
      context: {
        ...options.context,
        ...(code ? { httpCode: code } : {}),
      },
    });
    this.name = 'NodeApiError';
    this.httpCode = code;
  }

  override toJSON(): NodeErrorJSON {
    return { ...super.toJSON(), httpCode: this.httpCode };
  }
}

function describeBody(body: unknown): string | undefined {
  if (body === undefined || body === null || body === '') return undefined;
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return text.length > 1000 ? `${text.slice(0, 1000)}…` : text;
}

/** Problems with the workflow itself (no trigger, unknown node type, …). */
export class WorkflowOperationError extends Error {
  readonly node?: string;
  constructor(message: string, node?: string) {
    super(message);
    this.name = 'WorkflowOperationError';
    this.node = node;
  }
}

export class ExpressionError extends NodeError {
  constructor(node: INode | string | undefined, message: string, options: NodeErrorOptions = {}) {
    super(node, message, options);
    this.name = 'ExpressionError';
  }
}

/** Convert anything thrown into a serialisable error object. */
export function toNodeErrorJSON(error: unknown, node?: string): NodeErrorJSON {
  if (error instanceof NodeError) {
    const json = error.toJSON();
    return { ...json, node: json.node ?? node };
  }
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message || 'Unknown error',
      node: (error as { node?: string }).node ?? node,
      timestamp: Date.now(),
      stack: error.stack,
    };
  }
  return {
    name: 'Error',
    message: typeof error === 'string' ? error : JSON.stringify(error),
    node,
    timestamp: Date.now(),
  };
}
