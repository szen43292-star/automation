import { useQuery } from '@tanstack/react-query';
import { Pencil, Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { isPropertyVisible, type INode, type INodeTypeDescription } from '@flowforge/workflow';
import { endpoints } from '../../lib/api';
import { useCredentialTypes } from '../../stores/credentialTypes';
import { useEditor } from '../../stores/editor';
import { IconButton } from '../ui';
import { CredentialModal } from './CredentialModal';

/** Credential pickers for the credential types a node currently needs. */
export function NodeCredentials({
  node,
  description,
}: {
  node: INode;
  description: INodeTypeDescription;
}) {
  const visible = (description.credentials ?? []).filter((c) =>
    isPropertyVisible(c.displayOptions, node.parameters),
  );
  if (!visible.length) return null;
  return (
    <div className="space-y-3 border-b border-line pb-4">
      {visible.map((c) => (
        <CredentialSelect key={c.name} node={node} type={c.name} />
      ))}
    </div>
  );
}

function CredentialSelect({ node, type }: { node: INode; type: string }) {
  const types = useCredentialTypes();
  const readOnly = useEditor((s) => s.readOnly);
  const [modal, setModal] = useState<{ id?: string } | null>(null);
  useEffect(() => void types.load(), []); // eslint-disable-line react-hooks/exhaustive-deps
  const list = useQuery({
    queryKey: ['credentials', type],
    queryFn: () => endpoints.credentials(type),
  });
  const selected = node.credentials?.[type];
  const choose = (id: string, name: string) =>
    useEditor
      .getState()
      .updateNode(node.id, { credentials: { ...(node.credentials ?? {}), [type]: { id, name } } });

  return (
    <div>
      <label className="mb-1 block text-[12.5px] font-medium">
        Credential: {types.byName[type]?.displayName ?? type}
        <span className="text-danger"> *</span>
      </label>
      <div className="flex gap-1.5">
        <select
          className="ff-input"
          disabled={readOnly}
          value={selected?.id ?? ''}
          onChange={(e) => {
            if (e.target.value === '__new__') return setModal({});
            const credential = list.data?.data.find((c) => c.id === e.target.value);
            if (credential) choose(credential.id, credential.name);
          }}
        >
          <option value="">{list.isLoading ? 'Loading…' : 'Select a credential…'}</option>
          {list.data?.data.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
          {selected && !list.data?.data.some((c) => c.id === selected.id) && (
            <option value={selected.id}>{selected.name} (not available)</option>
          )}
          <option value="__new__">+ Create new credential</option>
        </select>
        {selected && !readOnly && (
          <IconButton
            icon={Pencil}
            label="Edit credential"
            onClick={() => setModal({ id: selected.id })}
          />
        )}
        {!readOnly && (
          <IconButton icon={Plus} label="New credential" onClick={() => setModal({})} />
        )}
      </div>
      <CredentialModal
        open={modal !== null}
        onClose={() => setModal(null)}
        type={type}
        credentialId={modal?.id}
        onSaved={(c) => choose(c.id, c.name)}
      />
    </div>
  );
}
