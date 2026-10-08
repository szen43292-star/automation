import { ReactFlowProvider } from '@xyflow/react';
import { clsx } from 'clsx';
import {
  ArrowLeft,
  Copy,
  Download,
  FlaskConical,
  History,
  MoreHorizontal,
  Play,
  Settings,
  Square,
  Trash2,
  Upload,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useBlocker, useLocation, useNavigate, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { endpoints } from '../../lib/api';
import { useEditor } from '../../stores/editor';
import { useNodeTypes } from '../../stores/nodeTypes';
import { Canvas } from '../../components/canvas/Canvas';
import { CanvasActionsContext, useCanvasActions } from '../../components/canvas/actions';
import { NodeCreator } from '../../components/canvas/NodeCreator';
import { NodeDetailsView } from '../../components/ndv/NodeDetailsView';
import { ConnectionDot } from '../../components/Layout';
import { Button, IconButton, Menu, Modal, Spinner, Toggle } from '../../components/ui';
import { downloadJson } from '../WorkflowsPage';
import { ExecutionsTab } from './ExecutionsTab';
import { useEditorActions } from './useExecutions';
import { VersionHistory, WorkflowSettingsModal } from './WorkflowModals';

export function EditorPage() {
  return (
    <ReactFlowProvider>
      <EditorPageInner />
    </ReactFlowProvider>
  );
}

function EditorPageInner() {
  const { id: routeId, executionId } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const actions = useEditorActions();
  const tab = location.pathname.includes('/executions') ? 'executions' : 'editor';
  const workflowId = routeId === 'new' ? null : (routeId ?? null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const typesLoaded = useNodeTypes((s) => s.loaded);

  // Load the workflow when entering the editor tab.
  useEffect(() => {
    if (tab !== 'editor') return;
    const state = useEditor.getState();
    if (!workflowId) {
      if (state.workflowId !== null || state.readOnly) state.reset();
      return;
    }
    const debugId = (location.state as { debugExecutionId?: string } | null)?.debugExecutionId;
    const attachDebug = () => {
      if (!debugId) return;
      endpoints
        .execution(debugId)
        .then((detail) => useEditor.getState().applyExecution(detail))
        .catch(() => undefined);
    };
    if (state.workflowId === workflowId && !state.readOnly && state.nodes.length > 0) {
      // Already loaded (e.g. right after the first save).
      attachDebug();
    } else {
      setLoading(true);
      setLoadError(null);
      // Attach the debugged run only after the workflow has loaded - load() resets run data.
      endpoints
        .workflow(workflowId)
        .then((wf) => {
          useEditor.getState().load(wf);
          attachDebug();
        })
        .catch((error: Error) => setLoadError(error.message))
        .finally(() => setLoading(false));
    }
  }, [workflowId, tab, location.state]);

  // Warn before losing unsaved changes.
  const dirty = useEditor((s) => s.dirty && !s.readOnly);
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      dirty &&
      currentLocation.pathname !== nextLocation.pathname &&
      !(
        routeId === 'new' &&
        nextLocation.pathname.startsWith('/workflow/') &&
        !nextLocation.pathname.endsWith('/executions')
      ),
  );
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  if (loadError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3">
        <div className="text-danger">{loadError}</div>
        <Button onClick={() => navigate('/workflows')}>Back to workflows</Button>
      </div>
    );
  }

  return (
    <CanvasActionsContext.Provider value={actions}>
      <div className="flex h-full flex-col">
        <EditorHeader tab={tab} workflowId={workflowId} />
        <div className="relative min-h-0 flex-1">
          {loading || !typesLoaded ? (
            <div className="flex h-full items-center justify-center">
              <Spinner />
            </div>
          ) : tab === 'editor' ? (
            <>
              <Canvas />
              <ExecuteBar />
              <NodeCreator />
              <NodeDetailsView />
            </>
          ) : workflowId ? (
            <ExecutionsTab workflowId={workflowId} executionId={executionId} />
          ) : null}
        </div>
      </div>
      <Modal
        open={blocker.state === 'blocked'}
        onClose={() => blocker.reset?.()}
        title="Save changes before leaving?"
        footer={
          <>
            <Button variant="ghost" onClick={() => blocker.reset?.()}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                useEditor.setState({ dirty: false });
                blocker.proceed?.();
              }}
            >
              Leave without saving
            </Button>
            <Button
              variant="primary"
              onClick={async () => {
                if (await actions.save()) blocker.proceed?.();
                else blocker.reset?.();
              }}
            >
              Save
            </Button>
          </>
        }
      >
        <p className="text-[13px] text-muted">
          You have unsaved changes in this workflow. They will be lost if you leave.
        </p>
      </Modal>
    </CanvasActionsContext.Provider>
  );
}

function EditorHeader({
  tab,
  workflowId,
}: {
  tab: 'editor' | 'executions';
  workflowId: string | null;
}) {
  const navigate = useNavigate();
  const actions = useCanvasActions();
  const name = useEditor((s) => s.name);
  const dirty = useEditor((s) => s.dirty);
  const active = useEditor((s) => s.active);
  const readOnly = useEditor((s) => s.readOnly);
  const [saving, setSaving] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [toggling, setToggling] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const save = async () => {
    setSaving(true);
    await actions.save();
    setSaving(false);
  };

  const setActive = async (value: boolean) => {
    if (!workflowId) return toast.error('Save the workflow first');
    if (dirty && !(await actions.save())) return;
    setToggling(true);
    try {
      const wf = await endpoints.updateWorkflow(workflowId, { active: value });
      useEditor.getState().setActive(wf.active);
      useEditor.getState().markSaved(wf);
      toast.success(wf.active ? 'Workflow activated' : 'Workflow deactivated');
    } catch (error) {
      toast.error('Could not change activation', { description: (error as Error).message });
    } finally {
      setToggling(false);
    }
  };

  const tabClass = (on: boolean) =>
    clsx(
      'rounded-md px-3 py-1 text-[13px] font-medium',
      on ? 'bg-panel-2 text-fg' : 'text-muted hover:text-fg',
    );

  return (
    <header className="flex h-13 shrink-0 items-center gap-2 border-b border-line bg-panel px-3">
      <IconButton
        icon={ArrowLeft}
        label="Back to workflows"
        onClick={() => navigate('/workflows')}
      />
      <input
        value={name}
        disabled={readOnly}
        onChange={(e) => useEditor.getState().setName(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        className="max-w-[40vw] min-w-0 rounded bg-transparent px-1.5 py-1 text-[15px] font-semibold outline-none hover:bg-panel-2 focus:bg-panel-2"
        aria-label="Workflow name"
      />
      {dirty && !readOnly && <span className="text-xs text-muted">Unsaved</span>}

      {workflowId && (
        <nav className="mx-auto flex gap-1 rounded-lg border border-line p-0.5">
          <Link to={`/workflow/${workflowId}`} className={tabClass(tab === 'editor')}>
            Editor
          </Link>
          <Link
            to={`/workflow/${workflowId}/executions`}
            className={tabClass(tab === 'executions')}
          >
            Executions
          </Link>
        </nav>
      )}
      {!workflowId && <div className="mx-auto" />}

      <ConnectionDot />
      <div className="flex items-center gap-2">
        <span className="hidden text-xs text-muted sm:inline">
          {active ? 'Active' : 'Inactive'}
        </span>
        <Toggle
          checked={active}
          disabled={toggling || !workflowId}
          onChange={(v) => void setActive(v)}
          label="Active"
        />
      </div>
      {tab === 'editor' && (
        <Button
          variant={dirty ? 'primary' : 'secondary'}
          size="sm"
          loading={saving}
          disabled={!dirty || readOnly}
          onClick={save}
        >
          {dirty ? 'Save' : 'Saved'}
        </Button>
      )}
      <input
        ref={fileInput}
        type="file"
        accept=".json,application/json"
        className="hidden"
        onChange={async (e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (!file) return;
          try {
            const count = useEditor.getState().paste(JSON.parse(await file.text()));
            toast.success(`Imported ${count} node${count === 1 ? '' : 's'} into this workflow`);
          } catch {
            toast.error('That file is not a valid workflow JSON');
          }
        }}
      />
      <Menu
        trigger={<IconButton icon={MoreHorizontal} label="Workflow menu" />}
        items={[
          {
            label: 'Download JSON',
            icon: Download,
            onClick: () => {
              const s = useEditor.getState();
              downloadJson(s.name, {
                name: s.name,
                nodes: s.nodes,
                connections: s.connections,
                settings: s.settings,
                pinData: s.pinData,
              });
            },
          },
          {
            label: 'Import from file…',
            icon: Upload,
            disabled: readOnly || tab !== 'editor',
            onClick: () => fileInput.current?.click(),
          },
          'divider',
          {
            label: 'Settings',
            icon: Settings,
            disabled: tab !== 'editor',
            onClick: () => setSettingsOpen(true),
          },
          {
            label: 'Version history',
            icon: History,
            disabled: !workflowId || tab !== 'editor',
            onClick: () => setHistoryOpen(true),
          },
          {
            label: 'Duplicate',
            icon: Copy,
            disabled: !workflowId,
            onClick: async () => {
              const s = useEditor.getState();
              const copy = await endpoints.createWorkflow({
                name: `${s.name} (copy)`,
                nodes: s.nodes,
                connections: s.connections,
                settings: s.settings,
                pinData: s.pinData,
              });
              toast.success('Duplicated');
              navigate(`/workflow/${copy.id}`);
            },
          },
          'divider',
          {
            label: 'Delete',
            icon: Trash2,
            danger: true,
            disabled: !workflowId,
            onClick: async () => {
              if (!workflowId || !window.confirm('Delete this workflow and all of its executions?'))
                return;
              await endpoints.deleteWorkflow(workflowId);
              useEditor.setState({ dirty: false });
              toast.success('Workflow deleted');
              navigate('/workflows');
            },
          },
        ]}
      />
      <WorkflowSettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      {workflowId && (
        <VersionHistory
          open={historyOpen}
          onClose={() => setHistoryOpen(false)}
          workflowId={workflowId}
        />
      )}
    </header>
  );
}

function ExecuteBar() {
  const actions = useCanvasActions();
  const status = useEditor((s) => s.executionStatus);
  const hasRunData = useEditor((s) => s.runData !== null || Object.keys(s.nodeStatus).length > 0);
  const readOnly = useEditor((s) => s.readOnly);
  const error = useEditor((s) => s.executionError);
  const shortcut = useMemo(
    () => (navigator.platform.toLowerCase().includes('mac') ? '⌘↵' : 'Ctrl+↵'),
    [],
  );
  if (readOnly) return null;
  const running = status === 'running';
  return (
    <div className="pointer-events-none absolute bottom-5 left-1/2 z-20 flex -translate-x-1/2 items-center gap-2">
      <div className="pointer-events-auto flex items-center gap-2">
        {running ? (
          <Button variant="danger" icon={Square} onClick={actions.stopExecution}>
            Stop execution
          </Button>
        ) : (
          <Button
            variant="primary"
            icon={FlaskConical}
            onClick={actions.executeWorkflow}
            title={`Execute workflow (${shortcut})`}
            className="h-10 px-5 shadow-card"
          >
            Execute workflow
          </Button>
        )}
        {running && (
          <span className="flex items-center gap-1.5 rounded-md bg-panel px-2 py-1 text-xs text-muted shadow-card">
            <Spinner size={12} /> Running…
          </span>
        )}
        {!running && hasRunData && (
          <IconButton
            icon={Trash2}
            label="Clear execution data"
            className="bg-panel shadow-card"
            onClick={() => useEditor.getState().clearExecution()}
          />
        )}
        {!running && status === 'error' && error && (
          <span
            className="max-w-xs truncate rounded-md bg-danger-soft px-2 py-1 text-xs text-danger"
            title={error.message}
          >
            {error.node ? `${error.node}: ` : ''}
            {error.message}
          </span>
        )}
        {!running && status === 'success' && (
          <span className="flex items-center gap-1 rounded-md bg-success-soft px-2 py-1 text-xs text-success">
            <Play size={11} /> Succeeded
          </span>
        )}
      </div>
    </div>
  );
}
