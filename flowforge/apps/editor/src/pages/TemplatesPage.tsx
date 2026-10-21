import { useQuery } from '@tanstack/react-query';
import { LayoutTemplate } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Badge, Button, NodeIcon, Spinner } from '../components/ui';
import { endpoints } from '../lib/api';

export function TemplatesPage() {
  const navigate = useNavigate();
  const templates = useQuery({ queryKey: ['templates'], queryFn: endpoints.templates });
  const nodeTypes = useQuery({ queryKey: ['node-types'], queryFn: endpoints.nodeTypes });
  const [category, setCategory] = useState('');
  const [using, setUsing] = useState<string | null>(null);
  const icons = new Map((nodeTypes.data?.data ?? []).map((n) => [n.name, n]));
  const categories = [...new Set((templates.data?.data ?? []).map((t) => t.category))];

  const use = async (id: string) => {
    setUsing(id);
    try {
      const created = await endpoints.useTemplate(id);
      const missing = created.missingCredentials ?? [];
      toast.success(`Created "${created.name}"`, {
        description: [
          missing.length ? `Connect: ${missing.join(', ')}.` : '',
          `Next: ${created.setup.join(' → ')}`,
        ]
          .filter(Boolean)
          .join(' '),
        duration: 15_000,
      });
      navigate(`/workflow/${created.id}`);
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setUsing(null);
    }
  };

  return (
    <div className="ff-scroll h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl px-4 py-8 sm:px-8">
        <div className="mb-6">
          <h1 className="text-xl font-semibold">Templates</h1>
          <p className="text-[13px] text-muted">
            Ready-made workflows - use one and fill in your number.
          </p>
        </div>
        <div className="mb-4 flex flex-wrap gap-1.5">
          {['', ...categories].map((c) => (
            <button
              key={c || 'all'}
              onClick={() => setCategory(c)}
              aria-pressed={category === c}
              className={
                category === c
                  ? 'rounded-full border border-accent bg-accent-soft px-3 py-1 text-xs text-accent'
                  : 'rounded-full border border-line px-3 py-1 text-xs text-muted hover:text-fg'
              }
            >
              {c || 'All'}
            </button>
          ))}
        </div>
        {!templates.data ? (
          <div className="flex justify-center py-16">
            <Spinner />
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2" data-testid="templates">
            {templates.data.data
              .filter((t) => !category || t.category === category)
              .map((t) => (
                <div
                  key={t.id}
                  className="flex flex-col rounded-xl border border-line bg-panel p-4"
                  data-testid="template"
                >
                  <div className="mb-2 flex items-center gap-1.5">
                    {t.nodeTypes.map((type) => {
                      const node = icons.get(type);
                      return (
                        <span
                          key={type}
                          className="grid size-7 place-items-center rounded-md bg-panel-2"
                          title={node?.displayName ?? type}
                        >
                          <NodeIcon icon={node?.icon} color={node?.defaults.color} size={15} />
                        </span>
                      );
                    })}
                    <Badge className="ml-auto">{t.category}</Badge>
                  </div>
                  <div className="font-semibold">{t.name}</div>
                  <p className="mt-1 flex-1 text-[13px] text-muted">{t.description}</p>
                  <div className="mt-3 flex justify-end">
                    <Button
                      size="sm"
                      variant="primary"
                      icon={LayoutTemplate}
                      loading={using === t.id}
                      onClick={() => void use(t.id)}
                    >
                      Use template
                    </Button>
                  </div>
                </div>
              ))}
          </div>
        )}
      </div>
    </div>
  );
}
