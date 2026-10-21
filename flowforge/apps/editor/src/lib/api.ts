import type {
  ICredentialType,
  IDataObject,
  IRunData,
  IConnection,
  INode,
  INodeTypeDescription,
  IPinData,
  IRunExecutionData,
  IWorkflowSettings,
} from '@flowforge/workflow';

const SERVER_KEY = 'ff.serverUrl';
const TOKEN_KEY = 'ff.token';

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * Base URL of the FlowForge server. Empty string = same origin (editor served by
 * the server or through the Vite proxy). Desktop and mobile builds set a URL.
 */
export function getServerUrl(): string {
  return storage()?.getItem(SERVER_KEY) ?? import.meta.env.VITE_DEFAULT_SERVER_URL ?? '';
}

export function setServerUrl(url: string) {
  const clean = url.trim().replace(/\/+$/, '');
  if (clean) storage()?.setItem(SERVER_KEY, clean);
  else storage()?.removeItem(SERVER_KEY);
}

export function getToken(): string | null {
  return storage()?.getItem(TOKEN_KEY) ?? null;
}

export function setToken(token: string | null) {
  if (token) storage()?.setItem(TOKEN_KEY, token);
  else storage()?.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body?: {
      error?: string;
      message?: string;
      issues?: Array<{ path: string; message: string }>;
    },
  ) {
    super(message);
  }
}

let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(handler: () => void) {
  onUnauthorized = handler;
}

export async function api<T>(
  path: string,
  options: { method?: string; body?: unknown; signal?: AbortSignal; auth?: boolean } = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token && options.auth !== false) headers.authorization = `Bearer ${token}`;
  if (options.body !== undefined) headers['content-type'] = 'application/json';

  let response: Response;
  try {
    response = await fetch(`${getServerUrl()}${path}`, {
      method: options.method ?? (options.body !== undefined ? 'POST' : 'GET'),
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: options.signal,
    });
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw error;
    throw new ApiError(
      0,
      `Cannot reach the FlowForge server${getServerUrl() ? ` at ${getServerUrl()}` : ''}. Check your connection.`,
    );
  }

  if (response.status === 204) return undefined as T;
  const text = await response.text();
  let body: unknown = undefined;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = { message: text };
  }
  if (!response.ok) {
    const b = (body ?? {}) as ApiError['body'];
    if (response.status === 401 && options.auth !== false) onUnauthorized?.();
    throw new ApiError(response.status, b?.message ?? `Request failed (${response.status})`, b);
  }
  return body as T;
}

/** Download a file with the session's token (e.g. a call recording) as a Blob. */
export async function apiBlob(path: string): Promise<Blob> {
  const token = getToken();
  const response = await fetch(`${getServerUrl()}${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  if (!response.ok) throw new ApiError(response.status, `Download failed (${response.status})`);
  return response.blob();
}

// --- DTOs -------------------------------------------------------------------

export type Role = 'owner' | 'admin' | 'member';
export interface User {
  id: string;
  email: string;
  name: string;
  role: Role;
}

export interface WorkflowDTO {
  id: string;
  name: string;
  active: boolean;
  nodes: INode[];
  connections: IConnection[];
  settings: IWorkflowSettings;
  pinData?: IPinData;
  versionId: string;
  ownerId: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowListItem {
  id: string;
  name: string;
  active: boolean;
  versionId: string;
  owner: { id: string; name: string };
  createdAt: string;
  updatedAt: string;
  nodeCount: number;
  nodeTypes: string[];
}

export type ExecutionStatus =
  'new' | 'running' | 'success' | 'error' | 'canceled' | 'crashed' | 'waiting';

export interface ExecutionSummary {
  id: string;
  workflowId: string;
  workflowName: string;
  status: ExecutionStatus;
  mode: string;
  startedAt: string | null;
  stoppedAt: string | null;
  durationMs: number | null;
  lastNodeExecuted: string | null;
  errorMessage: string | null;
  retryOfId: string | null;
  retrySuccessId: string | null;
  waitTill?: string | null;
  parentExecutionId?: string | null;
}

export interface ExecutionDetail extends Omit<ExecutionSummary, 'durationMs'> {
  running: boolean;
  workflowData:
    | (Pick<WorkflowDTO, 'name' | 'nodes' | 'connections' | 'settings'> & { pinData?: IPinData })
    | null;
  data: IRunExecutionData | null;
}

export interface ServerSettings {
  publicUrl: string;
  executionsMode: 'regular' | 'queue';
  oauthCallbackUrl: string;
  version: string;
}

export interface Variable {
  id: string;
  key: string;
  value: string;
}

export interface CredentialSummary {
  id: string;
  name: string;
  type: string;
  owner?: { id: string; name: string };
  createdAt: string;
  updatedAt: string;
}

export interface CredentialDetail extends CredentialSummary {
  data: IDataObject;
}

export interface VersionSummary {
  versionId: string;
  name: string;
  createdAt: string;
  author: { id: string; name: string } | null;
}

export const endpoints = {
  status: () =>
    api<{ setupRequired: boolean; version: string }>('/api/auth/status', { auth: false }),
  setup: (body: { email: string; name: string; password: string }) =>
    api<{ token: string; user: User }>('/api/auth/setup', { body, auth: false }),
  login: (body: { email: string; password: string }) =>
    api<{ token: string; user: User }>('/api/auth/login', { body, auth: false }),
  me: () => api<{ user: User }>('/api/auth/me'),
  nodeTypes: () => api<{ data: INodeTypeDescription[] }>('/api/node-types'),
  workflows: (params: { search?: string; limit?: number; offset?: number } = {}) => {
    const q = new URLSearchParams();
    if (params.search) q.set('search', params.search);
    q.set('limit', String(params.limit ?? 100));
    if (params.offset) q.set('offset', String(params.offset));
    return api<{ total: number; data: WorkflowListItem[] }>(`/api/workflows?${q}`);
  },
  workflow: (id: string) => api<WorkflowDTO>(`/api/workflows/${id}`),
  createWorkflow: (body: Partial<WorkflowDTO>) => api<WorkflowDTO>('/api/workflows', { body }),
  importWorkflow: (body: unknown) => api<WorkflowDTO>('/api/workflows/import', { body }),
  updateWorkflow: (id: string, body: Partial<WorkflowDTO>) =>
    api<WorkflowDTO>(`/api/workflows/${id}`, { method: 'PATCH', body }),
  deleteWorkflow: (id: string) => api<void>(`/api/workflows/${id}`, { method: 'DELETE' }),
  versions: (id: string) => api<{ data: VersionSummary[] }>(`/api/workflows/${id}/versions`),
  version: (id: string, versionId: string) =>
    api<Pick<WorkflowDTO, 'name' | 'nodes' | 'connections' | 'settings' | 'versionId'>>(
      `/api/workflows/${id}/versions/${versionId}`,
    ),
  run: (
    id: string,
    body: {
      workflowData?: Partial<WorkflowDTO>;
      destinationNode?: string;
      startNode?: string;
      runData?: IRunData;
      dirtyNodes?: string[];
    },
  ) => api<{ executionId: string }>(`/api/workflows/${id}/run`, { body }),
  executions: (
    params: { workflowId?: string; status?: string; cursor?: string; limit?: number } = {},
  ) => {
    const q = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => v !== undefined && v !== '' && q.set(k, String(v)));
    return api<{ data: ExecutionSummary[]; nextCursor: string | null }>(`/api/executions?${q}`);
  },
  execution: (id: string) => api<ExecutionDetail>(`/api/executions/${id}`),
  stopExecution: (id: string) =>
    api<{ stopped: boolean }>(`/api/executions/${id}/stop`, { method: 'POST' }),
  retryExecution: (id: string, useCurrentWorkflow: boolean) =>
    api<{ executionId: string }>(`/api/executions/${id}/retry`, { body: { useCurrentWorkflow } }),
  deleteExecution: (id: string) => api<void>(`/api/executions/${id}`, { method: 'DELETE' }),
  settings: () => api<ServerSettings>('/api/settings'),
  variables: () => api<{ data: Variable[] }>('/api/variables'),
  createVariable: (body: { key: string; value: string }) =>
    api<Variable>('/api/variables', { body }),
  updateVariable: (id: string, body: { key?: string; value?: string }) =>
    api<Variable>(`/api/variables/${id}`, { method: 'PATCH', body }),
  deleteVariable: (id: string) => api<void>(`/api/variables/${id}`, { method: 'DELETE' }),
  credentialTypes: () => api<{ data: ICredentialType[] }>('/api/credential-types'),
  credentials: (type?: string) =>
    api<{ data: CredentialSummary[] }>(
      `/api/credentials${type ? `?type=${encodeURIComponent(type)}` : ''}`,
    ),
  credential: (id: string) => api<CredentialDetail>(`/api/credentials/${id}`),
  createCredential: (body: { name: string; type: string; data: IDataObject }) =>
    api<CredentialDetail>('/api/credentials', { body }),
  updateCredential: (id: string, body: { name?: string; data?: IDataObject }) =>
    api<CredentialDetail>(`/api/credentials/${id}`, { method: 'PATCH', body }),
  deleteCredential: (id: string) => api<void>(`/api/credentials/${id}`, { method: 'DELETE' }),
  testCredential: (body: { type: string; data: IDataObject; id?: string }) =>
    api<{ ok: boolean; message: string }>('/api/credentials/test', { body }),
  oauthUrl: (id: string) =>
    api<{ url: string; redirectUri: string }>(`/api/credentials/${id}/oauth2/auth-url`),
  nodeOptions: (method: string, query: Record<string, string> = {}) => {
    const qs = new URLSearchParams(query).toString();
    return api<{ data: Array<{ name: string; value: string }> }>(
      `/api/node-options/${method}${qs ? `?${qs}` : ''}`,
    );
  },
  listenWebhook: (
    workflowId: string,
    body: { nodeId: string; workflowData: Partial<WorkflowDTO> },
  ) =>
    api<
      | { kind: 'webhook'; testUrl: string; method: string; expiresInSeconds: number }
      | { kind: 'event'; source: string; expiresInSeconds: number }
    >(`/api/workflows/${workflowId}/webhook-test`, { body }),
  stopListening: (workflowId: string) =>
    api<void>(`/api/workflows/${workflowId}/webhook-test`, { method: 'DELETE' }),
  // WhatsApp
  whatsappPlatform: () => api<WhatsAppPlatform>('/api/whatsapp/platform'),
  saveWhatsappPlatform: (body: { appId?: string; appSecret?: string; configId?: string }) =>
    api<{ appId: string | null; configId: string | null; appSecretSet: boolean }>(
      '/api/whatsapp/platform',
      { method: 'PUT', body },
    ),
  whatsappChecklist: () =>
    api<{ steps: ChecklistStep[]; simulators: number }>('/api/whatsapp/checklist'),
  whatsappAccounts: () => api<{ data: WhatsAppAccount[] }>('/api/whatsapp/accounts'),
  connectEmbeddedSignup: (body: { code: string; wabaId: string; phoneNumberId: string }) =>
    api<WhatsAppAccount>('/api/whatsapp/accounts/embedded-signup', { body }),
  connectManual: (body: { wabaId: string; phoneNumberId: string; accessToken: string }) =>
    api<WhatsAppAccount>('/api/whatsapp/accounts/manual', { body }),
  createTestNumber: (body: { name?: string }) =>
    api<WhatsAppAccount>('/api/whatsapp/accounts/simulator', { body }),
  refreshWhatsappAccount: (id: string) =>
    api<WhatsAppAccount>(`/api/whatsapp/accounts/${id}/refresh`, { method: 'POST' }),
  disconnectWhatsappAccount: (id: string) =>
    api<void>(`/api/whatsapp/accounts/${id}`, { method: 'DELETE' }),
  whatsappConversations: (id: string) =>
    api<{ data: WhatsAppConversation[] }>(`/api/whatsapp/accounts/${id}/conversations`),
  whatsappMessages: (id: string, contact?: string) =>
    api<{ data: WhatsAppMessage[] }>(
      `/api/whatsapp/accounts/${id}/messages?limit=100${contact ? `&contact=${contact}` : ''}`,
    ),
  sendWhatsapp: (id: string, body: { to: string; text: string }) =>
    api<{ messageId: string }>(`/api/whatsapp/accounts/${id}/send`, { body }),
  simulateWhatsapp: (
    id: string,
    body: {
      from: string;
      name?: string;
      text?: string;
      reply?: { id: string; title: string; type: 'button' | 'list' };
      location?: { latitude: number; longitude: number; name?: string };
      media?: { base64: string; mimeType: string; fileName?: string; caption?: string };
      callPermission?: 'accept' | 'reject';
    },
  ) => api<{ messageId: string }>(`/api/whatsapp/accounts/${id}/simulate`, { body }),
  // Calls
  calls: (query: { accountId?: string; status?: string; limit?: number } = {}) => {
    const qs = new URLSearchParams(
      Object.entries(query)
        .filter(([, v]) => v !== undefined && v !== '')
        .map(([k, v]) => [k, String(v)]),
    ).toString();
    return api<{ data: CallDTO[] }>(`/api/calls${qs ? `?${qs}` : ''}`);
  },
  activeCalls: () =>
    api<{ data: Array<CallDTO & { ringSeconds: number; ringing: boolean }> }>('/api/calls/active'),
  answerCall: (id: string, sdp: string) =>
    api<{ sdp: string }>(`/api/calls/${id}/answer`, { body: { sdp } }),
  declineCall: (id: string) => api<void>(`/api/calls/${id}/decline`, { method: 'POST' }),
  hangupCall: (id: string) => api<void>(`/api/calls/${id}/hangup`, { method: 'POST' }),
  deleteRecording: (id: string) => api<void>(`/api/calls/${id}/recording`, { method: 'DELETE' }),
  callSettings: (accountId: string) =>
    api<CallSettingsResponse>(`/api/whatsapp/accounts/${accountId}/calling`),
  saveCallSettings: (accountId: string, settings: CallSettings) =>
    api<CallSettingsResponse>(`/api/whatsapp/accounts/${accountId}/calling`, {
      method: 'PUT',
      body: settings,
    }),
  enableCalling: (accountId: string) =>
    api<CallSettingsResponse>(`/api/whatsapp/accounts/${accountId}/calling/enable`, {
      method: 'POST',
    }),
  setGreeting: (accountId: string, base64: string | null) =>
    api<void>(`/api/whatsapp/accounts/${accountId}/calling/greeting`, {
      method: 'PUT',
      body: { base64 },
    }),
  simulateCall: (accountId: string, body: { from: string; name?: string; sdp: string }) =>
    api<{ waCallId: string; sdp?: string; rejected?: boolean }>(
      `/api/whatsapp/accounts/${accountId}/simulate-call`,
      { body },
    ),
  simulateHangup: (accountId: string, waCallId: string) =>
    api<void>(`/api/whatsapp/accounts/${accountId}/simulate-call/${waCallId}/hangup`, {
      method: 'POST',
    }),
  callPermission: (accountId: string, to: string) =>
    api<{
      status: 'none' | 'requested' | 'granted' | 'denied' | 'expired';
      expiresAt: string | null;
    }>(`/api/whatsapp/accounts/${accountId}/call-permission?to=${encodeURIComponent(to)}`),
  requestCallPermission: (accountId: string, to: string, text?: string) =>
    api<{ alreadyGranted: boolean }>(`/api/whatsapp/accounts/${accountId}/call-permission`, {
      body: { to, text },
    }),
  outboundCall: (body: {
    accountId: string;
    to: string;
    handler: 'agent' | 'person';
    agentId?: string | null;
    purpose?: string;
    sdp?: string;
  }) => api<{ callId: string; waCallId: string; sdp?: string }>('/api/calls/outbound', { body }),
  simulateOutboundAnswer: (accountId: string, waCallId: string, sdp: string) =>
    api<void>(`/api/whatsapp/accounts/${accountId}/simulate-call/${waCallId}/answer`, {
      body: { sdp },
    }),
  simulateOutboundDecline: (accountId: string, waCallId: string) =>
    api<void>(`/api/whatsapp/accounts/${accountId}/simulate-call/${waCallId}/decline`, {
      method: 'POST',
    }),
  setNumberAgent: (accountId: string, agentId: string | null) =>
    api<{ agentId: string | null }>(`/api/whatsapp/accounts/${accountId}/agent`, {
      method: 'PUT',
      body: { agentId },
    }),
  // Dashboard, templates, team, API keys
  dashboard: (days: number, timezone: string) =>
    api<DashboardData>(`/api/dashboard?days=${days}&timezone=${encodeURIComponent(timezone)}`),
  templates: () => api<{ data: WorkflowTemplate[] }>('/api/templates'),
  useTemplate: (id: string) =>
    api<{ id: string; name: string; setup: string[]; missingCredentials?: string[] }>(
      `/api/templates/${id}/use`,
      {
        method: 'POST',
      },
    ),
  users: () => api<{ data: TeamMember[] }>('/api/users'),
  inviteUser: (body: { email: string; name: string; role: User['role'] }) =>
    api<{ user: TeamMember; inviteUrl: string }>('/api/users', { body }),
  reinviteUser: (id: string) =>
    api<{ inviteUrl: string }>(`/api/users/${id}/invite`, { method: 'POST' }),
  updateUser: (id: string, body: { name?: string; role?: User['role'] }) =>
    api<TeamMember>(`/api/users/${id}`, { method: 'PATCH', body }),
  removeUser: (id: string) => api<void>(`/api/users/${id}`, { method: 'DELETE' }),
  updateMe: (body: { name?: string; currentPassword?: string; newPassword?: string }) =>
    api<{ user: User }>('/api/auth/me', { method: 'PATCH', body }),
  invitation: (token: string) =>
    api<{ email: string; name: string; role: User['role'] }>(`/api/auth/invite/${token}`, {
      auth: false,
    }),
  acceptInvitation: (token: string, body: { password: string; name?: string }) =>
    api<{ token: string; user: User }>(`/api/auth/invite/${token}`, { body, auth: false }),
  apiKeys: () => api<{ data: ApiKey[] }>('/api/api-keys'),
  createApiKey: (body: { name: string; expiresInDays: number | null }) =>
    api<ApiKey & { key: string }>('/api/api-keys', { body }),
  deleteApiKey: (id: string) => api<void>(`/api/api-keys/${id}`, { method: 'DELETE' }),
  // AI providers and agents
  aiProviders: () => api<{ data: AiProvider[] }>('/api/ai/providers'),
  saveAiProviders: (keys: Partial<Record<AiProviderId, string | null>>) =>
    api<{ data: AiProvider[] }>('/api/ai/providers', { method: 'PUT', body: keys }),
  agentOptions: () => api<AgentOptions>('/api/agents/options'),
  aiModels: (provider: string, purpose: 'llm' | 'stt') =>
    api<{ data: string[]; automatic: string | null }>(
      `/api/ai/models?provider=${encodeURIComponent(provider)}&purpose=${purpose}`,
    ),
  agents: () => api<{ data: AgentSummary[] }>('/api/agents'),
  agent: (id: string) => api<AgentDetail>(`/api/agents/${id}`),
  createAgent: (body: AgentInput) => api<AgentDetail>('/api/agents', { body }),
  updateAgent: (id: string, body: AgentInput) =>
    api<AgentDetail>(`/api/agents/${id}`, { method: 'PUT', body }),
  deleteAgent: (id: string) => api<void>(`/api/agents/${id}`, { method: 'DELETE' }),
  addDocument: (id: string, body: { title: string; content: string }) =>
    api<{ id: string }>(`/api/agents/${id}/documents`, { body }),
  document: (id: string, documentId: string) =>
    api<{ id: string; title: string; content: string }>(
      `/api/agents/${id}/documents/${documentId}`,
    ),
  updateDocument: (id: string, documentId: string, body: { title: string; content: string }) =>
    api<{ id: string }>(`/api/agents/${id}/documents/${documentId}`, { method: 'PUT', body }),
  deleteDocument: (id: string, documentId: string) =>
    api<void>(`/api/agents/${id}/documents/${documentId}`, { method: 'DELETE' }),
  searchKnowledge: (id: string, q: string) =>
    api<{ data: Array<{ title: string; text: string; score: number }> }>(
      `/api/agents/${id}/search?q=${encodeURIComponent(q)}`,
    ),
  agentChat: (id: string, messages: AgentChatMessage[]) =>
    api<{
      reply: string;
      actions: Array<{ tool: string; input: unknown; output: string }>;
      model: string;
    }>(`/api/agents/${id}/chat`, { body: { messages } }),
};

export type AiProviderId =
  'openai' | 'anthropic' | 'gemini' | 'deepgram' | 'elevenlabs' | 'sarvam' | 'groq';

export interface AiProvider {
  id: AiProviderId;
  name: string;
  usedFor: string;
  keyUrl: string;
  configured: boolean;
  source: 'env' | 'settings' | null;
  hint: string | null;
}

export type SttProvider = 'openai' | 'deepgram' | 'sarvam' | 'groq';
export type LlmProvider = 'anthropic' | 'openai' | 'gemini' | 'groq';
export type TtsProvider = 'openai' | 'elevenlabs' | 'sarvam';

export interface AgentInput {
  name: string;
  instructions: string;
  greeting: string;
  languages: string[];
  engine: 'realtime' | 'pipeline';
  voice: {
    realtime: { model: string; voice: string };
    stt: { provider: SttProvider; model: string };
    llm: { provider: LlmProvider; model: string };
    tts: { provider: TtsProvider; model: string; voice: string };
    language: string;
  };
  tools: {
    knowledge: boolean;
    transfer: boolean;
    endCall: boolean;
    whatsappMessage: boolean;
    workflows: Array<{
      workflowId: string;
      name: string;
      description: string;
      parameters: Array<{ name: string; description: string }>;
    }>;
  };
  notify: { summary: boolean; whatsappTo: string };
}

export interface AgentSummary extends AgentInput {
  id: string;
  createdAt: string;
  updatedAt: string;
  numbers: Array<{ id: string; displayPhoneNumber: string; name: string }>;
  documentCount: number;
  callCount: number;
}

export interface AgentDetail extends AgentInput {
  id: string;
  documents: Array<{ id: string; title: string; characters: number; updatedAt: string }>;
  numbers: Array<{ id: string; displayPhoneNumber: string; name: string }>;
  missingProviders?: AiProviderId[];
}

export interface AgentOptions {
  providers: AiProvider[];
  sttProviders: SttProvider[];
  llmProviders: LlmProvider[];
  ttsProviders: TtsProvider[];
  defaultModels: {
    realtime: string;
    stt: Record<SttProvider, string>;
    llm: Record<LlmProvider, string>;
    tts: Record<TtsProvider, string>;
  };
  defaultVoices: Record<TtsProvider | 'realtime', string>;
  workflows: Array<{ id: string; name: string }>;
}

export interface AgentChatMessage {
  role: 'caller' | 'agent';
  text: string;
}

export interface CallDTO {
  id: string;
  accountId: string;
  waCallId: string | null;
  direction: 'inbound' | 'outbound';
  contact: string;
  contactName: string | null;
  status: 'ringing' | 'answered' | 'ended' | 'missed' | 'rejected' | 'failed';
  handledBy: string | null;
  answeredBy: { id: string; name: string } | null;
  startedAt: string;
  answeredAt: string | null;
  endedAt: string | null;
  durationSeconds: number | null;
  endReason: string | null;
  hasRecording: boolean;
  transcript: Array<{ role: 'caller' | 'agent'; text: string; at: string }> | null;
  summary: string | null;
}

export type CallMode = 'app' | 'voicemail' | 'ai' | 'reject';
export type CallFallback = 'voicemail' | 'ai' | 'reject';

export interface CallSettings {
  mode: CallMode;
  ringSeconds: number;
  fallback: CallFallback;
  businessHours: {
    enabled: boolean;
    timezone: string;
    days: Array<{ day: number; open: string; close: string }>;
    outsideMode: CallFallback;
  };
  voicemailMaxSeconds: number;
  rejectMessage: string;
  greetingText: string;
  record: boolean;
}

export interface CallSettingsResponse {
  settings: CallSettings;
  callingEnabled: boolean;
  hasGreetingAudio: boolean;
  aiAvailable: boolean;
}

export interface WhatsAppPlatform {
  appId: string | null;
  configId: string | null;
  appSecretSet: boolean;
  embeddedSignupReady: boolean;
  sources: Record<
    'appId' | 'appSecret' | 'configId' | 'verifyToken',
    'env' | 'settings' | 'generated' | null
  >;
  webhookUrl: string;
  /** Only for the owner. */
  verifyToken: string | null;
  webhookVerifiedAt: string | null;
  lastWebhookAt: string | null;
  graphVersion: string;
}

export interface ChecklistStep {
  id: string;
  title: string;
  status: 'done' | 'todo' | 'error' | 'soon';
  detail: string;
}

export interface WhatsAppAccount {
  id: string;
  name: string;
  mode: 'cloud' | 'simulator';
  connectedVia: string;
  wabaId: string | null;
  phoneNumberId: string;
  displayPhoneNumber: string;
  verifiedName: string | null;
  qualityRating: string | null;
  nameStatus: string | null;
  codeVerificationStatus: string | null;
  messagingLimit: string | null;
  webhookSubscribed: boolean;
  status: 'connected' | 'error' | 'disconnected';
  lastError: string | null;
  lastEventAt: string | null;
  callingEnabled: boolean;
  agentId: string | null;
  createdAt: string;
}

export interface WhatsAppMessage {
  id: string;
  accountId: string;
  waMessageId: string | null;
  direction: 'inbound' | 'outbound';
  contact: string;
  contactName: string | null;
  type: string;
  text: string | null;
  status: 'received' | 'sent' | 'delivered' | 'read' | 'failed';
  error: unknown;
  payload: IDataObject;
  timestamp: string;
}

export interface WhatsAppConversation {
  contact: string;
  contactName: string | null;
  text: string | null;
  timestamp: string;
  count: number;
}

export interface DashboardData {
  days: number;
  timezone: string;
  totals: {
    calls: number;
    answered: number;
    missed: number;
    answerRate: number | null;
    handledByAi: number;
    handledByPeople: number;
    voicemail: number;
    averageCallSeconds: number;
    talkMinutes: number;
    messagesReceived: number;
    messagesSent: number;
    workflowRuns: number;
    workflowErrors: number;
  };
  series: {
    calls: Array<{ day: string; answered: number; missed: number; other: number }>;
    messages: Array<{ day: string; received: number; sent: number }>;
    executions: Array<{ day: string; success: number; error: number }>;
  };
  busiestHours: Array<{ hour: number; count: number }>;
  topCallers: Array<{ contact: string; contactName: string | null; calls: number }>;
  agents: Array<{ agentId: string; name: string; calls: number; averageSeconds: number }>;
  recentMissed: Array<{
    id: string;
    contact: string;
    contactName: string | null;
    startedAt: string;
    status: string;
  }>;
}

export interface WorkflowTemplate {
  id: string;
  name: string;
  description: string;
  category: string;
  setup: string[];
  nodeTypes: string[];
}

export interface TeamMember extends User {
  status: 'active' | 'invited';
  inviteExpiresAt: string | null;
  lastLoginAt: string | null;
  createdAt: string;
}

export interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  userId: string;
  userName: string | null;
  lastUsedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
}
