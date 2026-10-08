import { timingSafeEqual } from 'node:crypto';
import type {
  IDataObject,
  IExecuteFunctions,
  INodeExecutionData,
  INodeType,
  IWebhookFunctions,
  IWebhookResult,
} from '@flowforge/workflow';

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'];

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

function headerValue(headers: Record<string, string | string[] | undefined>, name: string): string {
  const value = headers[name.toLowerCase()];
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

export const Webhook: INodeType = {
  description: {
    name: 'flowforge.webhook',
    displayName: 'Webhook',
    icon: 'webhook',
    iconColor: '#885577',
    group: ['trigger'],
    triggerKind: 'webhook',
    webhook: { methodParameter: 'httpMethod', pathParameter: 'path' },
    version: 1,
    description: 'Start the workflow when an HTTP request is received',
    subtitle: '={{ $parameter.httpMethod }} /{{ $parameter.path }}',
    defaults: { name: 'Webhook' },
    inputs: [],
    outputs: [{ type: 'main' }],
    credentials: [
      {
        name: 'httpBasicAuth',
        required: true,
        displayOptions: { show: { authentication: ['basicAuth'] } },
      },
      {
        name: 'httpHeaderAuth',
        required: true,
        displayOptions: { show: { authentication: ['headerAuth'] } },
      },
    ],
    keywords: ['http', 'api', 'endpoint', 'callback', 'incoming', 'post'],
    properties: [
      {
        displayName: 'HTTP Method',
        name: 'httpMethod',
        type: 'options',
        default: 'POST',
        noDataExpression: true,
        options: METHODS.map((m) => ({ name: m, value: m })),
      },
      {
        displayName: 'Path',
        name: 'path',
        type: 'string',
        default: '',
        required: true,
        noDataExpression: true,
        typeOptions: { generateId: true },
        description: 'The URL path after /webhook/ - letters, numbers, - _ and /',
      },
      {
        displayName: 'Authentication',
        name: 'authentication',
        type: 'options',
        default: 'none',
        noDataExpression: true,
        options: [
          { name: 'None', value: 'none' },
          { name: 'Basic Auth', value: 'basicAuth' },
          { name: 'Header Auth', value: 'headerAuth' },
        ],
      },
      {
        displayName: 'Respond',
        name: 'responseMode',
        type: 'options',
        default: 'onReceived',
        noDataExpression: true,
        options: [
          {
            name: 'Immediately',
            value: 'onReceived',
            description: 'Respond as soon as the request arrives',
          },
          {
            name: 'When Last Node Finishes',
            value: 'lastNode',
            description: "Respond with the last node's output",
          },
          {
            name: "Using 'Respond to Webhook' Node",
            value: 'responseNode',
            description: 'Control the response in the workflow',
          },
        ],
      },
      {
        displayName: 'Response Code',
        name: 'responseCode',
        type: 'number',
        default: 200,
        noDataExpression: true,
        typeOptions: { minValue: 100, maxValue: 599 },
        displayOptions: { show: { responseMode: ['onReceived', 'lastNode'] } },
      },
      {
        displayName: 'Response Data',
        name: 'responseData',
        type: 'options',
        default: 'firstEntryJson',
        noDataExpression: true,
        displayOptions: { show: { responseMode: ['lastNode'] } },
        options: [
          { name: 'First Item JSON', value: 'firstEntryJson' },
          { name: 'All Items (array)', value: 'allEntries' },
          { name: 'No Response Body', value: 'noData' },
        ],
      },
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        default: {},
        placeholder: 'Add option',
        options: [
          {
            displayName: 'IP Allowlist',
            name: 'ipWhitelist',
            type: 'string',
            default: '',
            placeholder: '203.0.113.7, 198.51.100.0',
            description: 'Comma-separated IPs allowed to call this webhook (empty = everyone)',
          },
          {
            displayName: 'Include Raw Body',
            name: 'rawBody',
            type: 'boolean',
            default: false,
            description: 'Add the unparsed body as binary property "data"',
          },
        ],
      },
    ],
  },

  async webhook(this: IWebhookFunctions): Promise<IWebhookResult> {
    const request = this.getRequest();
    const authentication = this.getNodeParameter<string>('authentication', 'none');
    const allow = this.getNodeParameter<string>('options.ipWhitelist', '')
      .split(',')
      .map((ip) => ip.trim())
      .filter(Boolean);
    if (allow.length && (!request.ip || !allow.includes(request.ip.replace(/^::ffff:/, '')))) {
      return {
        response: { status: 403, body: { message: 'IP is not allowed to call this webhook' } },
      };
    }

    if (authentication === 'basicAuth') {
      const credentials = await this.getCredentials<{ user: string; password: string }>(
        'httpBasicAuth',
      );
      const header = headerValue(request.headers, 'authorization');
      const decoded = header.startsWith('Basic ')
        ? Buffer.from(header.slice(6), 'base64').toString('utf8')
        : '';
      const separator = decoded.indexOf(':');
      const ok =
        separator > -1 &&
        safeEqual(decoded.slice(0, separator), credentials.user ?? '') &&
        safeEqual(decoded.slice(separator + 1), credentials.password ?? '');
      if (!ok) {
        return {
          response: {
            status: 401,
            body: { message: 'Authorization required' },
            headers: { 'WWW-Authenticate': 'Basic realm="Webhook"' },
          },
        };
      }
    } else if (authentication === 'headerAuth') {
      const credentials = await this.getCredentials<{ name: string; value: string }>(
        'httpHeaderAuth',
      );
      if (
        !safeEqual(headerValue(request.headers, credentials.name ?? ''), credentials.value ?? '')
      ) {
        return { response: { status: 403, body: { message: 'Authorization data is wrong' } } };
      }
    }

    const item: INodeExecutionData = {
      json: {
        headers: request.headers as IDataObject,
        params: {},
        query: request.query as IDataObject,
        body: Buffer.isBuffer(request.body) ? {} : (request.body as IDataObject),
        method: request.method,
      },
    };
    const binaryBody = Buffer.isBuffer(request.body)
      ? request.body
      : this.getNodeParameter<boolean>('options.rawBody', false)
        ? request.rawBody
        : undefined;
    if (binaryBody?.length) {
      const contentType =
        headerValue(request.headers, 'content-type') || 'application/octet-stream';
      item.binary = {
        data: this.helpers.prepareBinaryData(binaryBody, undefined, contentType.split(';')[0]),
      };
    }
    return { workflowData: [[item]] };
  },

  async execute(this: IExecuteFunctions) {
    // Started by the server with the request item; in manual runs without a request, emit a sample.
    const items = this.getInputData();
    const hasRequest = items.some((i) => 'headers' in i.json);
    if (!hasRequest)
      this.addHint(
        'Run "Listen for test event" and call the test URL to receive real request data.',
      );
    return [items];
  },
};

export const RespondToWebhook: INodeType = {
  description: {
    name: 'flowforge.respondToWebhook',
    displayName: 'Respond to Webhook',
    icon: 'send',
    iconColor: '#885577',
    group: ['core'],
    version: 1,
    description:
      "Send the HTTP response of a Webhook set to respond 'Using Respond to Webhook node'",
    defaults: { name: 'Respond to Webhook' },
    inputs: [{ type: 'main' }],
    outputs: [{ type: 'main' }],
    keywords: ['http response', 'reply', 'return'],
    properties: [
      {
        displayName: 'Respond With',
        name: 'respondWith',
        type: 'options',
        default: 'firstIncomingItem',
        options: [
          { name: 'First Incoming Item', value: 'firstIncomingItem' },
          { name: 'All Incoming Items', value: 'allIncomingItems' },
          { name: 'JSON', value: 'json' },
          { name: 'Text', value: 'text' },
          { name: 'Redirect', value: 'redirect' },
          { name: 'No Data', value: 'noData' },
        ],
      },
      {
        displayName: 'Response Body',
        name: 'responseBody',
        type: 'json',
        default: '{\n  "ok": true\n}',
        typeOptions: { editor: 'json', rows: 5 },
        displayOptions: { show: { respondWith: ['json'] } },
      },
      {
        displayName: 'Response Body',
        name: 'responseText',
        type: 'string',
        default: '',
        typeOptions: { rows: 4 },
        displayOptions: { show: { respondWith: ['text'] } },
      },
      {
        displayName: 'Redirect URL',
        name: 'redirectURL',
        type: 'string',
        default: '',
        displayOptions: { show: { respondWith: ['redirect'] } },
      },
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        default: {},
        placeholder: 'Add option',
        options: [
          { displayName: 'Response Code', name: 'responseCode', type: 'number', default: 200 },
          {
            displayName: 'Response Headers',
            name: 'responseHeaders',
            type: 'fixedCollection',
            typeOptions: { multipleValues: true },
            default: { entries: [{ name: '', value: '' }] },
            options: [
              {
                name: 'entries',
                displayName: 'Header',
                values: [
                  { displayName: 'Name', name: 'name', type: 'string', default: '' },
                  { displayName: 'Value', name: 'value', type: 'string', default: '' },
                ],
              },
            ],
          },
        ],
      },
    ],
  },

  async execute(this: IExecuteFunctions) {
    const items = this.getInputData();
    const respondWith = this.getNodeParameter<string>('respondWith', 0);
    const status = Number(
      this.getNodeParameter('options.responseCode', 0, respondWith === 'redirect' ? 307 : 200),
    );
    const headers: Record<string, string> = {};
    for (const { name, value } of this.getNodeParameter<{
      entries?: Array<{ name: string; value: string }>;
    }>('options.responseHeaders', 0, {}).entries ?? []) {
      if (name) headers[name] = String(value);
    }
    let body: unknown;
    switch (respondWith) {
      case 'firstIncomingItem':
        body = items[0]?.json ?? {};
        break;
      case 'allIncomingItems':
        body = items.map((i) => i.json);
        break;
      case 'json': {
        const raw = this.getNodeParameter<unknown>('responseBody', 0, '{}');
        body = typeof raw === 'string' ? JSON.parse(raw || '{}') : raw;
        break;
      }
      case 'text':
        body = String(this.getNodeParameter('responseText', 0, ''));
        headers['content-type'] ??= 'text/plain; charset=utf-8';
        break;
      case 'redirect':
        headers.location = String(this.getNodeParameter('redirectURL', 0, ''));
        body = undefined;
        break;
      default:
        body = undefined;
    }
    const sent = this.sendWebhookResponse({ status, body, headers });
    if (!sent) {
      this.addHint(
        "No HTTP response was sent: this run wasn't started by a Webhook set to respond 'Using Respond to Webhook node' (or a response was already sent).",
      );
    }
    return [items];
  },
};
