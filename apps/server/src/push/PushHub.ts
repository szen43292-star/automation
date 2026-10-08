import type { WebSocket } from 'ws';
import type { FastifyBaseLogger } from 'fastify';
import type { CallDTO } from '../calls/CallService';
import type { WhatsAppMessageDTO } from '../whatsapp/WhatsAppService';

/** Events pushed to editor / desktop / mobile clients. */
export type PushEvent =
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
        status: string;
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
  | { type: 'whatsappMessage'; data: WhatsAppMessageDTO }
  | { type: 'whatsappAccountUpdated'; data: { accountId: string } }
  | {
      type: 'incomingCall';
      data: {
        callId: string;
        accountId: string;
        accountNumber: string;
        from: string;
        contactName: string | null;
        ringSeconds: number;
      };
    }
  | { type: 'callUpdated'; data: CallDTO & { note?: string } }
  | { type: 'callAnswered'; data: { callId: string; userId: string } }
  | { type: 'callTranscript'; data: { callId: string; role: 'caller' | 'agent'; text: string } }
  | { type: 'simulatedCallAction'; data: { waCallId: string; action: string } }
  | {
      type: 'simulatedOutboundCall';
      data: {
        accountId: string;
        waCallId: string;
        to: string;
        from: string;
        businessName: string;
        sdp: string;
      };
    }
  | { type: 'callPermission'; data: { accountId: string; contact: string; status: string } }
  | {
      type: 'callSummary';
      data: { callId: string; summary: string; contact: string; contactName: string | null };
    };

interface Client {
  socket: WebSocket;
  userId: string;
  topics: Set<string>;
}

/**
 * Topic based fan-out over WebSockets.
 * Topics: `workflow:<id>`, `execution:<id>`, `user:<id>`, `whatsapp` (messages on connected numbers).
 */
export class PushHub {
  private readonly clients = new Set<Client>();

  constructor(private readonly logger: FastifyBaseLogger) {}

  add(socket: WebSocket, userId: string): Client {
    const client: Client = { socket, userId, topics: new Set([`user:${userId}`]) };
    this.clients.add(client);
    socket.on('close', () => this.clients.delete(client));
    socket.on('error', () => this.clients.delete(client));
    return client;
  }

  subscribe(client: Client, topic: string) {
    if (client.topics.size < 200) client.topics.add(topic);
  }

  unsubscribe(client: Client, topic: string) {
    client.topics.delete(topic);
  }

  publish(topics: string[], event: PushEvent) {
    const payload = JSON.stringify(event);
    for (const client of this.clients) {
      if (!topics.some((t) => client.topics.has(t))) continue;
      if (client.socket.readyState !== client.socket.OPEN) continue;
      client.socket.send(payload, (error) => {
        if (error) this.logger.debug({ err: error }, 'push send failed');
      });
    }
  }

  get size() {
    return this.clients.size;
  }

  closeAll() {
    for (const client of this.clients) client.socket.close(1001, 'Server shutting down');
    this.clients.clear();
  }
}
