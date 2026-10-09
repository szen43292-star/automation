/**
 * Minimal client for Meta's Graph API (WhatsApp Business Cloud API).
 * The base URL is configurable so tests run against a local fake.
 */

export interface GraphErrorBody {
  message?: string;
  type?: string;
  code?: number;
  error_subcode?: number;
  error_user_title?: string;
  error_user_msg?: string;
  error_data?: { details?: string };
  fbtrace_id?: string;
}

/** Plain-language help for the WhatsApp errors people actually run into. */
const HINTS: Record<number, string> = {
  131047:
    'More than 24 hours have passed since the customer last messaged you. Send an approved template instead (WhatsApp node → Send Template).',
  131026:
    'The message could not be delivered - the number may not be on WhatsApp, or the customer has not accepted the latest terms.',
  131030:
    'This number is not in your test allow-list. In Meta WhatsApp Manager add it under "To" phone numbers, or use a production number.',
  131021: 'You cannot send a message to your own business number.',
  131031: 'This WhatsApp Business account is locked or restricted by Meta. Check WhatsApp Manager.',
  131042:
    'There is a payment problem with this WhatsApp Business account. Add a payment method in WhatsApp Manager.',
  131051: 'This message type is not supported.',
  131053:
    'The media could not be uploaded or downloaded - check the URL is public and the file type is supported.',
  132000: 'The number of template variables does not match the template.',
  132001:
    'Template not found for this language. Check the template name and language code, and that it is approved.',
  132005: 'The template text is too long after filling in the variables.',
  132007: 'The template content breaks WhatsApp policy.',
  132015: 'The template is paused because of low quality.',
  133010:
    'The phone number is not registered with the Cloud API yet. Use "Refresh" on the WhatsApp page to finish setup.',
  131056: 'Too many messages to the same customer in a short time. Slow down and try again.',
  130429: 'WhatsApp rate limit reached. Messages will go through again shortly.',
  80007: 'WhatsApp rate limit reached for this account. Try again later.',
  4: 'Too many requests to Meta. Try again in a moment.',
  10: 'Permission denied - the connection may be missing the whatsapp_business_messaging permission. Reconnect the number.',
  100: 'Meta rejected a parameter of this request.',
  190: 'The access token has expired or was revoked. Reconnect the number on the WhatsApp page.',
  200: 'Permission denied by Meta. Reconnect the number on the WhatsApp page.',
};

export class GraphApiError extends Error {
  readonly status: number;
  readonly code?: number;
  readonly subcode?: number;
  readonly description?: string;
  readonly fbtraceId?: string;

  constructor(status: number, body: GraphErrorBody | undefined, fallback: string) {
    const detail = body?.error_data?.details || body?.error_user_msg;
    super(
      `WhatsApp: ${body?.message || fallback}${detail && !body?.message?.includes(detail) ? ` - ${detail}` : ''}`,
    );
    this.name = 'GraphApiError';
    this.status = status;
    this.code = body?.code;
    this.subcode = body?.error_subcode;
    this.description = (body?.code && HINTS[body.code]) || undefined;
    this.fbtraceId = body?.fbtrace_id;
  }
}

export interface GraphRequest {
  method?: 'GET' | 'POST' | 'DELETE';
  /** Path after the version, e.g. `/12345/messages`. */
  path: string;
  token?: string;
  query?: Record<string, string | number | undefined>;
  json?: unknown;
  form?: FormData;
  timeoutMs?: number;
}

export class GraphClient {
  constructor(
    private readonly baseUrl: string,
    private readonly version: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  url(path: string, query?: GraphRequest['query']): string {
    const url = new URL(
      `${this.baseUrl.replace(/\/+$/, '')}/${this.version}${path.startsWith('/') ? path : `/${path}`}`,
    );
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  async request<T = Record<string, unknown>>(req: GraphRequest): Promise<T> {
    const headers: Record<string, string> = {};
    if (req.token) headers.authorization = `Bearer ${req.token}`;
    let body: RequestInit['body'];
    if (req.json !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(req.json);
    } else if (req.form) {
      body = req.form;
    }
    let response: Response;
    try {
      response = await this.fetchImpl(this.url(req.path, req.query), {
        method: req.method ?? (body ? 'POST' : 'GET'),
        headers,
        body,
        signal: AbortSignal.timeout(req.timeoutMs ?? 30_000),
      });
    } catch (error) {
      throw new GraphApiError(0, undefined, `could not reach Meta (${(error as Error).message})`);
    }
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = { raw: text };
    }
    if (!response.ok) {
      throw new GraphApiError(
        response.status,
        (parsed as { error?: GraphErrorBody }).error,
        `request failed with HTTP ${response.status}`,
      );
    }
    return parsed as T;
  }

  /** Download a media file from the short-lived URL returned for a media id (needs the token). */
  async download(url: string, token: string): Promise<{ data: Buffer; mimeType: string }> {
    const response = await this.fetchImpl(url, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok)
      throw new GraphApiError(
        response.status,
        undefined,
        `media download failed with HTTP ${response.status}`,
      );
    return {
      data: Buffer.from(await response.arrayBuffer()),
      mimeType: response.headers.get('content-type') ?? 'application/octet-stream',
    };
  }
}
