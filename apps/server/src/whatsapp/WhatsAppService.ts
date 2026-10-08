import { randomBytes, randomInt } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import {
  Prisma,
  type PrismaClient,
  type WhatsAppAccount,
  type WhatsAppMessage,
} from '@prisma/client';
import type {
  IDataObject,
  ITriggerEvent,
  IWhatsAppHelper,
  IWhatsAppMedia,
  IWhatsAppSendResult,
} from '@flowforge/workflow';
import type { Cipher } from '../credentials/cipher';
import type { PushPublisher } from '../executions/types';
import { HttpError, badRequest } from '../lib/errors';
import {
  messageItem,
  messageText,
  outboundText,
  statusItem,
  toIso,
  type AccountRef,
  type CloudMessage,
  type CloudStatus,
  type CloudChangeValue,
  type CloudWebhook,
} from './events';
import { GraphApiError, type GraphClient } from './graph';
import type { WhatsAppPlatform } from './platform';

export interface WhatsAppAccountDTO {
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
  /** AI agent answering calls (mode "AI agent"). */
  agentId: string | null;
  createdAt: string;
}

export interface WhatsAppMessageDTO {
  id: string;
  accountId: string;
  waMessageId: string | null;
  direction: 'inbound' | 'outbound';
  contact: string;
  contactName: string | null;
  type: string;
  text: string | null;
  status: string;
  error: unknown;
  payload: unknown;
  timestamp: string;
}

interface AccountSecrets {
  accessToken: string;
  pin?: string;
}

const STATUS_RANK: Record<string, number> = { sent: 1, delivered: 2, read: 3, failed: 4 };

export const toAccountDTO = (a: WhatsAppAccount): WhatsAppAccountDTO => ({
  id: a.id,
  name: a.name,
  mode: a.mode,
  connectedVia: a.connectedVia,
  wabaId: a.wabaId,
  phoneNumberId: a.phoneNumberId,
  displayPhoneNumber: a.displayPhoneNumber,
  verifiedName: a.verifiedName,
  qualityRating: a.qualityRating,
  nameStatus: a.nameStatus,
  codeVerificationStatus: a.codeVerificationStatus,
  messagingLimit: a.messagingLimit,
  webhookSubscribed: a.webhookSubscribed,
  status: a.status,
  lastError: a.lastError,
  lastEventAt: a.lastEventAt?.toISOString() ?? null,
  callingEnabled: a.callingEnabled,
  agentId: a.agentId,
  createdAt: a.createdAt.toISOString(),
});

export const toMessageDTO = (m: WhatsAppMessage): WhatsAppMessageDTO => ({
  id: m.id,
  accountId: m.accountId,
  waMessageId: m.waMessageId,
  direction: m.direction,
  contact: m.contact,
  contactName: m.contactName,
  type: m.type,
  text: m.text,
  status: m.status,
  error: m.error,
  payload: m.payload,
  timestamp: m.timestamp.toISOString(),
});

const accountRef = (a: WhatsAppAccount): AccountRef => ({
  id: a.id,
  phoneNumber: a.displayPhoneNumber,
  name: a.verifiedName ?? a.name,
});

const PHONE_FIELDS =
  'display_phone_number,verified_name,quality_rating,code_verification_status,name_status,messaging_limit_tier';

/** Sample templates for test numbers, so template workflows can be built without Meta. */
const SIMULATOR_TEMPLATES: IDataObject[] = [
  {
    name: 'hello_world',
    language: 'en_US',
    status: 'APPROVED',
    category: 'UTILITY',
    components: [{ type: 'BODY', text: 'Hello World! Welcome and congratulations.' }],
  },
  {
    name: 'appointment_reminder',
    language: 'en_US',
    status: 'APPROVED',
    category: 'UTILITY',
    components: [
      {
        type: 'BODY',
        text: 'Hi {{1}}, a reminder of your appointment on {{2}}. Reply YES to confirm.',
      },
    ],
  },
  {
    name: 'order_update',
    language: 'hi',
    status: 'APPROVED',
    category: 'UTILITY',
    components: [{ type: 'BODY', text: 'नमस्ते {{1}}, आपका ऑर्डर {{2}} भेज दिया गया है।' }],
  },
];

export interface WhatsAppServiceDeps {
  prisma: PrismaClient;
  cipher: Cipher;
  graph: GraphClient;
  platform: WhatsAppPlatform;
  push: PushPublisher;
  logger: FastifyBaseLogger;
  /** Starts workflows for an incoming event (set on the main server, not on workers). */
  onEvent?: (event: ITriggerEvent, item: IDataObject) => Promise<void>;
  /** Delays of the simulated "delivered" and "read" receipts (ms). */
  simulatorReceiptDelays?: [number, number];
}

export class WhatsAppService {
  private readonly timers = new Set<NodeJS.Timeout>();
  /** Files "uploaded" to or "received" by test numbers (kept in memory, newest 200). */
  private readonly simulatorMedia = new Map<string, IWhatsAppMedia>();

  constructor(private readonly deps: WhatsAppServiceDeps) {}

  set onEvent(handler: WhatsAppServiceDeps['onEvent']) {
    this.deps.onEvent = handler;
  }

  // ---- Accounts ------------------------------------------------------------------------------

  async list(): Promise<WhatsAppAccountDTO[]> {
    const rows = await this.deps.prisma.whatsAppAccount.findMany({ orderBy: { createdAt: 'asc' } });
    return rows.map(toAccountDTO);
  }

  /** Incoming call events (set by the call service). */
  onCalls?: (account: WhatsAppAccount, value: CloudChangeValue) => Promise<void>;

  /** The account row, or a 404 that explains the number is gone. */
  async row(id: string): Promise<WhatsAppAccount> {
    const account = await this.deps.prisma.whatsAppAccount.findUnique({ where: { id } });
    if (!account) {
      throw new HttpError(
        404,
        'This WhatsApp number is not connected (any more). Choose another one.',
        'NotFound',
      );
    }
    return account;
  }

  async get(id: string): Promise<WhatsAppAccountDTO> {
    return toAccountDTO(await this.row(id));
  }

  /** Graph API request with the number's token (cloud numbers only). */
  async graphRequest<T = Record<string, unknown>>(
    account: WhatsAppAccount,
    request: Omit<Parameters<GraphClient['request']>[0], 'token'>,
  ): Promise<T> {
    return this.deps.graph.request<T>({ ...request, token: this.secrets(account).accessToken });
  }

  private secrets(account: WhatsAppAccount): AccountSecrets {
    if (!account.secrets)
      throw badRequest(`${account.displayPhoneNumber} has no access token - reconnect it`);
    return this.deps.cipher.decryptJson(account.secrets) as AccountSecrets;
  }

  /** Customer flow: the code from Meta's Embedded Signup popup → a working number. No keys typed. */
  async connectEmbeddedSignup(
    userId: string,
    input: { code: string; wabaId: string; phoneNumberId: string },
  ) {
    const platform = await this.deps.platform.get();
    if (!platform.appId || !platform.appSecret) {
      throw badRequest(
        'WhatsApp is not set up on this server yet - the owner needs to add the Meta app first.',
      );
    }
    const token = await this.deps.graph.request<{ access_token?: string }>({
      path: '/oauth/access_token',
      query: { client_id: platform.appId, client_secret: platform.appSecret, code: input.code },
    });
    if (!token.access_token)
      throw badRequest('Meta did not return an access token. Please try connecting again.');
    return this.setupCloudAccount(userId, {
      wabaId: input.wabaId,
      phoneNumberId: input.phoneNumberId,
      accessToken: token.access_token,
      via: 'embedded_signup',
      register: true,
    });
  }

  /** Advanced: a number set up by hand in the Meta dashboard (permanent system-user token). */
  async connectManual(
    userId: string,
    input: { wabaId: string; phoneNumberId: string; accessToken: string },
  ) {
    return this.setupCloudAccount(userId, { ...input, via: 'manual', register: false });
  }

  private async setupCloudAccount(
    userId: string,
    input: {
      wabaId: string;
      phoneNumberId: string;
      accessToken: string;
      via: string;
      register: boolean;
    },
  ): Promise<WhatsAppAccountDTO> {
    const { graph, cipher, prisma } = this.deps;
    const token = input.accessToken;
    // Checks the token and number before anything is stored.
    const details = await graph.request<Record<string, string | undefined>>({
      path: `/${input.phoneNumberId}`,
      token,
      query: { fields: PHONE_FIELDS },
    });
    const existing = await prisma.whatsAppAccount.findUnique({
      where: { phoneNumberId: input.phoneNumberId },
    });
    const previous = existing?.secrets
      ? (cipher.decryptJson(existing.secrets) as AccountSecrets)
      : null;
    const pin = previous?.pin ?? String(randomInt(100_000, 1_000_000));
    const problems: string[] = [];

    let webhookSubscribed = false;
    try {
      await graph.request({ method: 'POST', path: `/${input.wabaId}/subscribed_apps`, token });
      webhookSubscribed = true;
    } catch (error) {
      problems.push(`Could not subscribe to messages: ${(error as Error).message}`);
    }
    if (input.register) {
      try {
        await graph.request({
          method: 'POST',
          path: `/${input.phoneNumberId}/register`,
          token,
          json: { messaging_product: 'whatsapp', pin },
        });
      } catch (error) {
        problems.push(`Could not register the number for sending: ${(error as Error).message}`);
      }
    }

    const data = {
      name: details.verified_name ?? details.display_phone_number ?? 'WhatsApp number',
      mode: 'cloud' as const,
      connectedVia: input.via,
      wabaId: input.wabaId,
      displayPhoneNumber: details.display_phone_number ?? input.phoneNumberId,
      verifiedName: details.verified_name ?? null,
      qualityRating: details.quality_rating ?? null,
      nameStatus: details.name_status ?? null,
      codeVerificationStatus: details.code_verification_status ?? null,
      messagingLimit: details.messaging_limit_tier ?? null,
      secrets: cipher.encryptJson({ accessToken: token, pin } satisfies AccountSecrets),
      webhookSubscribed,
      status: problems.length ? ('error' as const) : ('connected' as const),
      lastError: problems.join('\n') || null,
    };
    const row = await prisma.whatsAppAccount.upsert({
      where: { phoneNumberId: input.phoneNumberId },
      create: { ...data, phoneNumberId: input.phoneNumberId, createdById: userId },
      update: data,
    });
    this.deps.push.publish(['whatsapp'], {
      type: 'whatsappAccountUpdated',
      data: { accountId: row.id },
    });
    return toAccountDTO(row);
  }

  /** A test number: workflows send and receive through the built-in simulator, nothing goes to Meta. */
  async createSimulator(userId: string, input: { name?: string }) {
    const digits = `1555010${String(randomInt(0, 10_000)).padStart(4, '0')}`;
    const row = await this.deps.prisma.whatsAppAccount.create({
      data: {
        name: input.name?.trim() || 'Test number',
        mode: 'simulator',
        connectedVia: 'simulator',
        phoneNumberId: `sim-${randomBytes(6).toString('hex')}`,
        displayPhoneNumber: `+1 555-010-${digits.slice(-4)}`,
        verifiedName: input.name?.trim() || 'My Business (test)',
        qualityRating: 'GREEN',
        codeVerificationStatus: 'VERIFIED',
        webhookSubscribed: true,
        createdById: userId,
      },
    });
    this.deps.push.publish(['whatsapp'], {
      type: 'whatsappAccountUpdated',
      data: { accountId: row.id },
    });
    return toAccountDTO(row);
  }

  /** Re-read the number's details from Meta and repair the webhook subscription / registration. */
  async refresh(id: string): Promise<WhatsAppAccountDTO> {
    const account = await this.row(id);
    if (account.mode === 'simulator') return toAccountDTO(account);
    const { accessToken } = this.secrets(account);
    return this.setupCloudAccount(account.createdById ?? '', {
      wabaId: account.wabaId ?? '',
      phoneNumberId: account.phoneNumberId,
      accessToken,
      via: account.connectedVia,
      register: account.connectedVia === 'embedded_signup' && account.status === 'error',
    }).catch(async (error: Error) => {
      const row = await this.deps.prisma.whatsAppAccount.update({
        where: { id },
        data: { status: 'error', lastError: error.message },
      });
      return toAccountDTO(row);
    });
  }

  async disconnect(id: string): Promise<void> {
    const account = await this.row(id);
    if (account.mode === 'cloud' && account.wabaId && account.secrets) {
      // Best effort: stop Meta sending this number's events here.
      await this.deps.graph
        .request({
          method: 'DELETE',
          path: `/${account.wabaId}/subscribed_apps`,
          token: this.secrets(account).accessToken,
        })
        .catch(() => undefined);
    }
    await this.deps.prisma.whatsAppAccount.delete({ where: { id } });
    this.deps.push.publish(['whatsapp'], {
      type: 'whatsappAccountUpdated',
      data: { accountId: id },
    });
  }

  // ---- Sending (used by the WhatsApp node through `helper()`) ---------------------------------

  helper(): IWhatsAppHelper {
    return {
      send: (accountId, to, message) => this.send(accountId, to, message),
      markRead: (accountId, messageId, options) => this.markRead(accountId, messageId, options),
      uploadMedia: (accountId, media) => this.uploadMedia(accountId, media),
      downloadMedia: (accountId, mediaId) => this.downloadMedia(accountId, mediaId),
      listTemplates: (accountId) => this.listTemplates(accountId),
    };
  }

  async send(accountId: string, to: string, message: IDataObject): Promise<IWhatsAppSendResult> {
    const account = await this.row(accountId);
    const contact = to.replace(/[^\d]/g, '');
    const type = String(message.type ?? 'text');
    const base = {
      accountId,
      direction: 'outbound' as const,
      contact,
      type,
      text: outboundText(message),
      payload: message as Prisma.InputJsonValue,
      timestamp: new Date(),
    };

    if (account.mode === 'simulator') {
      const messageId = `wamid.SIM${randomBytes(12).toString('hex').toUpperCase()}`;
      const row = await this.deps.prisma.whatsAppMessage.create({
        data: { ...base, waMessageId: messageId, status: 'sent' },
      });
      this.publishMessage(row);
      this.simulateReceipts(account, messageId, contact);
      return {
        messageId,
        to: contact,
        accountId,
        from: account.displayPhoneNumber,
        simulated: true,
      };
    }

    try {
      const response = await this.deps.graph.request<{
        messages?: Array<{ id: string }>;
        contacts?: Array<{ wa_id?: string }>;
      }>({
        method: 'POST',
        path: `/${account.phoneNumberId}/messages`,
        token: this.secrets(account).accessToken,
        json: {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: contact,
          ...message,
        },
      });
      const messageId = response.messages?.[0]?.id ?? '';
      const row = await this.deps.prisma.whatsAppMessage.create({
        data: {
          ...base,
          waMessageId: messageId || null,
          contact: response.contacts?.[0]?.wa_id ?? contact,
          status: 'sent',
        },
      });
      this.publishMessage(row);
      return {
        messageId,
        to: row.contact,
        accountId,
        from: account.displayPhoneNumber,
        simulated: false,
      };
    } catch (error) {
      const row = await this.deps.prisma.whatsAppMessage.create({
        data: {
          ...base,
          status: 'failed',
          error: { message: (error as Error).message, code: (error as GraphApiError).code ?? null },
        },
      });
      this.publishMessage(row);
      throw error;
    }
  }

  async markRead(accountId: string, messageId: string, options: { typing?: boolean } = {}) {
    const account = await this.row(accountId);
    if (account.mode === 'cloud') {
      await this.deps.graph.request({
        method: 'POST',
        path: `/${account.phoneNumberId}/messages`,
        token: this.secrets(account).accessToken,
        json: {
          messaging_product: 'whatsapp',
          status: 'read',
          message_id: messageId,
          ...(options.typing ? { typing_indicator: { type: 'text' } } : {}),
        },
      });
    }
    const row = await this.deps.prisma.whatsAppMessage
      .update({ where: { waMessageId: messageId }, data: { status: 'read' } })
      .catch(() => null);
    if (row) this.publishMessage(row);
  }

  async uploadMedia(
    accountId: string,
    media: { data: Buffer; mimeType: string; fileName?: string },
  ) {
    const account = await this.row(accountId);
    if (account.mode === 'simulator') {
      const id = `sim-media-${randomBytes(8).toString('hex')}`;
      this.rememberMedia(id, {
        data: media.data,
        mimeType: media.mimeType,
        fileName: media.fileName,
      });
      return { id };
    }
    const form = new FormData();
    form.set('messaging_product', 'whatsapp');
    form.set('type', media.mimeType);
    form.set(
      'file',
      new Blob([new Uint8Array(media.data)], { type: media.mimeType }),
      media.fileName ?? 'file',
    );
    const result = await this.deps.graph.request<{ id: string }>({
      method: 'POST',
      path: `/${account.phoneNumberId}/media`,
      token: this.secrets(account).accessToken,
      form,
      timeoutMs: 120_000,
    });
    return { id: result.id };
  }

  async downloadMedia(accountId: string, mediaId: string): Promise<IWhatsAppMedia> {
    const account = await this.row(accountId);
    if (account.mode === 'simulator') {
      const media = this.simulatorMedia.get(mediaId);
      if (!media)
        throw badRequest(
          `Media "${mediaId}" was not found (test numbers keep files in memory only)`,
        );
      return media;
    }
    const token = this.secrets(account).accessToken;
    const info = await this.deps.graph.request<{
      url?: string;
      mime_type?: string;
      sha256?: string;
    }>({
      path: `/${mediaId}`,
      token,
      query: { phone_number_id: account.phoneNumberId },
    });
    if (!info.url) throw badRequest(`Meta returned no download link for media ${mediaId}`);
    const file = await this.deps.graph.download(info.url, token);
    return { data: file.data, mimeType: info.mime_type ?? file.mimeType, sha256: info.sha256 };
  }

  async listTemplates(accountId: string): Promise<IDataObject[]> {
    const account = await this.row(accountId);
    if (account.mode === 'simulator') return SIMULATOR_TEMPLATES;
    if (!account.wabaId) return [];
    const result = await this.deps.graph.request<{ data?: IDataObject[] }>({
      path: `/${account.wabaId}/message_templates`,
      token: this.secrets(account).accessToken,
      query: { fields: 'name,language,status,category,components', limit: 200 },
    });
    return result.data ?? [];
  }

  // ---- Message log -----------------------------------------------------------------------------

  async messages(
    accountId: string,
    options: { contact?: string; limit?: number; before?: string },
  ) {
    await this.row(accountId);
    const rows = await this.deps.prisma.whatsAppMessage.findMany({
      where: {
        accountId,
        ...(options.contact ? { contact: options.contact } : {}),
        ...(options.before ? { timestamp: { lt: new Date(options.before) } } : {}),
      },
      orderBy: { timestamp: 'desc' },
      take: Math.min(options.limit ?? 50, 200),
    });
    return rows.reverse().map(toMessageDTO);
  }

  /** People who messaged (or were messaged by) this number, newest first. */
  async conversations(accountId: string) {
    await this.row(accountId);
    const rows = await this.deps.prisma.$queryRaw<
      Array<{
        contact: string;
        contactName: string | null;
        text: string | null;
        timestamp: Date;
        count: bigint;
      }>
    >`SELECT DISTINCT ON (contact) contact,
             (SELECT m2."contactName" FROM "WhatsAppMessage" m2 WHERE m2."accountId" = ${accountId} AND m2.contact = m.contact AND m2."contactName" IS NOT NULL ORDER BY m2.timestamp DESC LIMIT 1) AS "contactName",
             text, timestamp,
             (SELECT count(*) FROM "WhatsAppMessage" m3 WHERE m3."accountId" = ${accountId} AND m3.contact = m.contact) AS count
        FROM "WhatsAppMessage" m
       WHERE "accountId" = ${accountId}
       ORDER BY contact, timestamp DESC`;
    return rows
      .map((r) => ({ ...r, timestamp: r.timestamp.toISOString(), count: Number(r.count) }))
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  }

  // ---- Webhook ---------------------------------------------------------------------------------

  /** Process a Cloud API webhook body (signature already verified). Returns events handled. */
  async handleWebhook(body: CloudWebhook): Promise<number> {
    if (body.object !== 'whatsapp_business_account') return 0;
    let handled = 0;
    for (const entry of body.entry ?? []) {
      for (const change of entry.changes ?? []) {
        if ((change.field !== 'messages' && change.field !== 'calls') || !change.value) continue;
        const phoneNumberId = change.value.metadata?.phone_number_id;
        if (!phoneNumberId) continue;
        const account = await this.deps.prisma.whatsAppAccount.findUnique({
          where: { phoneNumberId },
        });
        if (!account) {
          this.deps.logger.warn(
            { phoneNumberId },
            'WhatsApp webhook for a number that is not connected here',
          );
          continue;
        }
        if (change.field === 'calls') {
          // Voice calls are handled by the call service (Phase 4).
          if (this.onCalls) {
            await this.onCalls(account, change.value).catch((error: unknown) =>
              this.deps.logger.error({ err: error }, 'WhatsApp call handling failed'),
            );
            handled += change.value.calls?.length ?? 0;
          }
          continue;
        }
        const names = new Map((change.value.contacts ?? []).map((c) => [c.wa_id, c.profile?.name]));
        for (const message of change.value.messages ?? []) {
          if (await this.handleInbound(account, message, names.get(message.from))) handled++;
        }
        for (const status of change.value.statuses ?? []) {
          if (await this.handleStatus(account, status)) handled++;
        }
        await this.deps.prisma.whatsAppAccount.update({
          where: { id: account.id },
          data: { lastEventAt: new Date() },
        });
      }
    }
    return handled;
  }

  private async handleInbound(
    account: WhatsAppAccount,
    message: CloudMessage,
    contactName?: string,
  ) {
    let row: WhatsAppMessage;
    try {
      row = await this.deps.prisma.whatsAppMessage.create({
        data: {
          accountId: account.id,
          waMessageId: message.id,
          direction: 'inbound',
          contact: message.from,
          contactName: contactName ?? null,
          type: message.type,
          text: messageText(message),
          payload: message as unknown as Prisma.InputJsonValue,
          status: 'received',
          timestamp: new Date(toIso(message.timestamp)),
        },
      });
    } catch (error) {
      // Meta retries webhooks: a message we already have must not start workflows twice.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
        return false;
      throw error;
    }
    this.publishMessage(row);
    await this.emit(
      {
        source: 'whatsapp',
        scope: account.id,
        name: 'message',
        attributes: { messageType: message.type },
      },
      messageItem(accountRef(account), message, contactName),
    );
    return true;
  }

  private async handleStatus(account: WhatsAppAccount, status: CloudStatus) {
    const rank = STATUS_RANK[status.status];
    if (rank) {
      // Receipts can arrive out of order and at the same time: the update only applies while the
      // stored status is lower, so "read" is never overwritten by a late "delivered".
      const lower = Object.keys(STATUS_RANK).filter((s) => STATUS_RANK[s]! < rank);
      const { count } = await this.deps.prisma.whatsAppMessage.updateMany({
        where: {
          waMessageId: status.id,
          status: { in: ['received', ...lower] as Array<WhatsAppMessage['status']> },
        },
        data: {
          status: status.status as WhatsAppMessage['status'],
          ...(status.errors?.length
            ? { error: status.errors as unknown as Prisma.InputJsonValue }
            : {}),
        },
      });
      if (count) {
        const row = await this.deps.prisma.whatsAppMessage.findUnique({
          where: { waMessageId: status.id },
        });
        if (row) this.publishMessage(row);
      }
    }
    await this.emit(
      { source: 'whatsapp', scope: account.id, name: 'status' },
      statusItem(accountRef(account), status),
    );
    return true;
  }

  private async emit(event: ITriggerEvent, item: IDataObject) {
    if (!this.deps.onEvent) return;
    try {
      await this.deps.onEvent(event, item);
    } catch (error) {
      this.deps.logger.error({ err: error }, 'Could not start workflows for a WhatsApp event');
    }
  }

  // ---- Simulator -------------------------------------------------------------------------------

  /**
   * "Send as customer" on a test number. Builds the same webhook body Meta would send and runs it
   * through the normal webhook handling, so workflows behave exactly as with a real number.
   */
  async simulateInbound(
    accountId: string,
    input: {
      from: string;
      name?: string;
      text?: string;
      reply?: { id: string; title: string; type: 'button' | 'list' };
      location?: { latitude: number; longitude: number; name?: string };
      media?: { data: Buffer; mimeType: string; fileName?: string; caption?: string };
    },
  ) {
    const account = await this.row(accountId);
    if (account.mode !== 'simulator')
      throw badRequest('Only test numbers can simulate incoming messages');
    const from = input.from.replace(/[^\d]/g, '');
    if (from.length < 7) throw badRequest('Enter the customer number with country code');
    const message: CloudMessage = {
      from,
      id: `wamid.SIM${randomBytes(12).toString('hex').toUpperCase()}`,
      timestamp: String(Math.floor(Date.now() / 1000)),
      type: 'text',
    };
    if (input.reply) {
      message.type = 'interactive';
      message.interactive =
        input.reply.type === 'list'
          ? { type: 'list_reply', list_reply: { id: input.reply.id, title: input.reply.title } }
          : {
              type: 'button_reply',
              button_reply: { id: input.reply.id, title: input.reply.title },
            };
    } else if (input.location) {
      message.type = 'location';
      message.location = input.location;
    } else if (input.media) {
      const kind = input.media.mimeType.startsWith('image/')
        ? 'image'
        : input.media.mimeType.startsWith('audio/')
          ? 'audio'
          : input.media.mimeType.startsWith('video/')
            ? 'video'
            : 'document';
      const id = `sim-media-${randomBytes(8).toString('hex')}`;
      this.rememberMedia(id, {
        data: input.media.data,
        mimeType: input.media.mimeType,
        fileName: input.media.fileName,
      });
      message.type = kind;
      message[kind] = {
        id,
        mime_type: input.media.mimeType,
        ...(input.media.caption ? { caption: input.media.caption } : {}),
        ...(kind === 'document' && input.media.fileName ? { filename: input.media.fileName } : {}),
      };
    } else {
      if (!input.text?.trim()) throw badRequest('Type a message');
      message.text = { body: input.text };
    }
    await this.handleWebhook({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: account.wabaId ?? 'simulator',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: {
                  display_phone_number: account.displayPhoneNumber,
                  phone_number_id: account.phoneNumberId,
                },
                contacts: [
                  { wa_id: from, profile: { name: input.name?.trim() || 'Test customer' } },
                ],
                messages: [message],
              },
            },
          ],
        },
      ],
    });
    return { messageId: message.id };
  }

  private simulateReceipts(account: WhatsAppAccount, messageId: string, contact: string) {
    const [deliveredAfter, readAfter] = this.deps.simulatorReceiptDelays ?? [600, 1800];
    for (const [status, delay] of [
      ['delivered', deliveredAfter],
      ['read', readAfter],
    ] as const) {
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        void this.handleWebhook({
          object: 'whatsapp_business_account',
          entry: [
            {
              changes: [
                {
                  field: 'messages',
                  value: {
                    metadata: { phone_number_id: account.phoneNumberId },
                    statuses: [
                      {
                        id: messageId,
                        status,
                        timestamp: String(Math.floor(Date.now() / 1000)),
                        recipient_id: contact,
                      },
                    ],
                  },
                },
              ],
            },
          ],
        }).catch(() => undefined);
      }, delay);
      timer.unref();
      this.timers.add(timer);
    }
  }

  private rememberMedia(id: string, media: IWhatsAppMedia) {
    this.simulatorMedia.set(id, media);
    if (this.simulatorMedia.size > 200)
      this.simulatorMedia.delete(this.simulatorMedia.keys().next().value!);
  }

  private publishMessage(row: WhatsAppMessage) {
    this.deps.push.publish(['whatsapp'], { type: 'whatsappMessage', data: toMessageDTO(row) });
  }

  close() {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }
}
