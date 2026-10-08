import { useQuery } from '@tanstack/react-query';
import { RotateCcw } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import type { IConnection, INode, IWorkflowSettings } from '@flowforge/workflow';
import { endpoints } from '../../lib/api';
import { formatDateTime, timeAgo } from '../../lib/format';
import { useEditor } from '../../stores/editor';
import { Button, Field, Modal, Spinner } from '../../components/ui';

export function WorkflowSettingsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const settings = useEditor((s) => s.settings);
  const workflowId = useEditor((s) => s.workflowId);
  const workflows = useQuery({
    queryKey: ['workflows', 'all'],
    queryFn: () => endpoints.workflows({ limit: 250 }),
    enabled: open,
  });
  const [draft, setDraft] = useState<IWorkflowSettings>(settings);
  useEffect(() => {
    if (open) setDraft(settings);
  }, [open, settings]);
  const zones = useMemo(() => {
    try {
      return (Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf(
        'timeZone',
      );
    } catch {
      return [];
    }
  }, []);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Workflow settings"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              useEditor.getState().setSettings(draft);
              onClose();
            }}
          >
            Apply
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field
          label="Timezone"
          hint="Used by date nodes, $now and schedules. Empty = server default."
        >
          <input
            className="ff-input"
            list="ff-timezones"
            placeholder={Intl.DateTimeFormat().resolvedOptions().timeZone}
            value={draft.timezone ?? ''}
            onChange={(e) => setDraft({ ...draft, timezone: e.target.value || undefined })}
          />
          <datalist id="ff-timezones">
            {zones.map((z) => (
              <option key={z} value={z} />
            ))}
          </datalist>
        </Field>
        <Field
          label="Timeout (seconds)"
          hint="Stop executions that run longer than this. Empty = no limit."
        >
          <input
            className="ff-input"
            type="number"
            min={1}
            max={86400}
            value={draft.executionTimeout ?? ''}
            onChange={(e) =>
              setDraft({
                ...draft,
                executionTimeout: e.target.value ? Math.max(1, Number(e.target.value)) : undefined,
              })
            }
          />
        </Field>
        <Field
          label="Error workflow"
          hint="Started when a production execution of this workflow fails. It needs an Error Trigger node."
        >
          <select
            className="ff-input"
            value={draft.errorWorkflow ?? ''}
            onChange={(e) => setDraft({ ...draft, errorWorkflow: e.target.value || undefined })}
          >
            <option value="">None</option>
            {workflows.data?.data
              .filter((w) => w.id !== workflowId)
              .map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
          </select>
        </Field>
        <Field
          label="Max concurrent executions"
          hint="Limit parallel production runs (e.g. to protect an API). Empty = no limit."
        >
          <input
            className="ff-input"
            type="number"
            min={1}
            max={1000}
            value={draft.maxConcurrency ?? ''}
            onChange={(e) =>
              setDraft({
                ...draft,
                maxConcurrency: e.target.value
                  ? Math.max(1, Math.floor(Number(e.target.value)))
                  : undefined,
              })
            }
          />
        </Field>
      </div>
    </Modal>
  );
}

export function VersionHistory({
  open,
  onClose,
  workflowId,
}: {
  open: boolean;
  onClose: () => void;
  workflowId: string;
}) {
  const versions = useQuery({
    queryKey: ['versions', workflowId],
    queryFn: () => endpoints.versions(workflowId),
    enabled: open,
  });
  const current = useEditor((s) => s.versionId);
  const [restoring, setRestoring] = useState<string | null>(null);

  const restore = async (versionId: string) => {
    setRestoring(versionId);
    try {
      const version = await endpoints.version(workflowId, versionId);
      const state = useEditor.getState();
      state.record();
      useEditor.setState({
        name: version.name,
        nodes: version.nodes as INode[],
        connections: version.connections as IConnection[],
        settings: version.settings,
        dirty: true,
      });
      toast.success('Version restored - save to keep it');
      onClose();
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setRestoring(null);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Version history" width={520}>
      {versions.isLoading ? (
        <div className="flex justify-center py-8">
          <Spinner />
        </div>
      ) : (
        <div className="divide-y divide-line">
          {versions.data?.data.map((v) => (
            <div key={v.versionId} className="flex items-center gap-3 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-medium">
                  {formatDateTime(v.createdAt)}
                  {v.versionId === current && (
                    <span className="ml-2 text-xs text-success">current</span>
                  )}
                </div>
                <div className="truncate text-xs text-muted">
                  {v.name} · {v.author?.name ?? 'unknown'} · {timeAgo(v.createdAt)}
                </div>
              </div>
              {v.versionId !== current && (
                <Button
                  size="sm"
                  icon={RotateCcw}
                  loading={restoring === v.versionId}
                  onClick={() => void restore(v.versionId)}
                >
                  Restore
                </Button>
              )}
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}
