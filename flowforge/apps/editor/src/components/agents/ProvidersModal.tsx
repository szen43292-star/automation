import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { endpoints, type AiProviderId } from '../../lib/api';
import { useAuth } from '../../stores/auth';
import { Badge, Button, Modal, Spinner } from '../ui';

/** API keys of the AI providers. Keys go to the server and are never shown again. */
export function ProvidersModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const isOwner = useAuth((s) => s.user?.role === 'owner');
  const providers = useQuery({
    queryKey: ['ai', 'providers'],
    queryFn: endpoints.aiProviders,
    enabled: open,
  });
  const [keys, setKeys] = useState<Partial<Record<AiProviderId, string | null>>>({});
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      await endpoints.saveAiProviders(keys);
      setKeys({});
      toast.success('AI providers saved');
      await queryClient.invalidateQueries({ queryKey: ['ai'] });
      await queryClient.invalidateQueries({ queryKey: ['agents'] });
      onClose();
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="AI providers"
      width={640}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {isOwner ? 'Cancel' : 'Close'}
          </Button>
          {isOwner && (
            <Button
              variant="primary"
              loading={saving}
              disabled={!Object.keys(keys).length}
              onClick={() => void save()}
            >
              Save keys
            </Button>
          )}
        </>
      }
    >
      <p className="mb-4 text-[13px] text-muted">
        Keys stay on your AutoForge server - the apps and browsers never see them. Keys built into
        your private app or set on the server are used automatically.
        {!isOwner && ' Only the owner can change keys.'}
      </p>
      {!providers.data ? (
        <div className="flex justify-center py-8">
          <Spinner />
        </div>
      ) : (
        <div className="divide-y divide-line rounded-lg border border-line">
          {providers.data.data.map((p) => (
            <div
              key={p.id}
              className="flex flex-wrap items-center gap-3 p-3"
              data-testid={`provider-${p.id}`}
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-[13px] font-medium">
                  {p.name}
                  {p.source === 'env' ? (
                    <Badge tone="success">Built in {p.hint}</Badge>
                  ) : p.configured ? (
                    <Badge tone="success">Saved {p.hint}</Badge>
                  ) : (
                    <Badge>Not set</Badge>
                  )}
                </div>
                <div className="text-xs text-muted">{p.usedFor}</div>
              </div>
              {isOwner && p.source !== 'env' && (
                <div className="flex w-full items-center gap-2 sm:w-72">
                  <input
                    className="ff-input"
                    type="password"
                    autoComplete="off"
                    aria-label={`${p.name} API key`}
                    placeholder={p.configured ? 'Replace key…' : 'Paste API key'}
                    value={keys[p.id] ?? ''}
                    onChange={(e) => setKeys({ ...keys, [p.id]: e.target.value })}
                  />
                  {p.configured && (
                    <button
                      className="text-xs text-muted hover:text-danger"
                      onClick={() => setKeys({ ...keys, [p.id]: null })}
                      title="Remove the saved key"
                    >
                      {keys[p.id] === null ? 'Removed' : 'Remove'}
                    </button>
                  )}
                  <a
                    href={p.keyUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-muted hover:text-fg"
                    title="Get a key"
                  >
                    <ExternalLink size={14} />
                  </a>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}
