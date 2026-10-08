import { getServerUrl, getToken } from './api';

export type PushMessage =
  | { type: 'connected'; data: { userId: string } }
  | {
      type: 'executionStarted';
      data: { executionId: string; workflowId: string; mode: string; startedAt: string };
    }
  | {
      type: 'nodeExecuteBefore';
      data: { executionId: string; workflowId: string; nodeName: string };
    }
  | {
      type: 'nodeExecuteAfter';
      data: {
        executionId: string;
        workflowId: string;
        nodeName: string;
        runIndex: number;
        status: 'success' | 'error' | 'canceled';
        executionTime: number;
        itemCounts: number[];
        error?: { message: string; description?: string };
      };
    }
  | {
      type: 'executionFinished';
      data: {
        executionId: string;
        workflowId: string;
        status: string;
        stoppedAt: string;
        errorMessage?: string;
      };
    }
  | { type: 'workflowUpdated'; data: { workflowId: string; active: boolean; versionId: string } }
  | {
      type: 'testWebhookReceived';
      data: { workflowId: string; executionId: string; nodeId: string };
    }
  | { type: 'error'; data: { message: string } }
  | { type: 'pong' };

type Listener = (message: PushMessage) => void;

/**
 * WebSocket client with automatic reconnect. Subscriptions are remembered and
 * re-sent after every reconnect. Also used by the mobile app while it is open.
 */
class PushClient {
  private socket: WebSocket | null = null;
  private readonly topics = new Map<string, number>();
  private readonly listeners = new Set<Listener>();
  private readonly statusListeners = new Set<(connected: boolean) => void>();
  private retry = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private stopped = true;
  connected = false;

  start() {
    this.stopped = false;
    this.open();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.socket?.close();
    this.socket = null;
    this.setConnected(false);
  }

  private url(): string | null {
    const token = getToken();
    if (!token) return null;
    const base = getServerUrl() || window.location.origin;
    const url = new URL('/api/push', base);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('token', token);
    return url.toString();
  }

  private open() {
    const url = this.url();
    if (!url || this.stopped) return;
    const socket = new WebSocket(url);
    this.socket = socket;
    socket.onmessage = (event) => {
      let message: PushMessage;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (message.type === 'connected') {
        this.retry = 0;
        this.setConnected(true);
        for (const topic of this.topics.keys()) this.send({ type: 'subscribe', topic });
      }
      this.listeners.forEach((listener) => listener(message));
    };
    socket.onclose = (event) => {
      this.setConnected(false);
      if (this.heartbeat) clearInterval(this.heartbeat);
      if (this.stopped || event.code === 4401) return;
      const delay = Math.min(30_000, 500 * 2 ** this.retry++);
      this.timer = setTimeout(() => this.open(), delay);
    };
    socket.onopen = () => {
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.heartbeat = setInterval(() => this.send({ type: 'ping' }), 25_000);
    };
  }

  private send(message: unknown) {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  private setConnected(value: boolean) {
    if (this.connected === value) return;
    this.connected = value;
    this.statusListeners.forEach((l) => l(value));
  }

  /** Reference-counted subscription; returns an unsubscribe function. */
  subscribe(topic: string): () => void {
    const count = this.topics.get(topic) ?? 0;
    this.topics.set(topic, count + 1);
    if (count === 0 && this.connected) this.send({ type: 'subscribe', topic });
    return () => {
      const current = this.topics.get(topic) ?? 0;
      if (current <= 1) {
        this.topics.delete(topic);
        this.send({ type: 'unsubscribe', topic });
      } else this.topics.set(topic, current - 1);
    };
  }

  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onStatus(listener: (connected: boolean) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }
}

export const push = new PushClient();
