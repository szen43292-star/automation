import { createHash, randomBytes } from 'node:crypto';
import type { IDataObject } from '@flowforge/workflow';

export interface OAuth2Settings {
  grantType?: 'authorizationCode' | 'clientCredentials';
  authUrl?: string;
  accessTokenUrl: string;
  clientId: string;
  clientSecret: string;
  scope?: string;
  authQueryParameters?: string;
  authentication?: 'header' | 'body';
}

export interface OAuth2TokenData extends IDataObject {
  access_token: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
  /** Epoch ms when the access token expires (computed). */
  expires_at?: number;
  scope?: string;
}

export function pkcePair() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export function buildAuthorizationUrl(
  settings: OAuth2Settings,
  redirectUri: string,
  state: string,
  codeChallenge: string,
): string {
  if (!settings.authUrl) throw new Error('The credential has no Authorization URL');
  const url = new URL(settings.authUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', settings.clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  if (settings.scope) url.searchParams.set('scope', settings.scope);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  for (const [k, v] of new URLSearchParams(settings.authQueryParameters ?? ''))
    url.searchParams.set(k, v);
  return url.toString();
}

async function tokenRequest(
  settings: OAuth2Settings,
  params: Record<string, string>,
): Promise<OAuth2TokenData> {
  const body = new URLSearchParams(params);
  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
    accept: 'application/json',
  };
  if (settings.authentication === 'body') {
    body.set('client_id', settings.clientId);
    body.set('client_secret', settings.clientSecret);
  } else {
    headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(settings.clientId)}:${encodeURIComponent(settings.clientSecret)}`).toString('base64')}`;
  }
  const response = await fetch(settings.accessTokenUrl, {
    method: 'POST',
    headers,
    body,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  let data: IDataObject;
  try {
    data = JSON.parse(text) as IDataObject;
  } catch {
    data = Object.fromEntries(new URLSearchParams(text)) as IDataObject;
  }
  if (!response.ok || !data.access_token) {
    const reason = String(data.error_description ?? data.error ?? text.slice(0, 300));
    throw new Error(`The OAuth2 token request failed (${response.status}): ${reason}`);
  }
  const token = data as OAuth2TokenData;
  if (token.expires_in) token.expires_at = Date.now() + Number(token.expires_in) * 1000;
  return token;
}

export function exchangeCode(
  settings: OAuth2Settings,
  code: string,
  redirectUri: string,
  codeVerifier: string,
) {
  return tokenRequest(settings, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
  });
}

export function clientCredentialsToken(settings: OAuth2Settings) {
  return tokenRequest(settings, {
    grant_type: 'client_credentials',
    ...(settings.scope ? { scope: settings.scope } : {}),
  });
}

export async function refreshToken(
  settings: OAuth2Settings,
  token: OAuth2TokenData,
): Promise<OAuth2TokenData> {
  if (settings.grantType === 'clientCredentials') return clientCredentialsToken(settings);
  if (!token.refresh_token)
    throw new Error(
      'The OAuth2 token expired and there is no refresh token - reconnect the credential',
    );
  const fresh = await tokenRequest(settings, {
    grant_type: 'refresh_token',
    refresh_token: token.refresh_token,
  });
  // Some providers don't rotate refresh tokens.
  return { ...fresh, refresh_token: fresh.refresh_token ?? token.refresh_token };
}

/** True when the token expires within the next minute. */
export function isExpired(token: OAuth2TokenData | undefined): boolean {
  return (
    !token?.access_token ||
    (typeof token.expires_at === 'number' && token.expires_at - 60_000 < Date.now())
  );
}
