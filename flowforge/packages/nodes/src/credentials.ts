import type { ICredentialType, ICredentialTypes } from '@flowforge/workflow';

export const httpHeaderAuth: ICredentialType = {
  name: 'httpHeaderAuth',
  displayName: 'Header Auth',
  icon: 'shield-check',
  properties: [
    {
      displayName: 'Header Name',
      name: 'name',
      type: 'string',
      default: '',
      placeholder: 'X-API-Key',
      required: true,
    },
    {
      displayName: 'Header Value',
      name: 'value',
      type: 'string',
      default: '',
      typeOptions: { password: true },
      required: true,
    },
  ],
  authenticate: { type: 'header', name: '{{name}}', value: '{{value}}' },
};

export const httpBasicAuth: ICredentialType = {
  name: 'httpBasicAuth',
  displayName: 'Basic Auth',
  icon: 'shield-check',
  properties: [
    { displayName: 'User', name: 'user', type: 'string', default: '', required: true },
    {
      displayName: 'Password',
      name: 'password',
      type: 'string',
      default: '',
      typeOptions: { password: true },
    },
  ],
  authenticate: { type: 'basic', username: '{{user}}', password: '{{password}}' },
};

export const httpQueryAuth: ICredentialType = {
  name: 'httpQueryAuth',
  displayName: 'Query Auth',
  icon: 'shield-check',
  properties: [
    {
      displayName: 'Parameter Name',
      name: 'name',
      type: 'string',
      default: '',
      placeholder: 'api_key',
      required: true,
    },
    {
      displayName: 'Parameter Value',
      name: 'value',
      type: 'string',
      default: '',
      typeOptions: { password: true },
      required: true,
    },
  ],
  authenticate: { type: 'query', name: '{{name}}', value: '{{value}}' },
};

export const httpBearerAuth: ICredentialType = {
  name: 'httpBearerAuth',
  displayName: 'Bearer Token',
  icon: 'shield-check',
  properties: [
    {
      displayName: 'Token',
      name: 'token',
      type: 'string',
      default: '',
      typeOptions: { password: true },
      required: true,
    },
    {
      displayName: 'Test URL',
      name: 'testUrl',
      type: 'string',
      default: '',
      placeholder: 'https://api.example.com/me',
      description: 'Optional: a GET endpoint used by "Test connection"',
    },
  ],
  authenticate: { type: 'bearer', token: '{{token}}' },
};

export const oAuth2Api: ICredentialType = {
  name: 'oAuth2Api',
  displayName: 'OAuth2 API',
  icon: 'shield-check',
  oauth2: true,
  properties: [
    {
      displayName: 'Grant Type',
      name: 'grantType',
      type: 'options',
      default: 'authorizationCode',
      options: [
        { name: 'Authorization Code', value: 'authorizationCode' },
        { name: 'Client Credentials', value: 'clientCredentials' },
      ],
    },
    {
      displayName: 'Authorization URL',
      name: 'authUrl',
      type: 'string',
      default: '',
      placeholder: 'https://accounts.example.com/oauth/authorize',
      displayOptions: { show: { grantType: ['authorizationCode'] } },
    },
    {
      displayName: 'Access Token URL',
      name: 'accessTokenUrl',
      type: 'string',
      default: '',
      required: true,
    },
    { displayName: 'Client ID', name: 'clientId', type: 'string', default: '', required: true },
    {
      displayName: 'Client Secret',
      name: 'clientSecret',
      type: 'string',
      default: '',
      typeOptions: { password: true },
      required: true,
    },
    { displayName: 'Scope', name: 'scope', type: 'string', default: '', placeholder: 'read write' },
    {
      displayName: 'Auth URI Query Parameters',
      name: 'authQueryParameters',
      type: 'string',
      default: '',
      placeholder: 'access_type=offline&prompt=consent',
      displayOptions: { show: { grantType: ['authorizationCode'] } },
    },
    {
      displayName: 'Send Client Credentials',
      name: 'authentication',
      type: 'options',
      default: 'header',
      options: [
        { name: 'As Basic Auth Header', value: 'header' },
        { name: 'In Body', value: 'body' },
      ],
    },
  ],
  authenticate: { type: 'oauth2' },
};

const GOOGLE_OAUTH2 = {
  grantType: 'authorizationCode',
  authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  accessTokenUrl: 'https://oauth2.googleapis.com/token',
  // A refresh token is only handed out with offline access, and again only after consent.
  authQueryParameters: 'access_type=offline&prompt=consent',
  authentication: 'body',
};

/** A Google account connected through your own Google Cloud OAuth client. */
function googleOAuth2(
  name: string,
  displayName: string,
  scope: string,
  api: string,
): ICredentialType {
  return {
    name,
    displayName,
    icon: 'shield-check',
    documentationUrl: 'https://console.cloud.google.com/apis/credentials',
    oauth2: true,
    oauth2Defaults: { ...GOOGLE_OAUTH2, scope },
    properties: [
      {
        displayName: `In Google Cloud Console: enable the ${api}, create an OAuth client ID (type "Web application"), add the OAuth Redirect URL shown above as an authorized redirect URI, then paste the client ID and secret here and click "Connect account".`,
        name: 'notice',
        type: 'notice',
        default: '',
      },
      { displayName: 'Client ID', name: 'clientId', type: 'string', default: '', required: true },
      {
        displayName: 'Client Secret',
        name: 'clientSecret',
        type: 'string',
        default: '',
        typeOptions: { password: true },
        required: true,
      },
    ],
    authenticate: { type: 'oauth2' },
  };
}

export const youTubeOAuth2Api = googleOAuth2(
  'youTubeOAuth2Api',
  'YouTube OAuth2 API',
  'https://www.googleapis.com/auth/youtube https://www.googleapis.com/auth/youtube.upload',
  'YouTube Data API v3',
);

export const googleSheetsOAuth2Api = googleOAuth2(
  'googleSheetsOAuth2Api',
  'Google Sheets OAuth2 API',
  'https://www.googleapis.com/auth/spreadsheets',
  'Google Sheets API',
);

export const gmailOAuth2 = googleOAuth2(
  'gmailOAuth2',
  'Gmail OAuth2 API',
  'https://www.googleapis.com/auth/gmail.send',
  'Gmail API',
);

export const googlePalmApi: ICredentialType = {
  name: 'googlePalmApi',
  displayName: 'Google Gemini (PaLM) API',
  icon: 'sparkles',
  documentationUrl: 'https://aistudio.google.com/apikey',
  properties: [
    {
      displayName: 'Host',
      name: 'host',
      type: 'string',
      default: 'https://generativelanguage.googleapis.com',
    },
    {
      displayName: 'API Key',
      name: 'apiKey',
      type: 'string',
      default: '',
      typeOptions: { password: true },
      required: true,
      description: 'Create one at https://aistudio.google.com/apikey',
    },
  ],
  authenticate: { type: 'header', name: 'x-goog-api-key', value: '{{apiKey}}' },
  test: {
    request: { url: 'https://generativelanguage.googleapis.com/v1beta/models', method: 'GET' },
  },
};

export const builtinCredentialTypes: ICredentialType[] = [
  httpHeaderAuth,
  httpBasicAuth,
  httpQueryAuth,
  httpBearerAuth,
  oAuth2Api,
  youTubeOAuth2Api,
  googleSheetsOAuth2Api,
  gmailOAuth2,
  googlePalmApi,
];

export class CredentialTypeRegistry implements ICredentialTypes {
  private readonly types = new Map<string, ICredentialType>();
  constructor(types: ICredentialType[] = builtinCredentialTypes) {
    types.forEach((t) => this.types.set(t.name, t));
  }
  get(name: string) {
    return this.types.get(name);
  }
  getAll() {
    return [...this.types.values()];
  }
}
