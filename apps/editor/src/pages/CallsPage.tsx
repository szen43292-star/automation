import { useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import {
  Bot,
  Download,
  Phone,
  PhoneIncoming,
  PhoneMissed,
  PhoneOff,
  PhoneOutgoing,
  Play,
  Trash2,
  User,
  Voicemail,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { apiBlob, endpoints, type CallDTO } from '../lib/api';
import { formatDateTime, timeAgo } from '../lib/format';
import { push } from '../lib/push';
import { useAuth } from '../stores/auth';
import { Badge, EmptyState, IconButton, Spinner } from '../components/ui';

const STATUS: Record<
  CallDTO['status'],
  { label: string; tone: 'success' | 'danger' | 'warning' | 'neutral' | 'accent' }
> = {
  ringing: { label: 'Ringing', tone: 'accent' },
  answered: { label: 'In progress', tone: 'success' },
  ended: { label: 'Answered', tone: 'success' },
  missed: { label: 'Missed', tone: 'danger' },
  rejected: { label: 'Declined', tone: 'warning' },
  failed: { label: 'Failed', tone: 'danger' },
};

const HANDLED: Record<string, { label: string; icon: typeof User }> = {
  person: { label: 'Answered in the app', icon: User },
  voicemail: { label: 'Voicemail', icon: Voicemail },
  ai: { label: 'AI agent', icon: Bot },
  'ai+person': { label: 'AI, then a person', icon: Bot },
  rejected: { label: 'Declined automatically', icon: PhoneOff },
};

const duration = (s: number | null) =>
  s == null ? '-' : s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;

export function CallsPage() {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState('');
  const [accountId, setAccountId] = useState('');
  const accounts = useQuery({
    queryKey: ['whatsapp', 'accounts'],
    queryFn: endpoints.whatsappAccounts,
  });
  const calls = useQuery({
    queryKey: ['calls', status, accountId],
    queryFn: () =>
      endpoints.calls({
        status: status || undefined,
        accountId: accountId || undefined,
        limit: 100,
      }),
  });

  useEffect(() => {
    const unsubscribe = push.subscribe('whatsapp');
    const off = push.on((message) => {
      if (message.type === 'callUpdated')
        void queryClient.invalidateQueries({ queryKey: ['calls'] });
    });
    return () => {
      off();
      unsubscribe();
    };
  }, [queryClient]);

  const numbers = new Map((accounts.data?.data ?? []).map((a) => [a.id, a]));

  return (
    <div className="ff-scroll h-full overflow-y-auto">
      <div className="mx-auto max-w-6xl px-4 py-8 sm:px-8">
        <div className="mb-6 flex flex-wrap items-end gap-3">
          <div>
            <h1 className="text-xl font-semibold">Calls</h1>
            <p className="text-[13px] text-muted">
              Every WhatsApp call, how it was handled, recordings and transcripts.
            </p>
          </div>
          <div className="ml-auto flex gap-2">
            <select
              className="ff-input w-48"
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
              aria-label="Number"
            >
              <option value="">All numbers</option>
              {(accounts.data?.data ?? []).map((a) => (
                <option key={a.id} value={a.id}>
                  {a.displayPhoneNumber}
                </option>
              ))}
            </select>
            <select
              className="ff-input w-40"
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              aria-label="Status"
            >
              <option value="">All calls</option>
              <option value="ended">Answered</option>
              <option value="missed,rejected">Missed & declined</option>
              <option value="ringing,answered">Live</option>
              <option value="failed">Failed</option>
            </select>
          </div>
        </div>
        {calls.isLoading ? (
          <div className="flex justify-center py-16">
            <Spinner />
          </div>
        ) : !calls.data?.data.length ? (
          <EmptyState
            icon={Phone}
            title="No calls yet"
            description="Calls to your WhatsApp numbers show up here. Try it: open a test number on the WhatsApp page and press Call."
          />
        ) : (
          <div
            className="overflow-hidden rounded-xl border border-line bg-panel"
            data-testid="call-log"
          >
            {calls.data.data.map((call) => (
              <CallRow
                key={call.id}
                call={call}
                number={numbers.get(call.accountId)?.displayPhoneNumber}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function CallRow({ call, number }: { call: CallDTO; number?: string }) {
  const queryClient = useQueryClient();
  const canManage = useAuth((s) => s.user?.role !== 'member');
  const [open, setOpen] = useState(false);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const status = STATUS[call.status];
  const handled = call.handledBy ? HANDLED[call.handledBy] : undefined;
  const DirectionIcon =
    call.status === 'missed'
      ? PhoneMissed
      : call.direction === 'outbound'
        ? PhoneOutgoing
        : PhoneIncoming;

  useEffect(() => () => void (audioUrl && URL.revokeObjectURL(audioUrl)), [audioUrl]);

  const loadRecording = async () => {
    setLoading(true);
    try {
      setAudioUrl(URL.createObjectURL(await apiBlob(`/api/calls/${call.id}/recording`)));
      setOpen(true);
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="border-b border-line last:border-b-0"
      data-testid="call-row"
      data-status={call.status}
    >
      <div className="flex items-center gap-4 px-4 py-3">
        <DirectionIcon
          size={17}
          className={clsx(
            call.status === 'missed' || call.status === 'failed' ? 'text-danger' : 'text-muted',
          )}
        />
        <button className="min-w-0 flex-1 text-left" onClick={() => setOpen(!open)}>
          <div className="flex items-center gap-2">
            <span className="truncate font-medium">{call.contactName ?? `+${call.contact}`}</span>
            <Badge tone={status.tone}>{status.label}</Badge>
          </div>
          <div className="truncate text-xs text-muted">
            +{call.contact}
            {number ? ` → ${number}` : ''} ·{' '}
            <span title={formatDateTime(call.startedAt)}>{timeAgo(call.startedAt)}</span>
            {handled && ` · ${handled.label}`}
            {call.answeredBy && ` (${call.answeredBy.name})`}
          </div>
        </button>
        <span className="w-16 text-right text-[13px] text-muted tabular-nums">
          {duration(call.durationSeconds)}
        </span>
        <div className="flex w-20 justify-end gap-1">
          {call.hasRecording &&
            (loading ? (
              <Spinner size={14} />
            ) : (
              <IconButton icon={Play} label="Play recording" onClick={() => void loadRecording()} />
            ))}
        </div>
      </div>
      {open && (
        <div className="space-y-3 bg-panel-2/40 px-4 py-3 pl-12 text-[13px]">
          {call.endReason && <div className="text-muted">{call.endReason}</div>}
          {audioUrl && (
            <div className="flex items-center gap-2">
              <audio
                src={audioUrl}
                controls
                autoPlay
                className="h-9 w-full max-w-md"
                data-testid="recording-player"
              />
              <a
                href={audioUrl}
                download={`call-${call.id}.wav`}
                className="text-muted hover:text-fg"
                title="Download"
              >
                <Download size={16} />
              </a>
              {canManage && (
                <IconButton
                  icon={Trash2}
                  label="Delete recording"
                  onClick={async () => {
                    if (!window.confirm('Delete this recording?')) return;
                    await endpoints.deleteRecording(call.id);
                    setAudioUrl(null);
                    void queryClient.invalidateQueries({ queryKey: ['calls'] });
                  }}
                />
              )}
            </div>
          )}
          {call.summary && <p>{call.summary}</p>}
          {call.transcript?.length ? (
            <div className="space-y-1.5">
              {call.transcript.map((line, i) => (
                <div key={i} className="flex gap-2">
                  <span
                    className={clsx(
                      'w-14 shrink-0 text-xs font-medium',
                      line.role === 'agent' ? 'text-accent' : 'text-muted',
                    )}
                  >
                    {line.role === 'agent' ? 'Agent' : 'Caller'}
                  </span>
                  <span>{line.text}</span>
                </div>
              ))}
            </div>
          ) : (
            !call.hasRecording && (
              <div className="text-muted">No recording or transcript for this call.</div>
            )
          )}
        </div>
      )}
    </div>
  );
}
