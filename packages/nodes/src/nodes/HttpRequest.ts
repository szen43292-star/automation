import {
  NodeApiError,
  NodeOperationError,
  isObject,
  type IDataObject,
  type IExecuteFunctions,
  type IHttpRequestOptions,
  type INodeExecutionData,
  type INodeType,
} from '@flowforge/workflow';
import { errorItem } from '../shared/helpers';

type NameValue = { name: string; value: unknown };

function pairsToObject(pairs: NameValue[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { name, value } of pairs ?? []) {
    if (!name) continue;
    out[name] = typeof value === 'object' ? JSON.stringify(value) : String(value ?? '');
  }
  return out;
}

export const HttpRequest: INodeType = {
  description: {
    name: 'flowforge.httpRequest',
    displayName: 'HTTP Request',
    icon: 'globe',
    iconColor: '#0088cc',
    group: ['core'],
    version: 1,
    description: 'Make an HTTP request to any URL or REST API',
    subtitle: '={{ $parameter.method }} {{ $parameter.url }}',
    defaults: { name: 'HTTP Request' },
    inputs: [{ type: 'main' }],
    outputs: [{ type: 'main' }],
    keywords: ['api', 'rest', 'fetch', 'curl', 'request', 'webhook'],
    properties: [
      {
        displayName: 'Method',
        name: 'method',
        type: 'options',
        default: 'GET',
        options: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].map((m) => ({
          name: m,
          value: m,
        })),
      },
      {
        displayName: 'URL',
        name: 'url',
        type: 'string',
        default: '',
        required: true,
        placeholder: 'https://api.example.com/v1/orders',
      },
      { displayName: 'Send Query Parameters', name: 'sendQuery', type: 'boolean', default: false },
      {
        displayName: 'Query Parameters',
        name: 'queryParameters',
        type: 'fixedCollection',
        typeOptions: { multipleValues: true },
        default: { parameters: [{ name: '', value: '' }] },
        displayOptions: { show: { sendQuery: [true] } },
        options: [
          {
            name: 'parameters',
            displayName: 'Parameter',
            values: [
              { displayName: 'Name', name: 'name', type: 'string', default: '' },
              { displayName: 'Value', name: 'value', type: 'string', default: '' },
            ],
          },
        ],
      },
      { displayName: 'Send Headers', name: 'sendHeaders', type: 'boolean', default: false },
      {
        displayName: 'Headers',
        name: 'headerParameters',
        type: 'fixedCollection',
        typeOptions: { multipleValues: true },
        default: { parameters: [{ name: '', value: '' }] },
        displayOptions: { show: { sendHeaders: [true] } },
        options: [
          {
            name: 'parameters',
            displayName: 'Header',
            values: [
              { displayName: 'Name', name: 'name', type: 'string', default: '' },
              { displayName: 'Value', name: 'value', type: 'string', default: '' },
            ],
          },
        ],
      },
      { displayName: 'Send Body', name: 'sendBody', type: 'boolean', default: false },
      {
        displayName: 'Body Content Type',
        name: 'contentType',
        type: 'options',
        default: 'json',
        displayOptions: { show: { sendBody: [true] } },
        options: [
          { name: 'JSON', value: 'json' },
          { name: 'Form URL-encoded', value: 'form-urlencoded' },
          { name: 'Raw', value: 'raw' },
        ],
      },
      {
        displayName: 'Specify Body',
        name: 'specifyBody',
        type: 'options',
        default: 'keypair',
        displayOptions: { show: { sendBody: [true], contentType: ['json', 'form-urlencoded'] } },
        options: [
          { name: 'Using Fields Below', value: 'keypair' },
          { name: 'Using JSON', value: 'json' },
        ],
      },
      {
        displayName: 'Body Parameters',
        name: 'bodyParameters',
        type: 'fixedCollection',
        typeOptions: { multipleValues: true },
        default: { parameters: [{ name: '', value: '' }] },
        displayOptions: {
          show: {
            sendBody: [true],
            specifyBody: ['keypair'],
            contentType: ['json', 'form-urlencoded'],
          },
        },
        options: [
          {
            name: 'parameters',
            displayName: 'Parameter',
            values: [
              { displayName: 'Name', name: 'name', type: 'string', default: '' },
              { displayName: 'Value', name: 'value', type: 'string', default: '' },
            ],
          },
        ],
      },
      {
        displayName: 'JSON',
        name: 'jsonBody',
        type: 'json',
        default: '{\n  "key": "value"\n}',
        typeOptions: { rows: 6, editor: 'json' },
        displayOptions: {
          show: {
            sendBody: [true],
            specifyBody: ['json'],
            contentType: ['json', 'form-urlencoded'],
          },
        },
      },
      {
        displayName: 'Content Type',
        name: 'rawContentType',
        type: 'string',
        default: 'text/plain',
        displayOptions: { show: { sendBody: [true], contentType: ['raw'] } },
      },
      {
        displayName: 'Body',
        name: 'rawBody',
        type: 'string',
        default: '',
        typeOptions: { rows: 5 },
        displayOptions: { show: { sendBody: [true], contentType: ['raw'] } },
      },
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        default: {},
        placeholder: 'Add option',
        options: [
          {
            displayName: 'Response Format',
            name: 'responseFormat',
            type: 'options',
            default: 'auto',
            options: [
              { name: 'Autodetect', value: 'auto' },
              { name: 'JSON', value: 'json' },
              { name: 'Text', value: 'text' },
              { name: 'File', value: 'binary' },
            ],
          },
          {
            displayName: 'Include Response Headers and Status',
            name: 'fullResponse',
            type: 'boolean',
            default: false,
          },
          {
            displayName: 'Never Error',
            name: 'neverError',
            type: 'boolean',
            default: false,
            description: 'Succeed even when the status code is not 2xx',
          },
          {
            displayName: 'Follow Redirects',
            name: 'followRedirects',
            type: 'boolean',
            default: true,
          },
          {
            displayName: 'Timeout (ms)',
            name: 'timeout',
            type: 'number',
            default: 300000,
            typeOptions: { minValue: 1 },
          },
          {
            displayName: 'Split Array Responses Into Items',
            name: 'splitIntoItems',
            type: 'boolean',
            default: true,
            description:
              'When the response body is an array of objects, output one item per element',
          },
        ],
      },
    ],
  },

  async execute(this: IExecuteFunctions) {
    const items = this.getInputData();
    const output: INodeExecutionData[] = [];

    for (let i = 0; i < items.length; i++) {
      try {
        const method = this.getNodeParameter<IHttpRequestOptions['method']>('method', i);
        const url = String(this.getNodeParameter('url', i) ?? '').trim();
        if (!url)
          throw new NodeOperationError(this.getNode(), 'The URL parameter is empty', {
            itemIndex: i,
          });

        const options = this.getNodeParameter<IDataObject>('options', i, {});
        const request: IHttpRequestOptions = {
          url,
          method,
          timeout: (options.timeout as number | undefined) ?? 300_000,
          followRedirects: (options.followRedirects as boolean | undefined) ?? true,
          responseType: ((options.responseFormat as string | undefined) ??
            'auto') as IHttpRequestOptions['responseType'],
          headers: {},
        };

        if (this.getNodeParameter('sendQuery', i, false)) {
          request.qs = pairsToObject(
            this.getNodeParameter<{ parameters?: NameValue[] }>('queryParameters', i, {})
              .parameters,
          );
        }
        if (this.getNodeParameter('sendHeaders', i, false)) {
          request.headers = pairsToObject(
            this.getNodeParameter<{ parameters?: NameValue[] }>('headerParameters', i, {})
              .parameters,
          );
        }
        if (this.getNodeParameter('sendBody', i, false)) {
          const contentType = this.getNodeParameter<string>('contentType', i, 'json');
          if (contentType === 'raw') {
            request.headers!['content-type'] = this.getNodeParameter<string>(
              'rawContentType',
              i,
              'text/plain',
            );
            request.body = this.getNodeParameter<string>('rawBody', i, '');
          } else {
            const specify = this.getNodeParameter<string>('specifyBody', i, 'keypair');
            let body: unknown;
            if (specify === 'json') {
              const raw = this.getNodeParameter<unknown>('jsonBody', i, '{}');
              if (typeof raw === 'string') {
                try {
                  body = raw.trim() === '' ? {} : JSON.parse(raw);
                } catch (error) {
                  throw new NodeOperationError(this.getNode(), 'The JSON body is not valid JSON', {
                    itemIndex: i,
                    description: (error as Error).message,
                  });
                }
              } else body = raw;
            } else {
              body = pairsToObject(
                this.getNodeParameter<{ parameters?: NameValue[] }>('bodyParameters', i, {})
                  .parameters,
              );
            }
            request.headers!['content-type'] =
              contentType === 'form-urlencoded'
                ? 'application/x-www-form-urlencoded'
                : 'application/json';
            request.body = body;
          }
        }

        let response;
        try {
          response = await this.helpers.httpRequest(request);
        } catch (error) {
          if ((error as Error).name === 'HttpRequestError') {
            throw new NodeApiError(this.getNode(), (error as Error).message, {
              itemIndex: i,
              description: `${method} ${url}`,
            });
          }
          throw error;
        }

        if (response.statusCode >= 400 && !options.neverError) {
          throw new NodeApiError(this.getNode(), undefined, {
            httpCode: response.statusCode,
            responseBody: response.body,
            itemIndex: i,
          });
        }

        if (response.binary) {
          const fileName = url.split('?')[0]!.split('/').pop() || 'file';
          const json: IDataObject = options.fullResponse
            ? { statusCode: response.statusCode, headers: response.headers }
            : {};
          output.push({
            json,
            binary: {
              data: this.helpers.prepareBinaryData(
                response.binary,
                fileName,
                response.headers['content-type'],
              ),
            },
            pairedItem: { item: i },
          });
          continue;
        }

        if (options.fullResponse) {
          output.push({
            json: {
              statusCode: response.statusCode,
              statusMessage: response.statusMessage,
              headers: response.headers,
              body: response.body as unknown,
            },
            pairedItem: { item: i },
          });
          continue;
        }

        const body = response.body;
        const split = (options.splitIntoItems as boolean | undefined) ?? true;
        if (Array.isArray(body) && split && body.every(isObject)) {
          for (const entry of body)
            output.push({ json: entry as IDataObject, pairedItem: { item: i } });
        } else if (isObject(body)) {
          output.push({ json: body, pairedItem: { item: i } });
        } else {
          output.push({ json: { data: body as unknown }, pairedItem: { item: i } });
        }
      } catch (error) {
        if (this.continueOnFail()) {
          output.push(errorItem(this, error, i, items[i]));
          continue;
        }
        throw error;
      }
    }
    return [output];
  },
};
