import {
  NodeApiError,
  type IDataObject,
  type IExecuteFunctions,
  type IHttpRequestOptions,
  type IHttpResponse,
} from '@flowforge/workflow';

/** Message from a Google API error body ({ error: { message } }). */
function googleMessage(body: unknown): string | undefined {
  const error = (body as { error?: { message?: unknown } | string } | null)?.error;
  if (typeof error === 'string') return error;
  return typeof error?.message === 'string' ? error.message : undefined;
}

/**
 * A request to a Google API with the node's OAuth2 (or API key) credential. Fails with the
 * message Google gives, e.g. "Requested entity was not found." for a wrong spreadsheet ID.
 */
export async function googleRequest(
  ctx: IExecuteFunctions,
  credentialType: string,
  options: IHttpRequestOptions,
  itemIndex: number,
): Promise<IHttpResponse> {
  const response = await ctx.helpers.httpRequestWithAuthentication(credentialType, {
    timeout: 120_000,
    ...options,
  });
  if (response.statusCode >= 400) {
    throw new NodeApiError(ctx.getNode(), googleMessage(response.body), {
      httpCode: response.statusCode,
      responseBody: response.body,
      itemIndex,
      description: `${options.method ?? 'GET'} ${options.url.split('?')[0]}`,
    });
  }
  return response;
}

export async function googleJson(
  ctx: IExecuteFunctions,
  credentialType: string,
  options: IHttpRequestOptions,
  itemIndex: number,
): Promise<IDataObject> {
  const { body } = await googleRequest(ctx, credentialType, options, itemIndex);
  return body && typeof body === 'object' ? (body as IDataObject) : {};
}

/** Comma- or newline-separated list, or an array, as trimmed non-empty strings. */
export function toList(value: unknown): string[] {
  const parts = Array.isArray(value) ? value : String(value ?? '').split(/[,\n]/);
  return parts.map((part) => String(part ?? '').trim()).filter(Boolean);
}
