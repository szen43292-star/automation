import type { IDataObject } from './interfaces';
import type { ICredentialAuthenticate, IHttpRequestOptions } from './nodeTypes';

/** Replace `{{field}}` placeholders with credential values. */
export function fillCredentialTemplate(template: string, credentials: IDataObject): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, key: string) => {
    const value = credentials[key];
    return value === undefined || value === null ? '' : String(value);
  });
}

/** Return a copy of the request with the credential applied. */
export function applyCredentialAuthentication(
  authenticate: ICredentialAuthenticate,
  credentials: IDataObject,
  options: IHttpRequestOptions,
): IHttpRequestOptions {
  const headers = { ...(options.headers ?? {}) };
  const qs = { ...(options.qs ?? {}) };
  switch (authenticate.type) {
    case 'header':
      headers[fillCredentialTemplate(authenticate.name, credentials)] = fillCredentialTemplate(
        authenticate.value,
        credentials,
      );
      break;
    case 'query':
      qs[fillCredentialTemplate(authenticate.name, credentials)] = fillCredentialTemplate(
        authenticate.value,
        credentials,
      );
      break;
    case 'basic': {
      const user = fillCredentialTemplate(authenticate.username, credentials);
      const pass = fillCredentialTemplate(authenticate.password, credentials);
      headers.authorization = `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
      break;
    }
    case 'bearer':
      headers.authorization = `Bearer ${fillCredentialTemplate(authenticate.token, credentials)}`;
      break;
    case 'oauth2': {
      const token = (credentials.oauthTokenData as IDataObject | undefined)?.access_token;
      if (!token)
        throw new Error(
          'This OAuth2 credential is not connected yet. Open it and click "Connect".',
        );
      headers.authorization = `Bearer ${String(token)}`;
      break;
    }
  }
  return { ...options, headers, qs };
}

/** Placeholder returned to clients instead of secret values. */
export const CREDENTIAL_SECRET_MASK = '__flowforge_secret__';
