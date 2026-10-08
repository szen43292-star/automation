import { useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { Bot, Phone, PhoneOff, Plus, Trash2, Upload, Voicemail } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  endpoints,
  type CallFallback,
  type CallMode,
  type CallSettings,
  type WhatsAppAccount,
} from '../../lib/api';
import { Badge, Button, Field, Modal, Spinner, Toggle } from '../ui';

const MODES: Array<{ value: CallMode; title: string; text: string; icon: typeof Phone }> = [
  {
    value: 'app',
    title: 'Ring in FlowForge',
    text: 'Answer from this app on your PC or phone.',
    icon: Phone,
  },
  {
    value: 'ai',
    title: 'AI voice agent',
    text: 'Answers every call, 24/7, in your languages.',
    icon: Bot,
  },
  {
    value: 'voicemail',
    title: 'Voicemail',
    text: 'Plays your greeting and records a message.',
    icon: Voicemail,
  },
  {
    value: 'reject',
    title: 'Decline',
    text: 'Declines and sends your WhatsApp message.',
    icon: PhoneOff,
  },
];

const FALLBACKS: Array<{ value: CallFallback; label: string }> = [
  { value: 'voicemail', label: 'Voicemail' },
  { value: 'ai', label: 'AI voice agent' },
  { value: 'reject', label: 'Decline and send message' },
];

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const readFileBase64 = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(new Error('Could not read the file'));
    reader.readAsDataURL(file);
  });

export function CallSettingsModal({
  account,
  open,
  onClose,
}: {
  account: WhatsAppAccount;
  open: boolean;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ['whatsapp', 'calling', account.id],
    queryFn: () => endpoints.callSettings(account.id),
    enabled: open,
  });
  const agents = useQuery({ queryKey: ['agents'], queryFn: endpoints.agents, enabled: open });
  const [draft, setDraft] = useState<CallSettings | null>(null);
  const [agentId, setAgentId] = useState<string | null>(account.agentId);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (open && query.data) setDraft(query.data.settings);
  }, [open, query.data]);
  useEffect(() => {
    if (open) setAgentId(account.agentId);
  }, [open, account.agentId]);
  const zones = useMemo(() => {
    try {
      return (Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf(
        'timeZone',
      );
    } catch {
      return [];
    }
  }, []);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['whatsapp'] });

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      await endpoints.saveCallSettings(account.id, draft);
      if (agentId !== account.agentId) await endpoints.setNumberAgent(account.id, agentId);
      if (!query.data?.callingEnabled) await endpoints.enableCalling(account.id);
      toast.success('Call settings saved');
      await refresh();
      onClose();
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const uploadGreeting = async (file: File) => {
    try {
      await endpoints.setGreeting(account.id, await readFileBase64(file));
      toast.success('Greeting uploaded');
      await query.refetch();
    } catch (error) {
      toast.error((error as Error).message);
    }
  };

  const hours = draft?.businessHours;
  const usesAi =
    draft &&
    (draft.mode === 'ai' ||
      (draft.mode === 'app' && draft.fallback === 'ai') ||
      (draft.businessHours.enabled && draft.businessHours.outsideMode === 'ai'));

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Calls to ${account.displayPhoneNumber}`}
      width={720}
      footer={
        <>
          {query.data && !query.data.callingEnabled && (
            <span className="mr-auto text-xs text-muted">
              Saving also switches calling on for this number.
            </span>
          )}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={saving} disabled={!draft} onClick={() => void save()}>
            Save
          </Button>
        </>
      }
    >
      {!draft || !hours ? (
        <div className="flex justify-center py-10">
          <Spinner />
        </div>
      ) : (
        <div className="space-y-6">
          <div>
            <div className="mb-2 flex items-center gap-2 text-[13px] font-medium">
              When someone calls
              {query.data?.callingEnabled ? (
                <Badge tone="success">Calling on</Badge>
              ) : (
                <Badge>Calling off</Badge>
              )}
            </div>
            <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Call mode">
              {MODES.map((mode) => (
                <button
                  key={mode.value}
                  role="radio"
                  aria-checked={draft.mode === mode.value}
                  onClick={() => setDraft({ ...draft, mode: mode.value })}
                  className={clsx(
                    'flex items-start gap-3 rounded-lg border p-3 text-left transition',
                    draft.mode === mode.value
                      ? 'border-accent bg-accent-soft/50 ring-1 ring-accent'
                      : 'border-line hover:bg-panel-2',
                  )}
                >
                  <mode.icon
                    size={18}
                    className={draft.mode === mode.value ? 'text-accent' : 'text-muted'}
                  />
                  <div>
                    <div className="text-[13px] font-medium">
                      {mode.title}
                      {mode.value === 'ai' && !query.data?.aiAvailable && (
                        <span className="ml-1.5 text-xs text-warning">(set up AI first)</span>
                      )}
                    </div>
                    <div className="text-xs text-muted">{mode.text}</div>
                  </div>
                </button>
              ))}
            </div>
          </div>

          {usesAi && (
            <div className="rounded-lg border border-line p-3" data-testid="agent-picker">
              <Field
                label="AI agent for this number"
                hint={
                  agents.data?.data.length
                    ? query.data?.aiAvailable === false
                      ? 'The agent needs AI provider keys - until then calls go to voicemail.'
                      : undefined
                    : 'Create an agent on the "AI agents" page first.'
                }
              >
                <select
                  className="ff-input"
                  value={agentId ?? ''}
                  onChange={(e) => setAgentId(e.target.value || null)}
                  aria-label="AI agent"
                >
                  <option value="">
                    {agents.data?.data.length === 1
                      ? `${agents.data.data[0]!.name} (only agent)`
                      : 'Choose an agent…'}
                  </option>
                  {agents.data?.data.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
          )}

          {draft.mode === 'app' && (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label="Ring for (seconds)"
                hint="Everyone signed in sees the call and can answer."
              >
                <input
                  className="ff-input"
                  type="number"
                  min={5}
                  max={60}
                  value={draft.ringSeconds}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      ringSeconds: Math.min(60, Math.max(5, Number(e.target.value) || 20)),
                    })
                  }
                />
              </Field>
              <Field label="If nobody answers">
                <select
                  className="ff-input"
                  value={draft.fallback}
                  onChange={(e) => setDraft({ ...draft, fallback: e.target.value as CallFallback })}
                >
                  {FALLBACKS.map((f) => (
                    <option key={f.value} value={f.value}>
                      {f.label}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
          )}

          <div className="rounded-lg border border-line p-3">
            <div className="flex items-center gap-3">
              <div className="flex-1">
                <div className="text-[13px] font-medium">Business hours</div>
                <div className="text-xs text-muted">
                  Outside these hours calls go to the option below.
                </div>
              </div>
              <Toggle
                checked={hours.enabled}
                onChange={(enabled) => setDraft({ ...draft, businessHours: { ...hours, enabled } })}
                label="Use business hours"
              />
            </div>
            {hours.enabled && (
              <div className="mt-3 space-y-3">
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Timezone">
                    <input
                      className="ff-input"
                      list="ff-call-zones"
                      value={hours.timezone}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          businessHours: { ...hours, timezone: e.target.value },
                        })
                      }
                    />
                    <datalist id="ff-call-zones">
                      {zones.map((z) => (
                        <option key={z} value={z} />
                      ))}
                    </datalist>
                  </Field>
                  <Field label="Outside hours">
                    <select
                      className="ff-input"
                      value={hours.outsideMode}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          businessHours: { ...hours, outsideMode: e.target.value as CallFallback },
                        })
                      }
                    >
                      {FALLBACKS.map((f) => (
                        <option key={f.value} value={f.value}>
                          {f.label}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>
                <div className="space-y-1.5">
                  {hours.days.map((d, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <select
                        className="ff-input w-24"
                        value={d.day}
                        aria-label="Day"
                        onChange={(e) => {
                          const days = [...hours.days];
                          days[i] = { ...d, day: Number(e.target.value) };
                          setDraft({ ...draft, businessHours: { ...hours, days } });
                        }}
                      >
                        {DAYS.map((name, value) => (
                          <option key={name} value={value}>
                            {name}
                          </option>
                        ))}
                      </select>
                      {(['open', 'close'] as const).map((key) => (
                        <input
                          key={key}
                          type="time"
                          className="ff-input w-32"
                          value={d[key]}
                          aria-label={key === 'open' ? 'Opens' : 'Closes'}
                          onChange={(e) => {
                            const days = [...hours.days];
                            days[i] = { ...d, [key]: e.target.value };
                            setDraft({ ...draft, businessHours: { ...hours, days } });
                          }}
                        />
                      ))}
                      <button
                        className="text-muted hover:text-danger"
                        title="Remove"
                        onClick={() =>
                          setDraft({
                            ...draft,
                            businessHours: { ...hours, days: hours.days.filter((_, j) => j !== i) },
                          })
                        }
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  ))}
                  <button
                    className="flex items-center gap-1 text-xs text-accent hover:underline"
                    onClick={() =>
                      setDraft({
                        ...draft,
                        businessHours: {
                          ...hours,
                          days: [...hours.days, { day: 6, open: '10:00', close: '14:00' }],
                        },
                      })
                    }
                  >
                    <Plus size={12} /> Add hours
                  </button>
                </div>
              </div>
            )}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Voicemail greeting (WAV)"
              hint={
                query.data?.hasGreetingAudio
                  ? 'Your greeting is set. Upload another to replace it.'
                  : 'Without one, callers hear a beep.'
              }
            >
              <div className="flex gap-2">
                <label className="inline-flex h-8.5 cursor-pointer items-center gap-1.5 rounded-md border border-line bg-panel px-3 text-[13px] font-medium hover:bg-panel-2">
                  <Upload size={14} /> {query.data?.hasGreetingAudio ? 'Replace' : 'Upload'}
                  <input
                    type="file"
                    accept="audio/wav,.wav"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) void uploadGreeting(file);
                      e.target.value = '';
                    }}
                  />
                </label>
                {query.data?.hasGreetingAudio && (
                  <Button
                    variant="ghost"
                    icon={Trash2}
                    onClick={async () => {
                      await endpoints.setGreeting(account.id, null);
                      await query.refetch();
                    }}
                  >
                    Remove
                  </Button>
                )}
              </div>
            </Field>
            <Field label="Longest voicemail (seconds)">
              <input
                className="ff-input"
                type="number"
                min={15}
                max={600}
                value={draft.voicemailMaxSeconds}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    voicemailMaxSeconds: Math.min(600, Math.max(15, Number(e.target.value) || 120)),
                  })
                }
              />
            </Field>
          </div>
          <Field
            label="Message after a declined or missed call"
            hint="Sent on WhatsApp. Leave empty to send nothing."
          >
            <textarea
              className="ff-input min-h-16"
              value={draft.rejectMessage}
              onChange={(e) => setDraft({ ...draft, rejectMessage: e.target.value })}
            />
          </Field>
          <div className="flex items-center gap-3">
            <Toggle
              checked={draft.record}
              onChange={(record) => setDraft({ ...draft, record })}
              label="Record calls"
            />
            <span className="text-[13px]">Record calls</span>
            <span className="text-xs text-muted">
              - tell callers if the law where you work requires it.
            </span>
          </div>
        </div>
      )}
    </Modal>
  );
}
