import { useQuery } from '@tanstack/react-query';
import { Bot, BookOpen, KeyRound, Phone, Plus } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { ProvidersModal } from '../components/agents/ProvidersModal';
import { TEMPLATES } from '../components/agents/templates';
import { Badge, Button, EmptyState, Modal, Spinner } from '../components/ui';
import { endpoints } from '../lib/api';
import { useAuth } from '../stores/auth';

export function AgentsPage() {
  const navigate = useNavigate();
  const canEdit = useAuth((s) => s.user?.role !== 'member');
  const agents = useQuery({ queryKey: ['agents'], queryFn: endpoints.agents });
  const providers = useQuery({ queryKey: ['ai', 'providers'], queryFn: endpoints.aiProviders });
  const [showProviders, setShowProviders] = useState(false);
  const [creating, setCreating] = useState(false);
  const configured = providers.data?.data.filter((p) => p.configured) ?? [];

  const create = async (template: (typeof TEMPLATES)[number]) => {
    try {
      const agent = await endpoints.createAgent({
        ...template.agent,
        engine: configured.some((p) => p.id === 'openai') ? 'realtime' : 'pipeline',
      });
      navigate(`/agents/${agent.id}`);
    } catch (error) {
      toast.error((error as Error).message);
    }
  };

  return (
    <div className="ff-scroll h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl px-4 py-8 sm:px-8">
        <div className="mb-6 flex flex-wrap items-end gap-3">
          <div>
            <h1 className="text-xl font-semibold">AI agents</h1>
            <p className="text-[13px] text-muted">
              Voice agents that answer your WhatsApp calls 24/7 - with your knowledge, in your
              customers' languages.
            </p>
          </div>
          <div className="ml-auto flex gap-2">
            <Button icon={KeyRound} onClick={() => setShowProviders(true)}>
              AI providers
              {providers.data && (
                <Badge tone={configured.length ? 'success' : 'warning'}>{configured.length}</Badge>
              )}
            </Button>
            {canEdit && (
              <Button variant="primary" icon={Plus} onClick={() => setCreating(true)}>
                New agent
              </Button>
            )}
          </div>
        </div>

        {providers.data && !configured.length && (
          <div className="mb-4 rounded-lg border border-warning/40 bg-warning-soft p-3 text-[13px]">
            Add at least one AI provider key (OpenAI for the simplest setup) so agents can talk.{' '}
            <button
              className="font-medium text-accent hover:underline"
              onClick={() => setShowProviders(true)}
            >
              Add keys
            </button>
          </div>
        )}

        {agents.isLoading ? (
          <div className="flex justify-center py-16">
            <Spinner />
          </div>
        ) : !agents.data?.data.length ? (
          <EmptyState
            icon={Bot}
            title="No agents yet"
            description="Create an agent, give it your price list and FAQs, and let it answer calls when you can't."
            action={
              canEdit && (
                <Button variant="primary" icon={Plus} onClick={() => setCreating(true)}>
                  New agent
                </Button>
              )
            }
          />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {agents.data.data.map((agent) => (
              <button
                key={agent.id}
                className="rounded-xl border border-line bg-panel p-4 text-left transition hover:border-accent/60 hover:shadow-sm"
                onClick={() => navigate(`/agents/${agent.id}`)}
                data-testid="agent-card"
              >
                <div className="flex items-center gap-3">
                  <span className="grid size-10 place-items-center rounded-full bg-accent-soft text-accent">
                    <Bot size={18} />
                  </span>
                  <div className="min-w-0">
                    <div className="truncate font-semibold">{agent.name}</div>
                    <div className="truncate text-xs text-muted">{agent.languages.join(' · ')}</div>
                  </div>
                  <Badge tone="accent" className="ml-auto">
                    {agent.engine === 'realtime' ? 'Realtime' : 'Pipeline'}
                  </Badge>
                </div>
                <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
                  <span className="flex items-center gap-1">
                    <BookOpen size={12} /> {agent.documentCount} documents
                  </span>
                  <span className="flex items-center gap-1">
                    <Phone size={12} /> {agent.callCount} calls
                  </span>
                  <span>
                    {agent.numbers.length
                      ? `Answers ${agent.numbers.map((n) => n.displayPhoneNumber).join(', ')}`
                      : 'Not on a number yet'}
                  </span>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      <Modal open={creating} onClose={() => setCreating(false)} title="New agent" width={640}>
        <p className="mb-3 text-[13px] text-muted">
          Start from a template - you can change everything afterwards.
        </p>
        <div className="grid gap-2 sm:grid-cols-2">
          {TEMPLATES.map((t) => (
            <button
              key={t.id}
              className="rounded-lg border border-line p-3 text-left hover:border-accent hover:bg-accent-soft/40"
              onClick={() => void create(t)}
            >
              <div className="text-[13px] font-medium">{t.title}</div>
              <div className="text-xs text-muted">{t.description}</div>
            </button>
          ))}
        </div>
      </Modal>
      <ProvidersModal open={showProviders} onClose={() => setShowProviders(false)} />
    </div>
  );
}
