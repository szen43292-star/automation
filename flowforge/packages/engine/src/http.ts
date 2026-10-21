import type { IHttpRequestOptions, IHttpResponse } from '@flowforge/workflow';

/** Network-level failure (DNS, refused connection, timeout, …) with a friendly message. */
export class HttpRequestError extends Error {
  constructor(
    message: string,
    readonly code: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'HttpRequestError';
  }
}

const NETWORK_MESSAGES: Record<string, string> = {
  ENOTFOUND:
    'The DNS server returned an error, perhaps the server is offline or the domain is wrong',
  EAI_AGAIN: 'The DNS lookup timed out, perhaps the server is offline or the domain is wrong',
  ECONNREFUSED: 'The service refused the connection - perhaps it is offline',
  ECONNRESET: 'The connection to the server was closed unexpectedly, perhaps it is offline',
  ETIMEDOUT: 'The connection timed out - the server took too long to respond',
  EHOSTUNREACH: 'The host is unreachable',
  CERT_HAS_EXPIRED: 'The SSL certificate of the server has expired',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'The server uses a self-signed SSL certificate',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'The SSL certificate of the server could not be verified',
};

export function buildUrl(url: string, qs?: IHttpRequestOptions['qs']): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new HttpRequestError(
      `Invalid URL: "${url}". URLs must start with http:// or https://`,
      'INVALID_URL',
    );
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new HttpRequestError(
      `Unsupported protocol "${parsed.protocol}" - use http:// or https://`,
      'INVALID_URL',
    );
  }
  for (const [key, value] of Object.entries(qs ?? {})) {
    if (Array.isArray(value)) value.forEach((v) => parsed.searchParams.append(key, String(v)));
    else if (value !== undefined && value !== null) parsed.searchParams.append(key, String(value));
  }
  return parsed.toString();
}

function encodeBody(
  body: unknown,
  headers: Record<string, string>,
): string | Uint8Array | URLSearchParams | undefined {
  if (body === undefined || body === null) return undefined;
  if (body instanceof Uint8Array) return body;
  if (typeof body === 'string') return body;
  const contentType = headers['content-type'] ?? '';
  if (contentType.includes('application/x-www-form-urlencoded')) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
      params.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
    }
    return params;
  }
  if (!contentType) headers['content-type'] = 'application/json';
  return JSON.stringify(body);
}

/** Longest timeout timers accept (about 24.8 days); longer values would make the request fail. */
const MAX_TIMEOUT_MS = 2_147_483_647;

/** The timeout to use: the default when it is missing or not a positive number, capped at the maximum. */
export function requestTimeout(value: unknown): number {
  const ms = Number(value);
  if (value === undefined || value === null || value === '' || Number.isNaN(ms) || ms <= 0)
    return 300_000;
  return Math.min(Math.round(ms), MAX_TIMEOUT_MS);
}

function isTextual(contentType: string): boolean {
  return (
    contentType === '' ||
    contentType.startsWith('text/') ||
    /json|xml|javascript|x-www-form-urlencoded|csv|yaml|graphql/.test(contentType)
  );
}

export async function httpRequest(
  options: IHttpRequestOptions,
  signal?: AbortSignal,
): Promise<IHttpResponse> {
  const url = buildUrl(options.url, options.qs);
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(options.headers ?? {})) headers[k.toLowerCase()] = v;
  headers['user-agent'] ??= 'FlowForge';
  const body =
    method === 'GET' || method === 'HEAD' ? undefined : encodeBody(options.body, headers);

  const timeout = requestTimeout(options.timeout);
  const signals = [AbortSignal.timeout(timeout)];
  if (signal) signals.push(signal);

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: body as RequestInit['body'],
      redirect: options.followRedirects === false ? 'manual' : 'follow',
      signal: AbortSignal.any(signals),
    });
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error;
    const err = error as Error & { cause?: { code?: string; message?: string } };
    if (err.name === 'TimeoutError') {
      throw new HttpRequestError(`The request timed out after ${timeout} ms`, 'ETIMEDOUT', {
        cause: error,
      });
    }
    const code = err.cause?.code ?? 'ENETWORK';
    const host = new URL(url).host;
    const local = /^(localhost|127\.|\[::1\])/.test(host);
    const friendly =
      code === 'ECONNREFUSED' && local
        ? 'Nothing is running at this address on this computer - start the program that should answer here'
        : (NETWORK_MESSAGES[code] ?? err.cause?.message ?? err.message);
    throw new HttpRequestError(`${friendly} (${code} ${host})`, code, { cause: error });
  }

  const responseHeaders: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    responseHeaders[key] = value;
  });
  const contentType = (responseHeaders['content-type'] ?? '').toLowerCase();
  const responseType = options.responseType ?? 'auto';
  const buffer = Buffer.from(await response.arrayBuffer());

  let bodyOut: unknown;
  let binary: Buffer | undefined;
  if (responseType === 'binary' || (responseType === 'auto' && !isTextual(contentType))) {
    binary = buffer;
    bodyOut = undefined;
  } else {
    const text = buffer.toString('utf8');
    if (responseType === 'text') bodyOut = text;
    else if (responseType === 'json' || contentType.includes('json')) {
      try {
        bodyOut = text === '' ? {} : JSON.parse(text);
      } catch {
        if (responseType === 'json') {
          throw new HttpRequestError(
            'The response is not valid JSON. Set "Response Format" to Text to read it as-is.',
            'EJSON',
          );
        }
        bodyOut = text;
      }
    } else bodyOut = text;
  }

  return {
    statusCode: response.status,
    statusMessage: response.statusText,
    headers: responseHeaders,
    body: bodyOut,
    binary,
  };
}
