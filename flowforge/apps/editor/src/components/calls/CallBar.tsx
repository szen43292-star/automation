import { Mic, MicOff, Phone, PhoneIncoming, PhoneOff } from 'lucide-react';
import { useEffect, useState } from 'react';
import { endpoints } from '../../lib/api';
import { push } from '../../lib/push';
import { useCalls } from '../../stores/calls';
import { Spinner } from '../ui';

const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

/** Ringing calls (answer / decline) and the call in progress - shown on every page. */
export function CallBar() {
  const { incoming, current, busy } = useCalls();
  const [, tick] = useState(0);

  useEffect(() => {
    const unsubscribe = push.subscribe('whatsapp');
    const calls = useCalls.getState();
    const off = push.on((message) => {
      if (message.type === 'incomingCall') calls.ring(message.data);
      else if (message.type === 'callAnswered') calls.dismiss(message.data.callId);
      else if (message.type === 'callUpdated') {
        const { id, status } = message.data;
        if (status !== 'ringing' && status !== 'answered') useCalls.getState().ended(id);
        else if (status === 'answered') useCalls.getState().dismiss(id);
      } else if (message.type === 'simulatedOutboundCall') {
        // A test number's business calls the simulated customer: this browser is their phone.
        calls.ring({
          callId: `sim:${message.data.waCallId}`,
          accountId: message.data.accountId,
          accountNumber: message.data.from,
          from: message.data.to,
          contactName: `${message.data.businessName} (calling the test customer)`,
          ringSeconds: 45,
          simulated: { waCallId: message.data.waCallId, sdp: message.data.sdp },
        });
      } else if (
        message.type === 'simulatedCallAction' &&
        ['terminate', 'reject'].includes(message.data.action)
      ) {
        useCalls.getState().ended(message.data.waCallId);
      }
    });
    // Calls already ringing when the app opens.
    void endpoints
      .activeCalls()
      .then(({ data }) =>
        data
          .filter((c) => c.ringing)
          .forEach((c) =>
            calls.ring({
              callId: c.id,
              accountId: c.accountId,
              accountNumber: '',
              from: c.contact,
              contactName: c.contactName,
              ringSeconds: c.ringSeconds,
            }),
          ),
      )
      .catch(() => undefined);
    const timer = setInterval(() => tick((t) => t + 1), 1000);
    return () => {
      off();
      unsubscribe();
      clearInterval(timer);
    };
  }, []);

  // Stop showing calls whose ring time is over (the fallback took them).
  useEffect(() => {
    for (const call of incoming) {
      if (Date.now() - call.receivedAt > (call.ringSeconds + 2) * 1000)
        useCalls.getState().dismiss(call.callId);
    }
  });

  if (!incoming.length && !current) return null;

  return (
    <div
      className="fixed inset-x-3 bottom-[calc(4rem+env(safe-area-inset-bottom))] z-50 flex flex-col gap-2 sm:inset-x-auto sm:right-4 sm:w-80 md:bottom-4"
      role="region"
      aria-label="Calls"
    >
      {incoming.map((call) => (
        <div
          key={call.callId}
          className="rounded-xl border border-line bg-panel p-4 shadow-xl"
          data-testid="incoming-call"
        >
          <div className="flex items-center gap-3">
            <span className="relative grid size-10 place-items-center rounded-full bg-[#25D366] text-white">
              <span className="absolute inset-0 animate-ping rounded-full bg-[#25D366]/40" />
              <PhoneIncoming size={18} className="relative" />
            </span>
            <div className="min-w-0">
              <div className="text-xs text-muted">
                {call.simulated
                  ? `Test customer +${call.from} is being called`
                  : `Incoming WhatsApp call${call.accountNumber ? ` · ${call.accountNumber}` : ''}`}
              </div>
              <div className="truncate font-semibold">{call.contactName ?? `+${call.from}`}</div>
              {call.contactName && !call.simulated && (
                <div className="text-xs text-muted">+{call.from}</div>
              )}
            </div>
            <span className="ml-auto text-xs text-muted tabular-nums">
              {Math.max(0, call.ringSeconds - Math.floor((Date.now() - call.receivedAt) / 1000))}s
            </span>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <button
              className="flex h-9 items-center justify-center gap-1.5 rounded-lg bg-danger text-sm font-medium text-white hover:opacity-90"
              onClick={() => void useCalls.getState().decline(call.callId)}
            >
              <PhoneOff size={15} /> Decline
            </button>
            <button
              className="flex h-9 items-center justify-center gap-1.5 rounded-lg bg-[#25D366] text-sm font-medium text-white hover:opacity-90 disabled:opacity-60"
              disabled={busy || Boolean(current)}
              onClick={() => void useCalls.getState().answer(call.callId)}
            >
              {busy ? <Spinner size={14} /> : <Phone size={15} />} Answer
            </button>
          </div>
        </div>
      ))}
      {current && (
        <div
          className="flex items-center gap-3 rounded-xl border border-line bg-panel p-3 shadow-xl"
          data-testid="current-call"
        >
          <span className="grid size-9 place-items-center rounded-full bg-success-soft text-success">
            <Phone size={16} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-xs text-muted">
              {current.kind === 'test' ? 'Test call to' : 'On call with'}
            </div>
            <div className="truncate text-[13px] font-semibold">{current.label}</div>
          </div>
          <span className="text-xs text-muted tabular-nums" data-testid="call-timer">
            {clock(Date.now() - current.startedAt)}
          </span>
          <button
            className="grid size-8 place-items-center rounded-full border border-line hover:bg-panel-2"
            title={current.muted ? 'Unmute' : 'Mute'}
            aria-label={current.muted ? 'Unmute' : 'Mute'}
            onClick={() => useCalls.getState().toggleMute()}
          >
            {current.muted ? <MicOff size={15} className="text-danger" /> : <Mic size={15} />}
          </button>
          <button
            className="grid size-8 place-items-center rounded-full bg-danger text-white hover:opacity-90"
            title="Hang up"
            aria-label="Hang up"
            onClick={() => void useCalls.getState().hangup()}
          >
            <PhoneOff size={15} />
          </button>
        </div>
      )}
    </div>
  );
}
