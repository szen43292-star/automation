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
import type { CloudCall, CloudChangeValue } from '../whatsapp/events';
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
  /** Hand the caller to a person in the app (rings them). */
  transfer: () => Promise<boolean>;
}) => Promise<void>;

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
  /** Set by Phase 5 when an AI agent is configured. */
  agent: CallAgent | null = null;

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
      aiAvailable: this.agent !== null,
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
    if (this.byWaCallId.has(event.id)) return; // webhook retry
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
    if (mode === 'ai' && !this.agent) mode = 'voicemail';
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
    else await this.handleWith(active, mode);
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

  /** Ring everyone in the app; the fallback takes over if nobody answers in time. */
  private ring(active: ActiveCall) {
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
      void this.fallback(active, 'Nobody answered in the app');
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
    if (mode === 'ai' && !this.agent) mode = 'voicemail';
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
    await this.agent!({
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
      transfer: async () => {
        this.ring(active);
        return true;
      },
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
        await this.accept(active, active.mode === 'ai' ? 'ai+person' : 'person', user.id);
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
    await this.finishRow(active.callId, {
      status,
      endReason: reason,
      recordingPath,
      recordingBytes,
      ...(active.transcript.length ? { transcript: active.transcript } : {}),
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
