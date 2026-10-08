import { toast } from 'sonner';
import { create } from 'zustand';
import { endpoints } from '../lib/api';
import { BrowserCallLeg, startRingtone } from '../lib/callAudio';

export interface IncomingCall {
  callId: string;
  accountId: string;
  accountNumber: string;
  from: string;
  contactName: string | null;
  ringSeconds: number;
  receivedAt: number;
}

/** A call this app is on: answered in the app, or a test call to a test number. */
export interface ConnectedCall {
  kind: 'answered' | 'test';
  /** answered: our call id; test: the simulated WhatsApp call id. */
  id: string;
  accountId: string;
  label: string;
  leg: BrowserCallLeg;
  startedAt: number;
  muted: boolean;
}

interface CallsState {
  incoming: IncomingCall[];
  current: ConnectedCall | null;
  busy: boolean;
  ring(call: Omit<IncomingCall, 'receivedAt'>): void;
  dismiss(callId: string): void;
  answer(callId: string): Promise<void>;
  decline(callId: string): Promise<void>;
  /** Call a test number from this browser (the simulator's "Call" button). */
  callTestNumber(
    accountId: string,
    caller: { number: string; name: string },
    label: string,
  ): Promise<void>;
  toggleMute(): void;
  hangup(): Promise<void>;
  /** The other side ended the call. */
  ended(id: string): void;
}

let stopRinging: (() => void) | null = null;
const updateRingtone = (incoming: IncomingCall[]) => {
  if (incoming.length && !stopRinging) stopRinging = startRingtone();
  if (!incoming.length && stopRinging) {
    stopRinging();
    stopRinging = null;
  }
};

export const useCalls = create<CallsState>((set, get) => ({
  incoming: [],
  current: null,
  busy: false,

  ring(call) {
    if (get().incoming.some((c) => c.callId === call.callId)) return;
    const incoming = [...get().incoming, { ...call, receivedAt: Date.now() }];
    set({ incoming });
    updateRingtone(incoming);
  },

  dismiss(callId) {
    const incoming = get().incoming.filter((c) => c.callId !== callId);
    set({ incoming });
    updateRingtone(incoming);
  },

  async answer(callId) {
    const call = get().incoming.find((c) => c.callId === callId);
    if (!call || get().current) return;
    set({ busy: true });
    get().dismiss(callId);
    let leg: BrowserCallLeg | null = null;
    try {
      const created = await BrowserCallLeg.create();
      leg = created.leg;
      const { sdp } = await endpoints.answerCall(callId, created.offer);
      await leg.connect(sdp);
      leg.onStateChange((state) => {
        if (state === 'failed' || state === 'disconnected') get().ended(callId);
      });
      set({
        current: {
          kind: 'answered',
          id: callId,
          accountId: call.accountId,
          label: call.contactName ?? `+${call.from}`,
          leg,
          startedAt: Date.now(),
          muted: false,
        },
      });
    } catch (error) {
      leg?.close();
      toast.error((error as Error).message);
    } finally {
      set({ busy: false });
    }
  },

  async decline(callId) {
    get().dismiss(callId);
    await endpoints.declineCall(callId).catch(() => undefined);
  },

  async callTestNumber(accountId, caller, label) {
    if (get().current) return;
    set({ busy: true });
    let leg: BrowserCallLeg | null = null;
    try {
      const created = await BrowserCallLeg.create();
      leg = created.leg;
      const result = await endpoints.simulateCall(accountId, {
        from: caller.number,
        name: caller.name,
        sdp: created.offer,
      });
      if (result.rejected || !result.sdp) {
        leg.close();
        toast.info('The call was declined (see the number’s call settings)');
        return;
      }
      await leg.connect(result.sdp);
      set({
        current: {
          kind: 'test',
          id: result.waCallId,
          accountId,
          label,
          leg,
          startedAt: Date.now(),
          muted: false,
        },
      });
    } catch (error) {
      leg?.close();
      toast.error((error as Error).message);
    } finally {
      set({ busy: false });
    }
  },

  toggleMute() {
    const current = get().current;
    if (!current) return;
    current.leg.muted = !current.muted;
    set({ current: { ...current, muted: !current.muted } });
  },

  async hangup() {
    const current = get().current;
    if (!current) return;
    set({ current: null });
    current.leg.close();
    if (current.kind === 'answered') await endpoints.hangupCall(current.id).catch(() => undefined);
    else await endpoints.simulateHangup(current.accountId, current.id).catch(() => undefined);
  },

  ended(id) {
    const current = get().current;
    if (current?.id === id) {
      current.leg.close();
      set({ current: null });
      toast.info('Call ended');
    }
    get().dismiss(id);
  },
}));
