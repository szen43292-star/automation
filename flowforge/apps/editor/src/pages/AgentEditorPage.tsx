import { useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import {
  ArrowLeft,
  BookOpen,
  FileText,
  KeyRound,
  Mic,
  Plus,
  Save,
  Search,
  Sparkles,
  Trash2,
  Upload,
  UserRound,
  Wrench,
} from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { ProvidersModal } from '../components/agents/ProvidersModal';
import { TestChat } from '../components/agents/TestChat';
import { GOALS, writeInstructions, type PersonaFields } from '../components/agents/templates';
import { Badge, Button, Field, Modal, Spinner, Toggle } from '../components/ui';
import { endpoints, type AgentDetail, type AgentInput, type AgentOptions } from '../lib/api';
import { useAuth } from '../stores/auth';

type Tab = 'persona' | 'voice' | 'knowledge' | 'tools' | 'after';

const TABS: Array<{ id: Tab; label: string; icon: typeof UserRound }> = [
  { id: 'persona', label: 'Persona', icon: UserRound },
  { id: 'voice', label: 'Voice & models', icon: Mic },
  { id: 'knowledge', label: 'Knowledge', icon: BookOpen },
  { id: 'tools', label: 'Tools', icon: Wrench },
  { id: 'after', label: 'After the call', icon: FileText },
];

const LANGUAGES = [
  'English',
  'Hindi',
  'Hinglish',
  'Marathi',
  'Gujarati',
  'Tamil',
  'Telugu',
  'Kannada',
  'Bengali',
  'Punjabi',
  'Urdu',
  'Malayalam',
  'Arabic',
  'Spanish',
];

const PROVIDER_NAMES: Record<string, string> = {
  openai: 'OpenAI',
  anthropic: 'Claude (Anthropic)',
  gemini: 'Gemini',
  deepgram: 'Deepgram',
  elevenlabs: 'ElevenLabs',
  sarvam: 'Sarvam AI',
  groq: 'Groq',
};

const toInput = (a: AgentDetail): AgentInput => ({
  name: a.name,
  instructions: a.instructions,
  greeting: a.greeting,
  languages: a.languages,
  engine: a.engine,
  voice: a.voice,
  tools: a.tools,
  notify: a.notify,
});

export function AgentEditorPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const canEdit = useAuth((s) => s.user?.role !== 'member');
  const agent = useQuery({ queryKey: ['agents', id], queryFn: () => endpoints.agent(id) });
  const options = useQuery({ queryKey: ['agents', 'options'], queryFn: endpoints.agentOptions });
  const [draft, setDraft] = useState<AgentInput | null>(null);
  const [tab, setTab] = useState<Tab>('persona');
  const [saving, setSaving] = useState(false);
  const [showProviders, setShowProviders] = useState(false);

  useEffect(() => {
    if (agent.data) setDraft(toInput(agent.data));
  }, [agent.data]);

  const dirty = useMemo(
    () =>
      Boolean(draft && agent.data && JSON.stringify(draft) !== JSON.stringify(toInput(agent.data))),
    [draft, agent.data],
  );

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      await endpoints.updateAgent(id, draft);
      toast.success('Agent saved');
      await queryClient.invalidateQueries({ queryKey: ['agents'] });
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!window.confirm(`Delete "${agent.data?.name}"? Numbers using it stop answering with AI.`))
      return;
    await endpoints.deleteAgent(id);
    await queryClient.invalidateQueries({ queryKey: ['agents'] });
    navigate('/agents');
  };

  if (agent.isError) return <div className="p-8 text-muted">{(agent.error as Error).message}</div>;
  if (!draft || !agent.data || !options.data)
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );

  const missing = agent.data.missingProviders ?? [];
  const set = (patch: Partial<AgentInput>) => setDraft({ ...draft, ...patch });

  return (
    <div className="ff-scroll h-full overflow-y-auto">
      <div className="mx-auto max-w-6xl px-4 py-6 sm:px-8">
        <div className="mb-5 flex flex-wrap items-center gap-3">
          <button
            className="text-muted hover:text-fg"
            onClick={() => navigate('/agents')}
            title="All agents"
          >
            <ArrowLeft size={18} />
          </button>
          <input
            className="min-w-0 flex-1 bg-transparent text-xl font-semibold outline-none"
            value={draft.name}
            aria-label="Agent name"
            onChange={(e) => set({ name: e.target.value })}
            disabled={!canEdit}
          />
          {canEdit && (
            <>
              <Button variant="ghost" icon={Trash2} onClick={() => void remove()}>
                Delete
              </Button>
              <Button
                variant="primary"
                icon={Save}
                loading={saving}
                disabled={!dirty}
                onClick={() => void save()}
              >
                Save
              </Button>
            </>
          )}
        </div>

        {missing.length > 0 && (
          <div className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-warning/40 bg-warning-soft p-3 text-[13px]">
            <KeyRound size={15} className="text-warning" />
            This agent needs {missing.map((p) => PROVIDER_NAMES[p]).join(', ')} to answer calls -
            until then calls go to voicemail.
            <button
              className="font-medium text-accent hover:underline"
              onClick={() => setShowProviders(true)}
            >
              Add keys
            </button>
          </div>
        )}

        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
          <div className="min-w-0">
            <div className="mb-4 flex gap-1 overflow-x-auto border-b border-line" role="tablist">
              {TABS.map((t) => (
                <button
                  key={t.id}
                  role="tab"
                  aria-selected={tab === t.id}
                  onClick={() => setTab(t.id)}
                  className={clsx(
                    '-mb-px flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-[13px] font-medium',
                    tab === t.id
                      ? 'border-accent text-fg'
                      : 'border-transparent text-muted hover:text-fg',
                  )}
                >
                  <t.icon size={14} /> {t.label}
                </button>
              ))}
            </div>
            <fieldset disabled={!canEdit} className="min-w-0">
              {tab === 'persona' && <PersonaTab draft={draft} set={set} />}
              {tab === 'voice' && <VoiceTab draft={draft} set={set} options={options.data} />}
              {tab === 'knowledge' && <KnowledgeTab agent={agent.data} canEdit={canEdit} />}
              {tab === 'tools' && <ToolsTab draft={draft} set={set} options={options.data} />}
              {tab === 'after' && <AfterTab draft={draft} set={set} agent={agent.data} />}
            </fieldset>
          </div>
          <div className="lg:sticky lg:top-6 lg:h-[calc(100vh-8rem)]">
            <TestChat agentId={id} greeting={agent.data.greeting} dirty={dirty} />
            <p className="mt-2 text-xs text-muted">
              To talk to it by voice: on the WhatsApp page open a test number's <b>Calls</b>, choose
              "AI voice agent", then press <b>Call</b>.
            </p>
          </div>
        </div>
      </div>
      <ProvidersModal
        open={showProviders}
        onClose={() => {
          setShowProviders(false);
          void agent.refetch();
        }}
      />
    </div>
  );
}

type TabProps = { draft: AgentInput; set: (patch: Partial<AgentInput>) => void };

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <div className="mb-6">
      <div className="mb-2">
        <div className="text-[13px] font-semibold">{title}</div>
        {hint && <div className="text-xs text-muted">{hint}</div>}
      </div>
      {children}
    </div>
  );
}

// ---- Persona --------------------------------------------------------------------------------------

function PersonaTab({ draft, set }: TabProps) {
  const [builder, setBuilder] = useState(false);
  const [fields, setFields] = useState<PersonaFields>({
    business: '',
    about: '',
    tone: 'friendly',
    goals: [GOALS[0]!, GOALS[4]!],
    extra: '',
  });
  return (
    <>
      <Section title="Greeting" hint="The first thing callers hear.">
        <input
          className="ff-input"
          value={draft.greeting}
          aria-label="Greeting"
          onChange={(e) => set({ greeting: e.target.value })}
        />
      </Section>
      <Section
        title="Languages"
        hint="The agent answers in the caller's language. Hinglish = Hindi and English mixed."
      >
        <div className="flex flex-wrap gap-1.5">
          {LANGUAGES.map((lang) => {
            const on = draft.languages.includes(lang);
            return (
              <button
                key={lang}
                type="button"
                aria-pressed={on}
                onClick={() =>
                  set({
                    languages: on
                      ? draft.languages.filter((l) => l !== lang)
                      : [...draft.languages, lang],
                  })
                }
                className={clsx(
                  'rounded-full border px-2.5 py-1 text-xs',
                  on
                    ? 'border-accent bg-accent-soft text-accent'
                    : 'border-line text-muted hover:text-fg',
                )}
              >
                {lang}
              </button>
            );
          })}
        </div>
      </Section>
      <Section
        title="Instructions"
        hint="Who the agent is, how it talks and what it should do. Facts like prices go in Knowledge."
      >
        <div className="mb-2 flex justify-end">
          <Button size="sm" icon={Sparkles} onClick={() => setBuilder(true)}>
            Persona builder
          </Button>
        </div>
        <textarea
          className="ff-input min-h-64 font-mono text-[12.5px] leading-relaxed"
          value={draft.instructions}
          aria-label="Instructions"
          onChange={(e) => set({ instructions: e.target.value })}
        />
      </Section>
      <Modal
        open={builder}
        onClose={() => setBuilder(false)}
        title="Persona builder"
        width={600}
        footer={
          <>
            <Button variant="ghost" onClick={() => setBuilder(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                set({
                  instructions: writeInstructions(fields),
                  ...(fields.business && draft.name.startsWith('New')
                    ? { name: `${fields.business} assistant` }
                    : {}),
                });
                setBuilder(false);
              }}
            >
              Write instructions
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label="Business name">
            <input
              className="ff-input"
              value={fields.business}
              onChange={(e) => setFields({ ...fields, business: e.target.value })}
              placeholder="Shine Salon"
            />
          </Field>
          <Field label="What you do" hint="One or two sentences: services, where, for whom.">
            <textarea
              className="ff-input min-h-16"
              value={fields.about}
              onChange={(e) => setFields({ ...fields, about: e.target.value })}
              placeholder="Unisex salon in Andheri West, Mumbai. Haircuts, colour, spa and bridal makeup."
            />
          </Field>
          <Field label="Tone">
            <select
              className="ff-input"
              value={fields.tone}
              onChange={(e) =>
                setFields({ ...fields, tone: e.target.value as PersonaFields['tone'] })
              }
            >
              <option value="friendly">Friendly</option>
              <option value="professional">Professional</option>
              <option value="warm">Warm and patient</option>
              <option value="energetic">Energetic</option>
            </select>
          </Field>
          <div>
            <div className="mb-1 text-[12.5px] font-medium">What should it do?</div>
            <div className="space-y-1">
              {GOALS.map((goal) => (
                <label key={goal} className="flex items-center gap-2 text-[13px]">
                  <input
                    type="checkbox"
                    checked={fields.goals.includes(goal)}
                    onChange={(e) =>
                      setFields({
                        ...fields,
                        goals: e.target.checked
                          ? [...fields.goals, goal]
                          : fields.goals.filter((g) => g !== goal),
                      })
                    }
                  />
                  {goal}
                </label>
              ))}
            </div>
          </div>
          <Field label="Anything else?" hint="Rules, offers, things to never say.">
            <textarea
              className="ff-input min-h-16"
              value={fields.extra}
              onChange={(e) => setFields({ ...fields, extra: e.target.value })}
            />
          </Field>
        </div>
      </Modal>
    </>
  );
}

// ---- Voice ----------------------------------------------------------------------------------------

function VoiceTab({ draft, set, options }: TabProps & { options: AgentOptions }) {
  const configured = new Set(options.providers.filter((p) => p.configured).map((p) => p.id));
  const voice = draft.voice;
  const setVoice = (patch: Partial<AgentInput['voice']>) => set({ voice: { ...voice, ...patch } });
  const providerLabel = (id: string) =>
    `${PROVIDER_NAMES[id]}${configured.has(id as never) ? '' : ' (no key)'}`;
  return (
    <>
      <Section title="Engine">
        <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Engine">
          {(
            [
              [
                'realtime',
                'Realtime (fastest)',
                'One speech-to-speech model listens, thinks and talks. Most natural; needs OpenAI.',
              ],
              [
                'pipeline',
                'Pipeline (mix & match)',
                'Speech-to-text → any LLM (e.g. Claude) → any voice. Best for Indian languages with Sarvam/Deepgram.',
              ],
            ] as const
          ).map(([value, title, text]) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={draft.engine === value}
              onClick={() => set({ engine: value })}
              className={clsx(
                'rounded-lg border p-3 text-left',
                draft.engine === value
                  ? 'border-accent bg-accent-soft/50 ring-1 ring-accent'
                  : 'border-line hover:bg-panel-2',
              )}
            >
              <div className="text-[13px] font-medium">{title}</div>
              <div className="text-xs text-muted">{text}</div>
            </button>
          ))}
        </div>
      </Section>

      {draft.engine === 'realtime' ? (
        <Section
          title="Realtime voice"
          hint={configured.has('openai') ? undefined : 'Needs an OpenAI key.'}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Model">
              <input
                className="ff-input"
                placeholder={options.defaultModels.realtime}
                value={voice.realtime.model}
                onChange={(e) =>
                  setVoice({ realtime: { ...voice.realtime, model: e.target.value } })
                }
              />
            </Field>
            <Field label="Voice" hint="e.g. marin, cedar, alloy, verse, shimmer">
              <input
                className="ff-input"
                placeholder={options.defaultVoices.realtime}
                value={voice.realtime.voice}
                onChange={(e) =>
                  setVoice({ realtime: { ...voice.realtime, voice: e.target.value } })
                }
              />
            </Field>
          </div>
        </Section>
      ) : (
        <>
          <Section title="Speech-to-text" hint="Turns what the caller says into text.">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Provider">
                <select
                  className="ff-input"
                  aria-label="Speech-to-text provider"
                  value={voice.stt.provider}
                  onChange={(e) =>
                    setVoice({ stt: { provider: e.target.value as never, model: '' } })
                  }
                >
                  {options.sttProviders.map((p) => (
                    <option key={p} value={p}>
                      {providerLabel(p)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Model">
                <input
                  className="ff-input"
                  placeholder={options.defaultModels.stt[voice.stt.provider]}
                  value={voice.stt.model}
                  onChange={(e) => setVoice({ stt: { ...voice.stt, model: e.target.value } })}
                />
              </Field>
            </div>
          </Section>
          <Section
            title="Language model"
            hint="The brain: understands, looks things up, decides what to say."
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Provider">
                <select
                  className="ff-input"
                  aria-label="LLM provider"
                  value={voice.llm.provider}
                  onChange={(e) =>
                    setVoice({ llm: { provider: e.target.value as never, model: '' } })
                  }
                >
                  {options.llmProviders.map((p) => (
                    <option key={p} value={p}>
                      {providerLabel(p)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Model">
                <input
                  className="ff-input"
                  placeholder={options.defaultModels.llm[voice.llm.provider]}
                  value={voice.llm.model}
                  onChange={(e) => setVoice({ llm: { ...voice.llm, model: e.target.value } })}
                />
              </Field>
            </div>
          </Section>
          <Section title="Voice" hint="Text-to-speech.">
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Provider">
                <select
                  className="ff-input"
                  aria-label="Voice provider"
                  value={voice.tts.provider}
                  onChange={(e) =>
                    setVoice({ tts: { provider: e.target.value as never, model: '', voice: '' } })
                  }
                >
                  {options.ttsProviders.map((p) => (
                    <option key={p} value={p}>
                      {providerLabel(p)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Voice">
                <input
                  className="ff-input"
                  placeholder={options.defaultVoices[voice.tts.provider]}
                  value={voice.tts.voice}
                  onChange={(e) => setVoice({ tts: { ...voice.tts, voice: e.target.value } })}
                />
              </Field>
              <Field label="Model">
                <input
                  className="ff-input"
                  placeholder={options.defaultModels.tts[voice.tts.provider]}
                  value={voice.tts.model}
                  onChange={(e) => setVoice({ tts: { ...voice.tts, model: e.target.value } })}
                />
              </Field>
            </div>
          </Section>
        </>
      )}
      <Section
        title="Main language code"
        hint="Optional, e.g. hi-IN or en-IN. Helps speech recognition and Sarvam voices; empty = detect."
      >
        <input
          className="ff-input w-40"
          value={voice.language}
          placeholder="auto"
          onChange={(e) => setVoice({ language: e.target.value })}
        />
      </Section>
    </>
  );
}

// ---- Knowledge ------------------------------------------------------------------------------------

function KnowledgeTab({ agent, canEdit }: { agent: AgentDetail; canEdit: boolean }) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<{ id?: string; title: string; content: string } | null>(
    null,
  );
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<Array<{ title: string; text: string; score: number }> | null>(
    null,
  );
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['agents', agent.id] });

  const saveDoc = async () => {
    if (!editing) return;
    try {
      if (editing.id) await endpoints.updateDocument(agent.id, editing.id, editing);
      else await endpoints.addDocument(agent.id, editing);
      setEditing(null);
      await refresh();
    } catch (error) {
      toast.error((error as Error).message);
    }
  };

  const upload = async (files: FileList) => {
    for (const file of Array.from(files)) {
      const content = await file.text();
      await endpoints
        .addDocument(agent.id, { title: file.name.replace(/\.\w+$/, ''), content })
        .catch((e: Error) => toast.error(`${file.name}: ${e.message}`));
    }
    await refresh();
  };

  return (
    <>
      <Section
        title="Documents"
        hint="Price lists, services, opening hours, FAQs, policies. The agent searches them during calls."
      >
        <div className="mb-3 flex flex-wrap gap-2">
          {canEdit && (
            <>
              <Button size="sm" icon={Plus} onClick={() => setEditing({ title: '', content: '' })}>
                Write
              </Button>
              <label className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md border border-line bg-panel px-2.5 text-xs font-medium hover:bg-panel-2">
                <Upload size={13} /> Upload .txt / .md / .csv
                <input
                  type="file"
                  multiple
                  accept=".txt,.md,.csv,.json,text/*"
                  className="hidden"
                  onChange={(e) => e.target.files && void upload(e.target.files)}
                />
              </label>
            </>
          )}
        </div>
        {agent.documents.length === 0 ? (
          <div className="rounded-lg border border-dashed border-line p-6 text-center text-[13px] text-muted">
            No documents yet. Paste your price list or FAQ to start.
          </div>
        ) : (
          <div
            className="divide-y divide-line rounded-lg border border-line"
            data-testid="documents"
          >
            {agent.documents.map((doc) => (
              <div key={doc.id} className="flex items-center gap-3 px-3 py-2">
                <FileText size={15} className="text-muted" />
                <button
                  className="min-w-0 flex-1 truncate text-left text-[13px] hover:underline"
                  onClick={async () => setEditing(await endpoints.document(agent.id, doc.id))}
                >
                  {doc.title}
                </button>
                <span className="text-xs text-muted">{doc.characters.toLocaleString()} chars</span>
                {canEdit && (
                  <button
                    className="text-muted hover:text-danger"
                    title="Delete"
                    onClick={async () => {
                      if (!window.confirm(`Delete "${doc.title}"?`)) return;
                      await endpoints.deleteDocument(agent.id, doc.id);
                      await refresh();
                    }}
                  >
                    <Trash2 size={14} />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </Section>
      <Section title="Try a search" hint="What the agent finds when a caller asks.">
        <form
          className="flex gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            if (query.trim()) setHits((await endpoints.searchKnowledge(agent.id, query)).data);
          }}
        >
          <input
            className="ff-input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="haircut price"
            aria-label="Search knowledge"
          />
          <Button icon={Search} type="submit">
            Search
          </Button>
        </form>
        {hits && (
          <div className="mt-2 space-y-2" data-testid="search-results">
            {hits.length === 0 && <div className="text-[13px] text-muted">Nothing found.</div>}
            {hits.map((hit, i) => (
              <div key={i} className="rounded-lg bg-panel-2 p-2 text-xs">
                <div className="mb-0.5 font-medium">
                  {hit.title} <span className="text-muted">· score {hit.score.toFixed(2)}</span>
                </div>
                <div className="whitespace-pre-wrap text-muted">{hit.text}</div>
              </div>
            ))}
          </div>
        )}
      </Section>
      <Modal
        open={Boolean(editing)}
        onClose={() => setEditing(null)}
        title={editing?.id ? 'Edit document' : 'New document'}
        width={720}
        footer={
          <>
            <Button variant="ghost" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            {canEdit && (
              <Button
                variant="primary"
                disabled={!editing?.title.trim() || !editing?.content.trim()}
                onClick={() => void saveDoc()}
              >
                Save document
              </Button>
            )}
          </>
        }
      >
        {editing && (
          <div className="space-y-3">
            <Field label="Title">
              <input
                className="ff-input"
                value={editing.title}
                onChange={(e) => setEditing({ ...editing, title: e.target.value })}
                placeholder="Price list"
              />
            </Field>
            <Field label="Content" hint="Plain text. Separate topics with empty lines.">
              <textarea
                className="ff-input min-h-72 font-mono text-[12.5px]"
                value={editing.content}
                onChange={(e) => setEditing({ ...editing, content: e.target.value })}
              />
            </Field>
          </div>
        )}
      </Modal>
    </>
  );
}

// ---- Tools ----------------------------------------------------------------------------------------

function ToolsTab({ draft, set, options }: TabProps & { options: AgentOptions }) {
  const tools = draft.tools;
  const setTools = (patch: Partial<AgentInput['tools']>) => set({ tools: { ...tools, ...patch } });
  const builtIn: Array<[keyof AgentInput['tools'], string, string]> = [
    ['knowledge', 'Search knowledge', 'Looks up your documents before answering facts.'],
    ['transfer', 'Transfer to a person', 'Rings everyone in the app; whoever answers takes over.'],
    ['endCall', 'End the call', 'Says goodbye and hangs up when the conversation is done.'],
    [
      'whatsappMessage',
      'Send a WhatsApp message',
      'Sends links, addresses or confirmations to the caller.',
    ],
  ];
  return (
    <>
      <Section title="Built-in tools">
        <div className="divide-y divide-line rounded-lg border border-line">
          {builtIn.map(([key, title, text]) => (
            <div key={key} className="flex items-center gap-3 px-3 py-2.5">
              <div className="flex-1">
                <div className="text-[13px] font-medium">{title}</div>
                <div className="text-xs text-muted">{text}</div>
              </div>
              <Toggle
                checked={tools[key] as boolean}
                label={title}
                onChange={(value) => setTools({ [key]: value })}
              />
            </div>
          ))}
        </div>
      </Section>
      <Section
        title="Workflows as tools"
        hint='Let the agent run your workflows - book in a calendar, check an order, create a lead. The workflow must start with "Execute Workflow Trigger"; the agent gets the last node’s output.'
      >
        <div className="space-y-3">
          {tools.workflows.map((tool, i) => {
            const update = (patch: Partial<(typeof tools.workflows)[number]>) => {
              const workflows = [...tools.workflows];
              workflows[i] = { ...tool, ...patch };
              setTools({ workflows });
            };
            return (
              <div
                key={i}
                className="rounded-lg border border-line p-3"
                data-testid="workflow-tool"
              >
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Workflow">
                    <select
                      className="ff-input"
                      value={tool.workflowId}
                      onChange={(e) => update({ workflowId: e.target.value })}
                    >
                      <option value="">Choose…</option>
                      {options.workflows.map((w) => (
                        <option key={w.id} value={w.id}>
                          {w.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Tool name" hint="lowercase_with_underscores">
                    <input
                      className="ff-input font-mono"
                      value={tool.name}
                      onChange={(e) =>
                        update({ name: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_') })
                      }
                      placeholder="book_appointment"
                    />
                  </Field>
                </div>
                <div className="mt-3">
                  <Field label="When should the agent use it?">
                    <input
                      className="ff-input"
                      value={tool.description}
                      onChange={(e) => update({ description: e.target.value })}
                      placeholder="Book an appointment once the caller has chosen a service, day and time."
                    />
                  </Field>
                </div>
                <div className="mt-3">
                  <div className="mb-1 text-[12.5px] font-medium">Details the agent collects</div>
                  {tool.parameters.map((p, j) => (
                    <div key={j} className="mb-1.5 flex gap-2">
                      <input
                        className="ff-input w-40 font-mono"
                        value={p.name}
                        placeholder="day"
                        onChange={(e) => {
                          const parameters = [...tool.parameters];
                          parameters[j] = {
                            ...p,
                            name: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_'),
                          };
                          update({ parameters });
                        }}
                      />
                      <input
                        className="ff-input"
                        value={p.description}
                        placeholder="Day of the appointment, e.g. 2026-10-12"
                        onChange={(e) => {
                          const parameters = [...tool.parameters];
                          parameters[j] = { ...p, description: e.target.value };
                          update({ parameters });
                        }}
                      />
                      <button
                        type="button"
                        className="text-muted hover:text-danger"
                        title="Remove"
                        onClick={() =>
                          update({ parameters: tool.parameters.filter((_, k) => k !== j) })
                        }
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  ))}
                  <button
                    type="button"
                    className="flex items-center gap-1 text-xs text-accent hover:underline"
                    onClick={() =>
                      update({ parameters: [...tool.parameters, { name: '', description: '' }] })
                    }
                  >
                    <Plus size={12} /> Add detail
                  </button>
                </div>
                <div className="mt-2 text-right">
                  <button
                    type="button"
                    className="text-xs text-muted hover:text-danger"
                    onClick={() =>
                      setTools({ workflows: tools.workflows.filter((_, k) => k !== i) })
                    }
                  >
                    Remove tool
                  </button>
                </div>
              </div>
            );
          })}
          <Button
            size="sm"
            icon={Plus}
            disabled={!options.workflows.length}
            onClick={() =>
              setTools({
                workflows: [
                  ...tools.workflows,
                  {
                    workflowId: options.workflows[0]?.id ?? '',
                    name: '',
                    description: '',
                    parameters: [],
                  },
                ],
              })
            }
          >
            Add workflow tool
          </Button>
          {!options.workflows.length && (
            <div className="text-xs text-muted">
              No workflow starts with "Execute Workflow Trigger" yet - create one first.
            </div>
          )}
        </div>
      </Section>
    </>
  );
}

// ---- After the call -------------------------------------------------------------------------------

function AfterTab({ draft, set, agent }: TabProps & { agent: AgentDetail }) {
  const notify = draft.notify;
  return (
    <>
      <Section title="Call summary">
        <div className="flex items-center gap-3 rounded-lg border border-line p-3">
          <div className="flex-1">
            <div className="text-[13px] font-medium">Write a summary of every call</div>
            <div className="text-xs text-muted">
              Shown in the call log and passed to "call ended" workflows (WhatsApp Trigger) - e.g.
              to add a lead to a sheet or send a follow-up template.
            </div>
          </div>
          <Toggle
            checked={notify.summary}
            label="Write a summary"
            onChange={(summary) => set({ notify: { ...notify, summary } })}
          />
        </div>
      </Section>
      <Section
        title="Send me each summary on WhatsApp"
        hint="Your own number with country code. WhatsApp only delivers if you messaged the business number in the last 24 hours - for guaranteed delivery use a workflow with a template."
      >
        <input
          className="ff-input w-64"
          placeholder="+91 98765 43210"
          value={notify.whatsappTo}
          onChange={(e) => set({ notify: { ...notify, whatsappTo: e.target.value } })}
        />
      </Section>
      <Section
        title="Numbers"
        hint='Set a number to "AI voice agent" in its call settings on the WhatsApp page.'
      >
        {agent.numbers.length ? (
          <div className="flex flex-wrap gap-2">
            {agent.numbers.map((n) => (
              <Badge key={n.id} tone="accent">
                {n.displayPhoneNumber}
              </Badge>
            ))}
          </div>
        ) : (
          <div className="text-[13px] text-muted">Not answering any number yet.</div>
        )}
      </Section>
    </>
  );
}
