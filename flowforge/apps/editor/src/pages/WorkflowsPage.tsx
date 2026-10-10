import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Copy,
  Download,
  MoreHorizontal,
  Plus,
  Search,
  Trash2,
  Upload,
  Workflow as WorkflowIcon,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { workflowImportSchema } from '@flowforge/workflow';
import { endpoints, type WorkflowListItem } from '../lib/api';
import { timeAgo } from '../lib/format';
import { useNodeTypes } from '../stores/nodeTypes';
import { Button, EmptyState, IconButton, Menu, NodeIcon, Spinner, Toggle } from '../components/ui';

export function downloadJson(name: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${name.replace(/[^\w\- ]+/g, '').trim() || 'workflow'}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

/** Read a .json file chosen by the user and import it as a new workflow. */
export async function importWorkflowFile(file: File) {
  const text = await file.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('The file is not valid JSON');
  }
  const result = workflowImportSchema.safeParse({
    name: file.name.replace(/\.json$/i, ''),
    ...(parsed as object),
  });
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new Error(`Not a FlowForge workflow: ${issue?.path.join('.')} ${issue?.message}`);
  }
  return endpoints.importWorkflow(result.data);
}

export function WorkflowsPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  // Ask the server once typing pauses, and keep showing the current list meanwhile.
  const [searched, setSearched] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setSearched(search.trim()), 250);
    return () => clearTimeout(timer);
  }, [search]);
  const fileInput = useRef<HTMLInputElement>(null);
  const byName = useNodeTypes((s) => s.byName);
  const query = useQuery({
    queryKey: ['workflows', searched],
    queryFn: () => endpoints.workflows({ search: searched }),
    placeholderData: keepPreviousData,
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['workflows'] });
  const toggleActive = useMutation({
    mutationFn: ({ id, active }: { id: string; active: boolean }) =>
      endpoints.updateWorkflow(id, { active }),
    onSuccess: (wf) => {
      toast.success(wf.active ? 'Workflow activated' : 'Workflow deactivated');
      void refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const duplicate = async (item: WorkflowListItem) => {
    const wf = await endpoints.workflow(item.id);
    const copy = await endpoints.createWorkflow({
      name: `${wf.name} (copy)`,
      nodes: wf.nodes,
      connections: wf.connections,
      settings: wf.settings,
      pinData: wf.pinData,
    });
    toast.success('Workflow duplicated');
    navigate(`/workflow/${copy.id}`);
  };

  const exportWorkflow = async (item: WorkflowListItem) => {
    const wf = await endpoints.workflow(item.id);
    downloadJson(wf.name, {
      name: wf.name,
      nodes: wf.nodes,
      connections: wf.connections,
      settings: wf.settings,
      pinData: wf.pinData,
    });
  };

  const remove = async (item: WorkflowListItem) => {
    if (!window.confirm(`Delete "${item.name}" and all of its executions? This cannot be undone.`))
      return;
    await endpoints.deleteWorkflow(item.id);
    toast.success('Workflow deleted');
    void refresh();
  };

  return (
    <div className="ff-scroll h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl px-4 py-8 sm:px-8">
        <div className="mb-6 flex flex-wrap items-center gap-3">
          <div>
            <h1 className="text-xl font-semibold">Workflows</h1>
            <p className="text-[13px] text-muted">
              Automations that run on triggers, schedules and calls.
            </p>
          </div>
          <div className="ml-auto flex gap-2">
            <input
              ref={fileInput}
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (!file) return;
                try {
                  const wf = await importWorkflowFile(file);
                  toast.success(`Imported "${wf.name}"`);
                  navigate(`/workflow/${wf.id}`);
                } catch (error) {
                  toast.error((error as Error).message);
                }
              }}
            />
            <Button icon={Upload} onClick={() => fileInput.current?.click()}>
              Import
            </Button>
            <Button variant="primary" icon={Plus} onClick={() => navigate('/workflow/new')}>
              Create workflow
            </Button>
          </div>
        </div>

        <div className="relative mb-4">
          <Search size={15} className="absolute top-1/2 left-3 -translate-y-1/2 text-muted" />
          <input
            className="ff-input pl-9"
            placeholder="Search workflows…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        {query.isLoading ? (
          <div className="flex justify-center py-16">
            <Spinner />
          </div>
        ) : query.isError ? (
          <div className="rounded-md bg-danger-soft p-4 text-danger">
            {(query.error as Error).message}
          </div>
        ) : !query.data?.data.length ? (
          <EmptyState
            icon={WorkflowIcon}
            title={searched ? 'No workflows match your search' : 'No workflows yet'}
            description={
              searched
                ? undefined
                : 'Create your first workflow - for example an AI receptionist that answers every WhatsApp call.'
            }
            action={
              !searched && (
                <Button variant="primary" icon={Plus} onClick={() => navigate('/workflow/new')}>
                  Create workflow
                </Button>
              )
            }
          />
        ) : (
          <div className="overflow-hidden rounded-xl border border-line bg-panel">
            {query.data.data.map((item) => (
              <div
                key={item.id}
                role="link"
                tabIndex={0}
                onClick={() => navigate(`/workflow/${item.id}`)}
                onKeyDown={(e) => e.key === 'Enter' && navigate(`/workflow/${item.id}`)}
                className="flex cursor-pointer items-center gap-4 border-b border-line px-4 py-3 last:border-b-0 hover:bg-panel-2"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{item.name}</div>
                  <div className="mt-0.5 text-xs text-muted">
                    Updated {timeAgo(item.updatedAt)} · {item.nodeCount} node
                    {item.nodeCount === 1 ? '' : 's'} · {item.owner.name}
                  </div>
                </div>
                <div className="hidden items-center gap-1 sm:flex">
                  {item.nodeTypes
                    .filter((t) => t !== 'flowforge.stickyNote')
                    .slice(0, 5)
                    .map((t) => (
                      <span
                        key={t}
                        className="flex h-7 w-7 items-center justify-center rounded-md border border-line bg-node"
                        title={byName[t]?.displayName ?? t}
                      >
                        <NodeIcon icon={byName[t]?.icon} color={byName[t]?.iconColor} size={14} />
                      </span>
                    ))}
                </div>
                <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                  <span className="hidden text-xs text-muted sm:inline">
                    {item.active ? 'Active' : 'Inactive'}
                  </span>
                  <Toggle
                    checked={item.active}
                    label="Active"
                    disabled={toggleActive.isPending}
                    onChange={(active) => toggleActive.mutate({ id: item.id, active })}
                  />
                  <Menu
                    trigger={<IconButton icon={MoreHorizontal} label="More" />}
                    items={[
                      { label: 'Duplicate', icon: Copy, onClick: () => void duplicate(item) },
                      {
                        label: 'Download JSON',
                        icon: Download,
                        onClick: () => void exportWorkflow(item),
                      },
                      'divider',
                      {
                        label: 'Delete',
                        icon: Trash2,
                        danger: true,
                        onClick: () => void remove(item),
                      },
                    ]}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
