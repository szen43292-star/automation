import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import type { Call, Prisma, PrismaClient, WhatsAppAccount } from '@prisma/client';
import {
  CallMediaSession,
  CallRecorder,
  concat,
  loadPrompt,
  silence,
  tone,
  type MediaConfig,
} from '@flowforge/media';
import type { IDataObject, ITriggerEvent } from '@flowforge/workflow';
import type { PushPublisher } from '../executions/types';
import { HttpError, badRequest, conflict } from '../lib/errors';
import type { CloudCall, CloudChangeValue, CloudMessage, CloudStatus } from '../whatsapp/events';
import type { WhatsAppService } from '../whatsapp/WhatsAppService';
import { chooseMode, readCallSettings, type CallMode, type CallSettings } from './settings';

export interface CallDTO {
  id: string;
  accountId: string;
  waCallId: string | null;
  direction: 'inbound' | 'outbound';
  contact: string;
  contactName: string | null;
  status: Call['status'];
  handledBy: string | null;
  answeredBy: { id: string; name: string } | null;
  startedAt: string;
  answeredAt: string | null;
  endedAt: string | null;
  durationSeconds: number | null;
  endReason: string | null;
  hasRecording: boolean;
  transcript: unknown;
  summary: string | null;
}

type CallRow = Call & { answeredBy?: { id: string; name: string } | null };

export const toCallDTO = (c: CallRow): CallDTO => ({
  id: c.id,
  accountId: c.accountId,
  waCallId: c.waCallId,
  direction: c.direction,
  contact: c.contact,
  contactName: c.contactName,
  status: c.status,
  handledBy: c.handledBy,
  answeredBy: c.answeredBy ?? null,
  startedAt: c.startedAt.toISOString(),
  answeredAt: c.answeredAt?.toISOString() ?? null,
  endedAt: c.endedAt?.toISOString() ?? null,
  durationSeconds: c.durationSeconds,
  endReason: c.endReason,
  hasRecording: Boolean(c.recordingPath),
  transcript: c.transcript,
  summary: c.summary,
});

/** Runs a conversation with the caller (the AI voice agent, Phase 5). Resolves when it is over. */
export type CallAgent = (call: {
  callId: string;
  account: WhatsAppAccount;
  contact: string;
  contactName: string | null;
  session: CallMediaSession;
  settings: CallSettings;
  /** Add a line to the call transcript. */
  transcript: (role: 'caller' | 'agent', text: string) => void;
  /** End the call from our side. */
  hangup: (reason: string) => Promise<void>;
  /** Hand the caller to a person in the app (rings them); true when someone picked up. */
  transfer: () => Promise<boolean>;
  /** Aborted when the call ends or a person takes over. */
  signal: AbortSignal;
  /** Business-initiated call: why we are calling, and which agent should talk. */
  outbound: { purpose: string; agentId: string | null } | null;
}) => Promise<void>;

/** Writes the call summary from the transcript (Phase 5). */
export type CallSummarizer = (call: {
  callId: string;
  account: WhatsAppAccount;
  contact: string;
  contactName: string | null;
  transcript: Array<{ role: 'caller' | 'agent'; text: string }>;
}) => Promise<string | null>;

interface ActiveCall {
  callId: string;
  waCallId: string;
  account: WhatsAppAccount;
  contact: string;
  contactName: string | null;
  settings: CallSettings;
  mode: CallMode;
  caller: CallMediaSession;
  answerSdp: string;
  accepted: boolean;
  /** Person who picked up in the app, and their audio leg. */
  personLeg?: CallMediaSession;
  unbridge?: () => void;
  recorder?: CallRecorder;
  ringTimer?: NodeJS.Timeout;
  maxTimer?: NodeJS.Timeout;
  /** The AI agent talking to the caller. */
  agentAbort?: AbortController;
  /** The AI agent is ringing a person (transfer): resolves true when someone picks up. */
  transferring?: (answered: boolean) => void;
  /** Business-initiated call: who talks to the customer once they pick up. */
  outbound?: {
    handler: 'agent' | 'person';
    agentId: string | null;
    purpose: string;
    userId?: string;
  };
  transcript: Array<{ role: 'caller' | 'agent'; text: string; at: string }>;
  finished: boolean;
}

/** Simulated "Meta side" of calls to test numbers: the browser plays the caller. */
interface SimulatorHandshake {
  resolve: (result: { sdp?: string; rejected?: boolean }) => void;
}

export interface CallServiceDeps {
  prisma: PrismaClient;
  whatsapp: WhatsAppService;
  push: PushPublisher;
  logger: FastifyBaseLogger;
  dataDir: string;
  media: MediaConfig;
  defaultTimezone: string;
  onEvent?: (event: ITriggerEvent, item: IDataObject) => Promise<void>;
}

export class CallService {
  private readonly active = new Map<string, ActiveCall>();
  private readonly byWaCallId = new Map<string, string>();
  private readonly simulator = new Map<string, SimulatorHandshake>();
  /** The AI voice agent (Phase 5). */
  agent: CallAgent | null = null;
  /** Whether the AI agent can take calls for this number (an agent with working keys). */
  agentAvailable: (account: WhatsAppAccount, agentId?: string | null) => Promise<boolean> =
    async () => this.agent !== null;
  summarize: CallSummarizer | null = null;

  constructor(private readonly deps: CallServiceDeps) {}

  set onEvent(handler: CallServiceDeps['onEvent']) {
    this.deps.onEvent = handler;
  }

  // ---- Settings ---------------------------------------------------------------------------------

  settingsOf(account: WhatsAppAccount): CallSettings {
    return readCallSettings(account.callSettings, this.deps.defaultTimezone);
  }

  async getSettings(accountId: string) {
    const account = await this.deps.whatsapp.row(accountId);
    return {
      settings: this.settingsOf(account),
      callingEnabled: account.callingEnabled,
      hasGreetingAudio: await this.greetingAudio(accountId).then((a) => a !== null),
      aiAvailable: this.agent !== null && (await this.agentAvailable(account)),
    };
  }

  async saveSettings(accountId: string, settings: CallSettings) {
    await this.deps.whatsapp.row(accountId);
    await this.deps.prisma.whatsAppAccount.update({
      where: { id: accountId },
      data: { callSettings: settings as unknown as Prisma.InputJsonValue },
    });
    return this.getSettings(accountId);
  }

  /** Switch calling on for the number at Meta (test numbers: just locally). */
  async enableCalling(accountId: string) {
    const account = await this.deps.whatsapp.row(accountId);
    if (account.mode === 'cloud') {
      await this.deps.whatsapp.graphRequest(account, {
        method: 'POST',
        path: `/${account.phoneNumberId}/settings`,
        json: {
          calling: {
            status: 'ENABLED',
            call_icon_visibility: 'DEFAULT',
            callback_permission_status: 'ENABLED',
          },
        },
      });
    }
    await this.deps.prisma.whatsAppAccount.update({
      where: { id: accountId },
      data: { callingEnabled: true },
    });
    return this.getSettings(accountId);
  }

  private greetingPath(accountId: string) {
    return join(this.deps.dataDir, 'greetings', `${accountId}.wav`);
  }

  async setGreetingAudio(accountId: string, wav: Buffer | null) {
    await this.deps.whatsapp.row(accountId);
    const path = this.greetingPath(accountId);
    if (!wav) {
      await rm(path, { force: true });
      return;
    }
    const samples = loadPrompt(wav); // validates the file
    if (samples.length > 48_000 * 60)
      throw badRequest('The greeting can be at most 60 seconds long');
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, wav);
  }

  private async greetingAudio(accountId: string): Promise<Int16Array | null> {
    try {
      return loadPrompt(await readFile(this.greetingPath(accountId)));
    } catch {
      return null;
    }
  }

  // ---- Call log ---------------------------------------------------------------------------------

  async list(options: {
    accountId?: string;
    status?: Call['status'][];
    limit?: number;
    before?: string;
  }) {
    const rows = await this.deps.prisma.call.findMany({
      where: {
        ...(options.accountId ? { accountId: options.accountId } : {}),
        ...(options.status?.length ? { status: { in: options.status } } : {}),
        ...(options.before ? { startedAt: { lt: new Date(options.before) } } : {}),
      },
      include: { answeredBy: { select: { id: true, name: true } } },
      orderBy: { startedAt: 'desc' },
      take: Math.min(options.limit ?? 50, 200),
    });
    return rows.map(toCallDTO);
  }

  async get(id: string): Promise<CallDTO> {
    const row = await this.deps.prisma.call.findUnique({
      where: { id },
      include: { answeredBy: { select: { id: true, name: true } } },
    });
    if (!row) throw new HttpError(404, 'Call not found', 'NotFound');
    return toCallDTO(row);
  }

  async recording(id: string): Promise<Buffer> {
    const row = await this.deps.prisma.call.findUnique({ where: { id } });
    if (!row?.recordingPath) throw new HttpError(404, 'This call has no recording', 'NotFound');
    return readFile(join(this.deps.dataDir, row.recordingPath));
  }

  async deleteRecording(id: string) {
    const row = await this.deps.prisma.call.findUnique({ where: { id } });
    if (!row?.recordingPath) return;
    await rm(join(this.deps.dataDir, row.recordingPath), { force: true });
    await this.deps.prisma.call.update({
      where: { id },
      data: { recordingPath: null, recordingBytes: null },
    });
  }

  /** Calls that are ringing or in progress right now (e.g. to show the ringing banner after a reload). */
  /** Calls in progress (ringing, with a person or with the AI agent). */
  get activeCount(): number {
    return this.active.size;
  }

  async activeCalls(): Promise<Array<CallDTO & { ringSeconds: number; ringing: boolean }>> {
    const ids = [...this.active.keys()];
    if (!ids.length) return [];
    const rows = await this.deps.prisma.call.findMany({
      where: { id: { in: ids } },
      include: { answeredBy: { select: { id: true, name: true } } },
    });
    return rows.map((row) => {
      const active = this.active.get(row.id)!;
      return {
        ...toCallDTO(row),
        ringSeconds: active.settings.ringSeconds,
        ringing: !active.personLeg && Boolean(active.ringTimer),
      };
    });
  }

  // ---- Webhook events ---------------------------------------------------------------------------

  async handleWebhook(account: WhatsAppAccount, value: CloudChangeValue) {
    const names = new Map((value.contacts ?? []).map((c) => [c.wa_id, c.profile?.name]));
    for (const call of value.calls ?? []) {
      if (call.event === 'connect')
        await this.onConnect(account, call, names.get(call.from) ?? null);
      else if (call.event === 'terminate') await this.onTerminate(call);
    }
  }

  private async onConnect(account: WhatsAppAccount, event: CloudCall, contactName: string | null) {
    if (this.byWaCallId.has(event.id)) {
      // Our outbound call was picked up (its SDP answer), or a webhook retry.
      const active = this.active.get(this.byWaCallId.get(event.id)!);
      if (active?.outbound && !active.accepted && event.session?.sdp)
        await this.onOutboundAnswer(active, event.session.sdp);
      return;
    }
    const offer = event.session?.sdp;
    const settings = this.settingsOf(account);
    const row = await this.deps.prisma.call.create({
      data: {
        accountId: account.id,
        waCallId: event.id,
        direction: event.direction === 'BUSINESS_INITIATED' ? 'outbound' : 'inbound',
        contact: event.from,
        contactName,
        status: 'ringing',
      },
    });
    this.publish(row);
    await this.emit('call_started', account, row);

    let mode = chooseMode(settings);
    if (mode === 'ai' && !(await this.aiReady(account))) mode = 'voicemail';
    if (mode === 'reject' || !offer) {
      await this.callAction(account, event.id, 'reject');
      await this.finishRow(row.id, {
        status: 'rejected',
        handledBy: 'rejected',
        endReason: offer ? 'Rejected by settings' : 'No audio offer',
      });
      await this.sendMissedMessage(account, event.from, settings);
      return;
    }

    const caller = new CallMediaSession(this.deps.media);
    let answerSdp: string;
    try {
      answerSdp = await caller.answer(offer);
    } catch (error) {
      await caller.close();
      this.deps.logger.error({ err: error, callId: row.id }, 'Could not answer the call offer');
      await this.callAction(account, event.id, 'reject').catch(() => undefined);
      await this.finishRow(row.id, { status: 'failed', endReason: 'Could not set up call audio' });
      return;
    }
    const active: ActiveCall = {
      callId: row.id,
      waCallId: event.id,
      account,
      contact: event.from,
      contactName,
      settings,
      mode,
      caller,
      answerSdp,
      accepted: false,
      transcript: [],
      finished: false,
    };
    this.active.set(row.id, active);
    this.byWaCallId.set(event.id, row.id);
    caller.onState((state) => {
      if (state === 'failed') void this.finish(active, 'failed', 'Call audio connection failed');
    });

    // Media is set up before the call is picked up, so the first words are not cut off.
    await this.callAction(account, event.id, 'pre_accept', answerSdp);
    if (mode === 'app') this.ring(active);
    // The conversation runs in the background (handleWith reports its own errors).
    else void this.handleWith(active, mode);
  }

  private async onTerminate(event: CloudCall) {
    const callId = this.byWaCallId.get(event.id);
    const active = callId ? this.active.get(callId) : undefined;
    if (active) {
      await this.finish(active, active.accepted ? 'ended' : 'missed', 'Caller hung up');
      return;
    }
    // A call that ended before we handled it (or after a restart).
    const row = await this.deps.prisma.call.findUnique({ where: { waCallId: event.id } });
    if (row && (row.status === 'ringing' || row.status === 'answered')) {
      await this.finishRow(row.id, {
        status: row.status === 'ringing' ? 'missed' : 'ended',
        endReason: 'Caller hung up',
      });
    }
  }

  // ---- Modes ------------------------------------------------------------------------------------

  private async aiReady(account: WhatsAppAccount, agentId?: string | null) {
    if (!this.agent) return false;
    return this.agentAvailable(account, agentId).catch(() => false);
  }

  /** Ring everyone in the app; the fallback takes over if nobody answers in time. */
  private ring(active: ActiveCall, onTimeout?: () => void) {
    this.deps.push.publish(['whatsapp'], {
      type: 'incomingCall',
      data: {
        callId: active.callId,
        accountId: active.account.id,
        accountNumber: active.account.displayPhoneNumber,
        from: active.contact,
        contactName: active.contactName,
        ringSeconds: active.settings.ringSeconds,
      },
    });
    active.ringTimer = setTimeout(() => {
      if (onTimeout) onTimeout();
      else void this.fallback(active, 'Nobody answered in the app');
    }, active.settings.ringSeconds * 1000);
    active.ringTimer.unref();
  }

  private async fallback(active: ActiveCall, why: string) {
    if (active.finished || active.personLeg) return;
    if (active.ringTimer) clearTimeout(active.ringTimer);
    this.deps.push.publish(['whatsapp'], {
      type: 'callUpdated',
      data: { ...(await this.get(active.callId)), note: why },
    });
    let mode: CallMode = active.settings.fallback;
    if (mode === 'ai' && !(await this.aiReady(active.account))) mode = 'voicemail';
    await this.handleWith(active, mode);
  }

  private async handleWith(active: ActiveCall, mode: CallMode) {
    try {
      if (mode === 'reject') {
        await this.callAction(active.account, active.waCallId, 'terminate');
        await this.sendMissedMessage(active.account, active.contact, active.settings);
        await this.finish(active, 'missed', 'Declined by settings');
      } else if (mode === 'voicemail') {
        await this.voicemail(active);
      } else if (mode === 'ai' && this.agent) {
        await this.runAgent(active);
      }
    } catch (error) {
      this.deps.logger.error({ err: error, callId: active.callId }, 'Call handling failed');
      await this.finish(active, active.accepted ? 'ended' : 'failed', (error as Error).message);
    }
  }

  private async accept(active: ActiveCall, handledBy: string, answeredById?: string) {
    if (!active.accepted) {
      await this.callAction(active.account, active.waCallId, 'accept', active.answerSdp);
      active.accepted = true;
    }
    if (active.settings.record && !active.recorder) {
      active.recorder = new CallRecorder();
      const recorder = active.recorder;
      active.caller.onAudio((frame) => recorder.caller(frame));
      active.caller.onSent((frame) => recorder.agent(frame));
    }
    const row = await this.deps.prisma.call.update({
      where: { id: active.callId },
      data: {
        status: 'answered',
        answeredAt: new Date(),
        handledBy,
        answeredById: answeredById ?? null,
      },
      include: { answeredBy: { select: { id: true, name: true } } },
    });
    this.publish(row);
  }

  private async voicemail(active: ActiveCall) {
    await this.accept(active, 'voicemail');
    await active.caller.connected(15_000);
    const greeting = (await this.greetingAudio(active.account.id)) ?? silence(300);
    await active.caller.play(concat(greeting, silence(250), tone(880, 350, 0.25)));
    active.maxTimer = setTimeout(() => {
      void this.hangupActive(active, 'Voicemail time limit reached');
    }, active.settings.voicemailMaxSeconds * 1000);
    active.maxTimer.unref();
  }

  private async runAgent(active: ActiveCall) {
    await this.accept(active, 'ai');
    await active.caller.connected(15_000);
    const abort = new AbortController();
    active.agentAbort = abort;
    await this.agent!({
      signal: abort.signal,
      outbound: active.outbound
        ? { purpose: active.outbound.purpose, agentId: active.outbound.agentId }
        : null,
      callId: active.callId,
      account: active.account,
      contact: active.contact,
      contactName: active.contactName,
      session: active.caller,
      settings: active.settings,
      transcript: (role, text) => {
        active.transcript.push({ role, text, at: new Date().toISOString() });
        this.deps.push.publish(['whatsapp'], {
          type: 'callTranscript',
          data: { callId: active.callId, role, text },
        });
      },
      hangup: (reason) => this.hangupActive(active, reason),
      transfer: () => this.transfer(active),
    });
  }

  /** The AI agent hands the caller to a person: ring the app and play a ringback tone meanwhile. */
  private transfer(active: ActiveCall): Promise<boolean> {
    if (active.finished || active.personLeg) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      let done = false;
      const settle = (answered: boolean) => {
        if (done) return;
        done = true;
        active.transferring = undefined;
        if (active.ringTimer) clearTimeout(active.ringTimer);
        active.ringTimer = undefined;
        if (!answered) {
          active.caller.interrupt();
          void this.get(active.callId).then((call) =>
            this.deps.push.publish(['whatsapp'], {
              type: 'callUpdated',
              data: { ...call, note: 'Nobody answered the transfer' },
            }),
          );
        }
        resolve(answered);
      };
      active.transferring = settle;
      this.ring(active, () => settle(false));
      const ringback = concat(tone(425, 1000, 0.08), silence(2000));
      const loop = async () => {
        while (!done && !active.finished && !active.personLeg) await active.caller.play(ringback);
      };
      void loop();
    });
  }

  // ---- Outbound calls (business-initiated) ------------------------------------------------------

  /** Whether a customer allowed this number to call them. */
  async permission(accountId: string, contact: string) {
    const row = await this.deps.prisma.callPermission.findUnique({
      where: { accountId_contact: { accountId, contact: contact.replace(/[^\d]/g, '') } },
    });
    if (!row) return { status: 'none' as const, expiresAt: null, requestedAt: null };
    const expired = row.status === 'granted' && row.expiresAt && row.expiresAt < new Date();
    return {
      status: expired ? ('expired' as const) : row.status,
      expiresAt: row.expiresAt?.toISOString() ?? null,
      requestedAt: row.requestedAt?.toISOString() ?? null,
      permanent: row.permanent,
    };
  }

  /** Ask the customer (a WhatsApp message with Allow / Not now) for permission to call them. */
  async requestPermission(accountId: string, to: string, text?: string) {
    const contact = to.replace(/[^\d]/g, '');
    if (contact.length < 7) throw badRequest('Enter the number with country code');
    const current = await this.permission(accountId, contact);
    if (current.status === 'granted') return { alreadyGranted: true, messageId: null };
    const sent = await this.deps.whatsapp.send(accountId, contact, {
      type: 'interactive',
      interactive: {
        type: 'call_permission_request',
        action: { name: 'call_permission_request' },
        body: { text: text?.trim() || 'We would like to call you on WhatsApp. Is that OK?' },
      },
    });
    await this.deps.prisma.callPermission.upsert({
      where: { accountId_contact: { accountId, contact } },
      create: { accountId, contact, status: 'requested', requestedAt: new Date() },
      update: { status: 'requested', requestedAt: new Date() },
    });
    return { alreadyGranted: false, messageId: sent.messageId };
  }

  /** Received messages: the customer's answer to a permission request. */
  async handleInbound(account: WhatsAppAccount, message: CloudMessage) {
    const reply = message.interactive?.call_permission_reply;
    if (!reply) return;
    const granted = reply.response === 'accept';
    const expires = Number(reply.expiration_timestamp);
    const data = {
      status: granted ? ('granted' as const) : ('denied' as const),
      permanent: Boolean(reply.is_permanent),
      respondedAt: new Date(),
      expiresAt:
        granted && Number.isFinite(expires) && expires > 0 ? new Date(expires * 1000) : null,
    };
    await this.deps.prisma.callPermission.upsert({
      where: { accountId_contact: { accountId: account.id, contact: message.from } },
      create: { accountId: account.id, contact: message.from, ...data },
      update: data,
    });
    this.deps.push.publish(['whatsapp'], {
      type: 'callPermission',
      data: { accountId: account.id, contact: message.from, status: data.status },
    });
  }

  /**
   * Call a customer. The AI agent talks (with a purpose, e.g. "remind them of tomorrow's
   * appointment"), or the person in the app - whose browser sends `personSdp`.
   */
  async startOutbound(input: {
    accountId: string;
    to: string;
    handler: 'agent' | 'person';
    agentId?: string | null;
    purpose?: string;
    personSdp?: string;
    userId?: string;
  }): Promise<{ callId: string; waCallId: string; sdp?: string }> {
    const account = await this.deps.whatsapp.row(input.accountId);
    const contact = input.to.replace(/[^\d]/g, '');
    if (contact.length < 7) throw badRequest('Enter the number with country code');
    const permission = await this.permission(account.id, contact);
    if (permission.status !== 'granted') {
      throw new HttpError(
        409,
        permission.status === 'requested'
          ? 'The customer has not answered your call permission request yet'
          : 'The customer has not allowed calls - send them a call permission request first',
        'CallPermissionRequired',
        { permission },
      );
    }
    if (input.handler === 'person' && !input.personSdp)
      throw badRequest('Your audio (sdp) is missing');
    if (input.handler === 'agent' && !(await this.aiReady(account, input.agentId)))
      throw badRequest('The AI agent is not ready - create an agent and add AI provider keys');

    const named = await this.deps.prisma.whatsAppMessage.findFirst({
      where: { accountId: account.id, contact, contactName: { not: null } },
      orderBy: { timestamp: 'desc' },
      select: { contactName: true },
    });
    const caller = new CallMediaSession(this.deps.media);
    let personLeg: CallMediaSession | undefined;
    let personAnswer: string | undefined;
    let waCallId: string;
    try {
      const offer = await caller.offer();
      if (input.handler === 'person') {
        personLeg = new CallMediaSession(this.deps.media);
        personAnswer = await personLeg.answer(input.personSdp!);
      }
      if (account.mode === 'simulator') {
        waCallId = `wacid.SIM${randomBytes(10).toString('hex').toUpperCase()}`;
        this.deps.push.publish(['whatsapp'], {
          type: 'simulatedOutboundCall',
          data: {
            accountId: account.id,
            waCallId,
            to: contact,
            from: account.displayPhoneNumber,
            businessName: account.verifiedName ?? account.name,
            sdp: offer,
          },
        });
      } else {
        const result = await this.deps.whatsapp.graphRequest<{ calls?: Array<{ id: string }> }>(
          account,
          {
            method: 'POST',
            path: `/${account.phoneNumberId}/calls`,
            json: {
              messaging_product: 'whatsapp',
              to: contact,
              action: 'connect',
              session: { sdp_type: 'offer', sdp: offer },
            },
          },
        );
        const id = result.calls?.[0]?.id;
        if (!id) throw new Error('WhatsApp did not start the call');
        waCallId = id;
      }
    } catch (error) {
      await Promise.all([caller.close(), personLeg?.close()]);
      throw error;
    }

    const purpose = input.purpose?.trim() ?? '';
    const row = await this.deps.prisma.call.create({
      data: {
        accountId: account.id,
        waCallId,
        direction: 'outbound',
        contact,
        contactName: named?.contactName ?? null,
        status: 'ringing',
        answeredById: input.handler === 'person' ? (input.userId ?? null) : null,
        metadata: { purpose, handler: input.handler },
      },
    });
    const active: ActiveCall = {
      callId: row.id,
      waCallId,
      account,
      contact,
      contactName: named?.contactName ?? null,
      settings: this.settingsOf(account),
      mode: input.handler === 'agent' ? 'ai' : 'app',
      caller,
      answerSdp: '',
      accepted: false,
      transcript: [],
      finished: false,
      personLeg,
      outbound: {
        handler: input.handler,
        agentId: input.agentId ?? null,
        purpose,
        ...(input.userId ? { userId: input.userId } : {}),
      },
    };
    this.active.set(row.id, active);
    this.byWaCallId.set(waCallId, row.id);
    caller.onState((state) => {
      if (state === 'failed') void this.finish(active, 'failed', 'Call audio connection failed');
    });
    personLeg?.onState((state) => {
      if (state === 'failed' || state === 'closed')
        void this.hangupActive(active, 'You left the call');
    });
    active.ringTimer = setTimeout(() => void this.hangupActive(active, 'No answer'), 45_000);
    active.ringTimer.unref();
    this.publish(row);
    await this.emit('call_started', account, row);
    return { callId: row.id, waCallId, ...(personAnswer ? { sdp: personAnswer } : {}) };
  }

  /** The customer picked up our call. */
  private async onOutboundAnswer(active: ActiveCall, sdp: string) {
    if (active.ringTimer) clearTimeout(active.ringTimer);
    active.ringTimer = undefined;
    try {
      await active.caller.acceptAnswer(sdp);
      await active.caller.connected(15_000);
      active.accepted = true; // business-initiated: nothing to accept at Meta
      if (active.outbound!.handler === 'person' && active.personLeg) {
        await active.personLeg.connected(15_000);
        await this.accept(active, 'person', active.outbound!.userId);
        active.unbridge = active.caller.bridge(active.personLeg);
        if (active.recorder) {
          const recorder = active.recorder;
          active.personLeg.onAudio((frame) => recorder.agent(frame));
        }
        this.deps.push.publish(['whatsapp'], {
          type: 'callAnswered',
          data: { callId: active.callId, userId: active.outbound!.userId ?? '' },
        });
      } else {
        void this.handleWith(active, 'ai');
      }
    } catch (error) {
      this.deps.logger.error({ err: error, callId: active.callId }, 'Outbound call failed');
      await this.hangupActive(active, `Call failed: ${(error as Error).message}`);
    }
  }

  /** Call status updates: the customer declined, or it is ringing. */
  async handleCallStatus(_account: WhatsAppAccount, status: CloudStatus) {
    const callId = this.byWaCallId.get(status.id);
    const active = callId ? this.active.get(callId) : undefined;
    if (!active) return;
    const value = status.status.toLowerCase();
    if (value === 'rejected' && !active.accepted)
      await this.finish(active, 'rejected', 'Declined by the customer');
  }

  async simulateOutboundAnswer(accountId: string, waCallId: string, sdp: string) {
    const account = await this.deps.whatsapp.row(accountId);
    const active = this.active.get(this.byWaCallId.get(waCallId) ?? '');
    if (!active) throw new HttpError(404, 'This call has ended', 'NotFound');
    await this.handleWebhook(account, {
      metadata: { phone_number_id: account.phoneNumberId },
      calls: [
        {
          id: waCallId,
          from: account.displayPhoneNumber.replace(/[^\d]/g, ''),
          to: active.contact,
          event: 'connect',
          timestamp: String(Math.floor(Date.now() / 1000)),
          direction: 'BUSINESS_INITIATED',
          session: { sdp_type: 'answer', sdp },
        },
      ],
    });
  }

  async simulateOutboundDecline(accountId: string, waCallId: string) {
    const account = await this.deps.whatsapp.row(accountId);
    await this.handleCallStatus(account, {
      id: waCallId,
      type: 'call',
      status: 'REJECTED',
      timestamp: String(Math.floor(Date.now() / 1000)),
      recipient_id: '',
    });
  }

  // ---- Answering in the app ---------------------------------------------------------------------

  /**
   * A person picks up in FlowForge: their browser/app sends a WebRTC offer, we answer it and
   * bridge their audio to the caller.
   */
  async answerInApp(
    callId: string,
    user: { id: string },
    offerSdp: string,
  ): Promise<{ sdp: string }> {
    const active = this.active.get(callId);
    if (!active || active.finished) throw new HttpError(404, 'This call has ended', 'NotFound');
    if (active.personLeg) throw conflict('Someone else already answered this call');
    if (active.ringTimer) clearTimeout(active.ringTimer);
    active.caller.interrupt();
    const leg = new CallMediaSession(this.deps.media);
    active.personLeg = leg;
    const sdp = await leg.answer(offerSdp);
    leg.onState((state) => {
      if (state === 'failed' || state === 'closed')
        void this.hangupActive(active, 'The person in the app left');
    });
    void leg
      .connected(20_000)
      .then(async () => {
        if (active.finished) return;
        const fromAgent = Boolean(active.agentAbort);
        active.transferring?.(true);
        active.agentAbort?.abort();
        await this.accept(active, fromAgent ? 'ai+person' : 'person', user.id);
        active.unbridge = active.caller.bridge(leg);
        if (active.recorder) {
          const recorder = active.recorder;
          leg.onAudio((frame) => recorder.agent(frame));
        }
        this.deps.push.publish(['whatsapp'], {
          type: 'callAnswered',
          data: { callId, userId: user.id },
        });
      })
      .catch(
        (error: Error) =>
          void this.hangupActive(active, `Could not connect your audio: ${error.message}`),
      );
    return { sdp };
  }

  /** "Decline" in the app: let the fallback (voicemail, AI or reject) handle the caller. */
  async declineInApp(callId: string) {
    const active = this.active.get(callId);
    if (!active || active.finished) return;
    if (active.transferring) {
      active.transferring(false);
      return;
    }
    await this.fallback(active, 'Declined in the app');
  }

  async hangup(callId: string) {
    const active = this.active.get(callId);
    if (!active) throw new HttpError(404, 'This call has ended', 'NotFound');
    await this.hangupActive(active, 'Ended by the business');
  }

  private async hangupActive(active: ActiveCall, reason: string) {
    if (active.finished) return;
    await this.callAction(active.account, active.waCallId, 'terminate').catch((error: Error) =>
      this.deps.logger.warn({ err: error }, 'Could not terminate the call at Meta'),
    );
    await this.finish(active, active.accepted ? 'ended' : 'missed', reason);
  }

  // ---- Finishing --------------------------------------------------------------------------------

  private async finish(active: ActiveCall, status: Call['status'], reason: string) {
    if (active.finished) return;
    active.finished = true;
    this.active.delete(active.callId);
    this.byWaCallId.delete(active.waCallId);
    if (active.ringTimer) clearTimeout(active.ringTimer);
    if (active.maxTimer) clearTimeout(active.maxTimer);
    active.transferring?.(false);
    active.agentAbort?.abort();
    active.unbridge?.();
    let recordingPath: string | null = null;
    let recordingBytes: number | null = null;
    if (active.recorder && active.recorder.seconds > 0.5) {
      const wav = active.recorder.finish();
      recordingPath = join('recordings', `${active.callId}.wav`);
      await mkdir(join(this.deps.dataDir, 'recordings'), { recursive: true });
      await writeFile(join(this.deps.dataDir, recordingPath), wav);
      recordingBytes = wav.length;
    }
    await Promise.all([active.caller.close(), active.personLeg?.close()]);
    let summary: string | null = null;
    if (this.summarize && active.transcript.some((line) => line.role === 'caller')) {
      summary = await Promise.race([
        this.summarize({
          callId: active.callId,
          account: active.account,
          contact: active.contact,
          contactName: active.contactName,
          transcript: active.transcript,
        }),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 30_000).unref()),
      ]).catch((error: Error) => {
        this.deps.logger.warn(
          { err: error, callId: active.callId },
          'Could not summarize the call',
        );
        return null;
      });
    }
    await this.finishRow(active.callId, {
      status,
      endReason: reason,
      recordingPath,
      recordingBytes,
      ...(active.transcript.length ? { transcript: active.transcript } : {}),
      ...(summary ? { summary } : {}),
    });
  }

  private async finishRow(
    callId: string,
    data: {
      status: Call['status'];
      endReason: string;
      handledBy?: string;
      recordingPath?: string | null;
      recordingBytes?: number | null;
      transcript?: unknown;
      summary?: string;
    },
  ) {
    const existing = await this.deps.prisma.call.findUnique({ where: { id: callId } });
    if (!existing) return;
    const endedAt = new Date();
    const row = await this.deps.prisma.call.update({
      where: { id: callId },
      data: {
        status: data.status,
        endReason: data.endReason,
        endedAt,
        durationSeconds: existing.answeredAt
          ? Math.round((endedAt.getTime() - existing.answeredAt.getTime()) / 1000)
          : 0,
        ...(data.handledBy ? { handledBy: data.handledBy } : {}),
        ...(data.recordingPath !== undefined
          ? { recordingPath: data.recordingPath, recordingBytes: data.recordingBytes }
          : {}),
        ...(data.transcript ? { transcript: data.transcript as Prisma.InputJsonValue } : {}),
        ...(data.summary ? { summary: data.summary } : {}),
      },
      include: { answeredBy: { select: { id: true, name: true } }, account: true },
    });
    this.publish(row);
    await this.emit('call_ended', row.account, row);
  }

  private async sendMissedMessage(
    account: WhatsAppAccount,
    contact: string,
    settings: CallSettings,
  ) {
    if (!settings.rejectMessage.trim()) return;
    await this.deps.whatsapp
      .send(account.id, contact, { type: 'text', text: { body: settings.rejectMessage } })
      .catch((error: Error) =>
        this.deps.logger.warn({ err: error }, 'Could not send the missed-call message'),
      );
  }

  // ---- Meta call actions ------------------------------------------------------------------------

  private async callAction(
    account: WhatsAppAccount,
    waCallId: string,
    action: 'pre_accept' | 'accept' | 'reject' | 'terminate',
    sdp?: string,
  ) {
    if (account.mode === 'simulator') {
      const handshake = this.simulator.get(waCallId);
      if (action === 'pre_accept' || action === 'accept') handshake?.resolve({ sdp });
      else if (action === 'reject') handshake?.resolve({ rejected: true });
      if (action !== 'pre_accept') {
        this.deps.push.publish(['whatsapp'], {
          type: 'simulatedCallAction',
          data: { waCallId, action },
        });
      }
      return;
    }
    await this.deps.whatsapp.graphRequest(account, {
      method: 'POST',
      path: `/${account.phoneNumberId}/calls`,
      json: {
        messaging_product: 'whatsapp',
        call_id: waCallId,
        action,
        ...(sdp ? { session: { sdp_type: 'answer', sdp } } : {}),
      },
    });
  }

  // ---- Simulator (test numbers) -----------------------------------------------------------------

  /**
   * The browser calls a test number: its WebRTC offer goes through the same webhook handling as a
   * real WhatsApp call. Resolves with our answer SDP (or `rejected`).
   */
  async simulateCall(accountId: string, input: { from: string; name?: string; sdp: string }) {
    const account = await this.deps.whatsapp.row(accountId);
    if (account.mode !== 'simulator') throw badRequest('Only test numbers can be called from here');
    const from = input.from.replace(/[^\d]/g, '');
    if (from.length < 7) throw badRequest('Enter the caller number with country code');
    const waCallId = `wacid.SIM${randomBytes(10).toString('hex').toUpperCase()}`;
    const result = new Promise<{ sdp?: string; rejected?: boolean }>((resolve) => {
      this.simulator.set(waCallId, { resolve });
      setTimeout(() => resolve({ rejected: true }), 15_000).unref();
    });
    void this.handleWebhook(account, {
      metadata: { phone_number_id: account.phoneNumberId },
      contacts: [{ wa_id: from, profile: { name: input.name?.trim() || 'Test caller' } }],
      calls: [
        {
          id: waCallId,
          from,
          to: account.displayPhoneNumber.replace(/[^\d]/g, ''),
          event: 'connect',
          timestamp: String(Math.floor(Date.now() / 1000)),
          direction: 'USER_INITIATED',
          session: { sdp_type: 'offer', sdp: input.sdp },
        },
      ],
    }).catch((error: unknown) => this.deps.logger.error({ err: error }, 'Simulated call failed'));
    const answer = await result;
    this.simulator.delete(waCallId);
    return { waCallId, ...answer };
  }

  async simulateHangup(accountId: string, waCallId: string) {
    const account = await this.deps.whatsapp.row(accountId);
    await this.handleWebhook(account, {
      metadata: { phone_number_id: account.phoneNumberId },
      calls: [
        {
          id: waCallId,
          from: '',
          to: '',
          event: 'terminate',
          timestamp: String(Math.floor(Date.now() / 1000)),
        },
      ],
    });
  }

  // ---- Helpers ----------------------------------------------------------------------------------

  private publish(row: CallRow) {
    this.deps.push.publish(['whatsapp'], { type: 'callUpdated', data: toCallDTO(row) });
  }

  private async emit(name: 'call_started' | 'call_ended', account: WhatsAppAccount, row: Call) {
    if (!this.deps.onEvent) return;
    const item: IDataObject = {
      event: name === 'call_started' ? 'call' : 'call_ended',
      account: {
        id: account.id,
        phoneNumber: account.displayPhoneNumber,
        name: account.verifiedName ?? account.name,
      },
      callId: row.id,
      from: row.contact,
      contactName: row.contactName,
      direction: row.direction,
      status: row.status,
      handledBy: row.handledBy,
      startedAt: row.startedAt.toISOString(),
      ...(name === 'call_ended'
        ? {
            endedAt: row.endedAt?.toISOString() ?? null,
            durationSeconds: row.durationSeconds,
            endReason: row.endReason,
            hasRecording: Boolean(row.recordingPath),
            transcript: (row.transcript as IDataObject[] | null) ?? [],
            summary: row.summary,
          }
        : {}),
    };
    await this.deps
      .onEvent({ source: 'whatsapp', scope: account.id, name }, item)
      .catch((error: unknown) =>
        this.deps.logger.error({ err: error }, 'Could not start workflows for a call'),
      );
  }

  async shutdown() {
    for (const active of [...this.active.values()]) {
      await this.hangupActive(active, 'Server shutting down').catch(() => undefined);
    }
  }
}
