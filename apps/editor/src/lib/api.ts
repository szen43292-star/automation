import type {
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
}

export interface ExecutionDetail extends Omit<ExecutionSummary, 'durationMs'> {
  running: boolean;
  workflowData:
    | (Pick<WorkflowDTO, 'name' | 'nodes' | 'connections' | 'settings'> & { pinData?: IPinData })
    | null;
  data: IRunExecutionData | null;
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
};
