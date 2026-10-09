import { createSign } from 'node:crypto';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { parse } from '../lib/errors';
import type { PushEvent } from './PushHub';

const serviceAccountSchema = z.object({
  project_id: z.string().min(1),
  client_email: z.string().min(1),
  private_key: z.string().min(1),
  token_uri: z.string().url().default('https://oauth2.googleapis.com/token'),
});
type ServiceAccount = z.infer<typeof serviceAccountSchema>;

/** FCM_SERVICE_ACCOUNT: the JSON file's content, or base64 of it. */
export function readServiceAccount(value: string | undefined): ServiceAccount | null {
  if (!value?.trim()) return null;
  const text = value.trim().startsWith('{') ? value : Buffer.from(value, 'base64').toString('utf8');
  try {
    return serviceAccountSchema.parse(JSON.parse(text));
  } catch {
    throw new Error('FCM_SERVICE_ACCOUNT is not a Firebase service account JSON (or base64 of it)');
  }
}

export interface Notification {
  title: string;
  body: string;
  /** Opened when the notification is tapped, e.g. "/calls". */
  url: string;
  /** Calls ring: high priority and the "calls" channel. */
  urgent?: boolean;
  tag?: string;
}

/**
 * Phone notifications through Firebase Cloud Messaging (Android, and iOS via APNs in Firebase):
 * incoming calls, missed calls and AI call summaries reach the team even when the app is closed.
 */
export class PhoneNotifications {
  private token: { value: string; expiresAt: number } | null = null;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly logger: FastifyBaseLogger,
    private readonly account: ServiceAccount | null,
    private readonly apiUrl: string,
  ) {}

  get enabled() {
    return this.account !== null;
  }

  /** OAuth access token from the service account (signed JWT → token endpoint), cached. */
  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;
    const account = this.account!;
    const now = Math.floor(Date.now() / 1000);
    const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({
      iss: account.client_email,
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: account.token_uri,
      iat: now,
      exp: now + 3600,
    })}`;
    const signature = createSign('RSA-SHA256')
      .update(unsigned)
      .sign(account.private_key, 'base64url');
    const response = await fetch(account.token_uri, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: `${unsigned}.${signature}`,
      }),
    });
    if (!response.ok) throw new Error(`Firebase sign-in failed (${response.status})`);
    const body = (await response.json()) as { access_token: string; expires_in?: number };
    this.token = {
      value: body.access_token,
      expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
    };
    return body.access_token;
  }

  /** Send to every registered phone (everyone on the team can answer calls). */
  async send(notification: Notification) {
    if (!this.account) return 0;
    const devices = await this.prisma.device.findMany();
    if (!devices.length) return 0;
    const token = await this.accessToken();
    let sent = 0;
    await Promise.all(
      devices.map(async (device) => {
        const response = await fetch(
          `${this.apiUrl.replace(/\/+$/, '')}/v1/projects/${this.account!.project_id}/messages:send`,
          {
            method: 'POST',
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            body: JSON.stringify({
              message: {
                token: device.token,
                notification: { title: notification.title, body: notification.body },
                data: {
                  url: notification.url,
                  ...(notification.tag ? { tag: notification.tag } : {}),
                },
                android: {
                  priority: notification.urgent ? 'high' : 'normal',
                  notification: {
                    channel_id: notification.urgent ? 'calls' : 'default',
                    ...(notification.tag ? { tag: notification.tag } : {}),
                  },
                },
                apns: {
                  headers: { 'apns-priority': notification.urgent ? '10' : '5' },
                  payload: { aps: { sound: 'default' } },
                },
              },
            }),
          },
        ).catch((error: Error) => {
          this.logger.warn({ err: error }, 'Phone notification failed');
          return null;
        });
        if (!response) return;
        if (response.ok) {
          sent++;
          return;
        }
        const text = await response.text().catch(() => '');
        // The app was uninstalled or the token rotated: forget the device.
        if (response.status === 404 || /UNREGISTERED|INVALID_ARGUMENT/.test(text)) {
          await this.prisma.device.delete({ where: { id: device.id } }).catch(() => undefined);
        } else {
          this.logger.warn(
            { status: response.status, body: text.slice(0, 300) },
            'Phone notification rejected',
          );
        }
      }),
    );
    return sent;
  }

  /** Which live events become phone notifications. */
  notificationFor(event: PushEvent): Notification | null {
    if (event.type === 'incomingCall') {
      const d = event.data;
      return {
        title: 'Incoming WhatsApp call',
        body: `${d.contactName ?? `+${d.from}`} is calling ${d.accountNumber}. Tap to answer.`,
        url: '/calls',
        urgent: true,
        tag: `call-${d.callId}`,
      };
    }
    if (
      event.type === 'callUpdated' &&
      event.data.status === 'missed' &&
      event.data.direction === 'inbound'
    ) {
      return {
        title: 'Missed call',
        body: `${event.data.contactName ?? `+${event.data.contact}`} called.`,
        url: '/calls',
        tag: `call-${event.data.id}`,
      };
    }
    if (event.type === 'callSummary') {
      return {
        title: `Call with ${event.data.contactName ?? `+${event.data.contact}`}`,
        body: event.data.summary.slice(0, 240),
        url: '/calls',
        tag: `call-${event.data.callId}`,
      };
    }
    return null;
  }

  observe = (_topics: string[], event: PushEvent) => {
    if (!this.enabled) return;
    const notification = this.notificationFor(event);
    if (!notification) return;
    void this.send(notification).catch((error: Error) =>
      this.logger.warn({ err: error }, 'Phone notifications failed'),
    );
  };
}

/** Phones register here after the app gets a push token (inside the /api scope). */
export async function deviceRoutes(
  app: FastifyInstance,
  opts: { notifications: PhoneNotifications },
) {
  app.get('/api/devices/status', async () => ({ enabled: opts.notifications.enabled }));

  app.post('/api/devices', async (request) => {
    const body = parse(
      z.object({ token: z.string().min(10).max(4096), platform: z.enum(['android', 'ios']) }),
      request.body,
    );
    await app.prisma.device.upsert({
      where: { token: body.token },
      create: { ...body, userId: request.currentUser.id },
      update: { userId: request.currentUser.id, platform: body.platform, lastSeenAt: new Date() },
    });
    return { registered: true, enabled: opts.notifications.enabled };
  });

  app.delete('/api/devices', async (request, reply) => {
    const { token } = parse(z.object({ token: z.string().min(10).max(4096) }), request.body);
    await app.prisma.device.deleteMany({ where: { token, userId: request.currentUser.id } });
    return reply.status(204).send();
  });
}
