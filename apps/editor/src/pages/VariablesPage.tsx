import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Braces, Check, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { endpoints, type Variable } from '../lib/api';
import { useAuth } from '../stores/auth';
import { useServer } from '../stores/server';
import { Button, EmptyState, IconButton, Spinner } from '../components/ui';

export function VariablesPage() {
  const queryClient = useQueryClient();
  const canEdit = useAuth((s) => s.user?.role !== 'member');
  const query = useQuery({ queryKey: ['variables'], queryFn: endpoints.variables });
  const [draft, setDraft] = useState({ key: '', value: '' });

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['variables'] });
    await useServer.getState().reloadVars();
  };

  const add = async () => {
    try {
      await endpoints.createVariable(draft);
      setDraft({ key: '', value: '' });
      await refresh();
    } catch (error) {
      toast.error((error as Error).message);
    }
  };

  return (
    <div className="ff-scroll h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl px-4 py-8 sm:px-8">
        <div className="mb-6">
          <h1 className="text-xl font-semibold">Variables</h1>
          <p className="text-[13px] text-muted">
            Values shared by all workflows, used in expressions as{' '}
            <code className="font-mono">{'{{ $vars.KEY }}'}</code>. Not encrypted - use credentials
            for secrets.
          </p>
        </div>
        {canEdit && (
          <div className="mb-4 flex gap-2">
            <input
              className="ff-input w-56 font-mono"
              placeholder="KEY"
              value={draft.key}
              onChange={(e) => setDraft({ ...draft, key: e.target.value })}
            />
            <input
              className="ff-input"
              placeholder="value"
              value={draft.value}
              onChange={(e) => setDraft({ ...draft, value: e.target.value })}
            />
            <Button variant="primary" icon={Plus} disabled={!draft.key} onClick={() => void add()}>
              Add
            </Button>
          </div>
        )}
        {query.isLoading ? (
          <div className="flex justify-center py-16">
            <Spinner />
          </div>
        ) : !query.data?.data.length ? (
          <EmptyState
            icon={Braces}
            title="No variables yet"
            description="For example BUSINESS_NAME or SUPPORT_PHONE."
          />
        ) : (
          <div className="overflow-hidden rounded-xl border border-line bg-panel">
            {query.data.data.map((v) => (
              <VariableRow key={v.id} variable={v} canEdit={canEdit} onChanged={refresh} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function VariableRow({
  variable,
  canEdit,
  onChanged,
}: {
  variable: Variable;
  canEdit: boolean;
  onChanged: () => Promise<void>;
}) {
  const [value, setValue] = useState(variable.value);
  const changed = value !== variable.value;
  return (
    <div className="flex items-center gap-3 border-b border-line px-4 py-2 last:border-b-0">
      <code className="w-56 shrink-0 truncate font-mono text-[13px] font-medium">
        {variable.key}
      </code>
      <input
        className="ff-input"
        value={value}
        disabled={!canEdit}
        onChange={(e) => setValue(e.target.value)}
      />
      {canEdit && changed && (
        <IconButton
          icon={Check}
          label="Save"
          onClick={async () => {
            await endpoints.updateVariable(variable.id, { value });
            toast.success('Saved');
            await onChanged();
          }}
        />
      )}
      {canEdit && (
        <IconButton
          icon={Trash2}
          label="Delete"
          onClick={async () => {
            if (!window.confirm(`Delete $vars.${variable.key}?`)) return;
            await endpoints.deleteVariable(variable.id);
            await onChanged();
          }}
        />
      )}
    </div>
  );
}
