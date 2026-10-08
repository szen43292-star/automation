import { useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, MoreHorizontal, Pencil, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { endpoints } from '../lib/api';
import { timeAgo } from '../lib/format';
import { useCredentialTypes } from '../stores/credentialTypes';
import { CredentialModal } from '../components/credentials/CredentialModal';
import { Button, EmptyState, IconButton, Menu, Spinner } from '../components/ui';

export function CredentialsPage() {
  const queryClient = useQueryClient();
  const types = useCredentialTypes();
  const query = useQuery({
    queryKey: ['credentials', 'all'],
    queryFn: () => endpoints.credentials(),
  });
  const [modal, setModal] = useState<{ id?: string } | null>(null);
  useEffect(() => void types.load(), []); // eslint-disable-line react-hooks/exhaustive-deps

  const remove = async (id: string, name: string) => {
    if (!window.confirm(`Delete credential "${name}"? Nodes using it will stop working.`)) return;
    await endpoints.deleteCredential(id);
    toast.success('Credential deleted');
    void queryClient.invalidateQueries({ queryKey: ['credentials'] });
  };

  return (
    <div className="ff-scroll h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl px-4 py-8 sm:px-8">
        <div className="mb-6 flex flex-wrap items-center gap-3">
          <div>
            <h1 className="text-xl font-semibold">Credentials</h1>
            <p className="text-[13px] text-muted">
              API keys, logins and OAuth connections, encrypted on the server.
            </p>
          </div>
          <Button className="ml-auto" variant="primary" icon={Plus} onClick={() => setModal({})}>
            Add credential
          </Button>
        </div>
        {query.isLoading ? (
          <div className="flex justify-center py-16">
            <Spinner />
          </div>
        ) : !query.data?.data.length ? (
          <EmptyState
            icon={KeyRound}
            title="No credentials yet"
            description="Credentials let nodes call APIs on your behalf. Secrets never leave the server unencrypted."
            action={
              <Button variant="primary" icon={Plus} onClick={() => setModal({})}>
                Add credential
              </Button>
            }
          />
        ) : (
          <div className="overflow-hidden rounded-xl border border-line bg-panel">
            {query.data.data.map((c) => (
              <div
                key={c.id}
                className="flex items-center gap-4 border-b border-line px-4 py-3 last:border-b-0 hover:bg-panel-2"
              >
                <KeyRound size={16} className="text-muted" />
                <button className="min-w-0 flex-1 text-left" onClick={() => setModal({ id: c.id })}>
                  <div className="truncate font-medium">{c.name}</div>
                  <div className="text-xs text-muted">
                    {types.byName[c.type]?.displayName ?? c.type} · updated {timeAgo(c.updatedAt)}
                    {c.owner ? ` · ${c.owner.name}` : ''}
                  </div>
                </button>
                <Menu
                  trigger={<IconButton icon={MoreHorizontal} label="More" />}
                  items={[
                    { label: 'Edit', icon: Pencil, onClick: () => setModal({ id: c.id }) },
                    {
                      label: 'Delete',
                      icon: Trash2,
                      danger: true,
                      onClick: () => void remove(c.id, c.name),
                    },
                  ]}
                />
              </div>
            ))}
          </div>
        )}
      </div>
      <CredentialModal
        open={modal !== null}
        onClose={() => setModal(null)}
        credentialId={modal?.id}
      />
    </div>
  );
}
