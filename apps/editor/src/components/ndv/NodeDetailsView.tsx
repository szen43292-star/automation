import { clsx } from 'clsx';
import { AlertTriangle, ArrowLeft, Pencil, Pin, PinOff, Play, Terminal } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  getNodeParameters,
  getTaskInput,
  type INode,
  type INodeExecutionData,
  type IDataObject,
  type INodeParameters,
  type ISourceData,
  type NodeErrorJSON,
  type OnErrorBehaviour,
} from '@flowforge/workflow';
import { useEditor } from '../../stores/editor';
import { useServer } from '../../stores/server';
import { NodeCredentials } from '../credentials/CredentialSelect';
import { PinDataModal } from './PinDataModal';
import { EventTriggerPanel } from './EventTriggerPanel';
import { WebhookPanel } from './WebhookPanel';
import { isTrigger, outputLabels, useNodeTypes } from '../../stores/nodeTypes';
import { useCanvasActions } from '../canvas/actions';
import { Button, NodeIcon, Toggle } from '../ui';
import { DataPanel } from './DataPanel';
import { NdvContext, type NdvContextValue } from './context';
import { ParameterForm, Section } from './ParameterInputs';

export function NodeDetailsView() {
  const openNodeId = useEditor((s) => s.openNodeId);
  const node = useEditor((s) => s.nodes.find((n) => n.id === s.openNodeId));
  useEffect(() => {
    if (!openNodeId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !document.querySelector('[role="dialog"]'))
        useEditor.getState().openNode(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openNodeId]);
  if (!node) return null;
  return <NdvInner key={node.id} node={node} />;
}

function NdvInner({ node }: { node: INode }) {
  const description = useNodeTypes((s) => s.byName[node.type]);
  const nodes = useEditor((s) => s.nodes);
  const connections = useEditor((s) => s.connections);
  const runData = useEditor((s) => s.runData);
  const pinData = useEditor((s) => s.pinData);
  const status = useEditor((s) => s.nodeStatus[node.name]);
  const readOnly = useEditor((s) => s.readOnly);
  const workflowName = useEditor((s) => s.name);
  const workflowId = useEditor((s) => s.workflowId);
  const vars = useServer((s) => s.vars);
  const [pinEditor, setPinEditor] = useState(false);
  useEffect(
    () =>
      void useServer
        .getState()
        .load()
        .catch(() => undefined),
    [],
  );
  const timezone = useEditor(
    (s) => s.settings.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
  const running = useEditor((s) => s.executionStatus === 'running');
  const actions = useCanvasActions();
  const [tab, setTab] = useState<'parameters' | 'settings'>('parameters');
  const [name, setName] = useState(node.name);
  useEffect(() => setName(node.name), [node.name]);

  const runs = runData?.[node.name] ?? [];
  const [runIndex, setRunIndex] = useState(Math.max(0, runs.length - 1));
  useEffect(() => setRunIndex(Math.max(0, runs.length - 1)), [runs.length]);
  const task = runs[runIndex];

  // --- Input -------------------------------------------------------------------
  const trigger = isTrigger(description);
  const parents = useMemo(() => {
    const ids = [...new Set(connections.filter((c) => c.target === node.id).map((c) => c.source))];
    return ids.map((id) => nodes.find((n) => n.id === id)).filter((n): n is INode => Boolean(n));
  }, [connections, nodes, node.id]);
  const [parentName, setParentName] = useState<string | null>(null);
  const activeParent =
    parents.find((p) => p.name === parentName) ??
    parents.find((p) => p.name === task?.source[0]?.previousNode) ??
    parents.find((p) => runData?.[p.name]) ??
    parents[0];

  const inputItems: INodeExecutionData[] | null = useMemo(() => {
    if (!activeParent || !runData)
      return activeParent && pinData[activeParent.name] ? pinData[activeParent.name]! : null;
    if (task && task.source[0]?.previousNode === activeParent.name)
      return getTaskInput(runData, task, 0);
    const parentRuns = runData[activeParent.name];
    const last = parentRuns?.[parentRuns.length - 1];
    if (!last) return pinData[activeParent.name] ?? null;
    const output =
      connections.find((c) => c.source === activeParent.id && c.target === node.id)?.sourceOutput ??
      0;
    return last.data?.main[output] ?? [];
  }, [activeParent, runData, task, connections, node.id, pinData]);

  // --- Output ------------------------------------------------------------------
  const labels = outputLabels(description, node);
  const [outputIndex, setOutputIndex] = useState(0);
  const pinned = pinData[node.name];
  const outputItems = pinned ?? task?.data?.main[outputIndex] ?? null;

  const inputSource: ISourceData | null = useMemo(() => {
    if (task?.source[0] && task.source[0].previousNode === activeParent?.name)
      return task.source[0];
    if (!activeParent) return null;
    const runsOfParent = runData?.[activeParent.name];
    if (!runsOfParent?.length) return null;
    const output =
      connections.find((c) => c.source === activeParent.id && c.target === node.id)?.sourceOutput ??
      0;
    return {
      previousNode: activeParent.name,
      previousNodeOutput: output,
      previousNodeRun: runsOfParent.length - 1,
    };
  }, [task, activeParent, runData, connections, node.id]);

  const ctx: NdvContextValue = useMemo(
    () => ({
      inputItems: inputItems ?? [],
      inputSource,
      runData,
      getNodeOutput: (nodeName: string) => {
        const r = runData?.[nodeName];
        if (r?.length) return r[r.length - 1]?.data?.main[0] ?? [];
        return pinData[nodeName] ?? undefined;
      },
      nodeNames: nodes
        .filter((n) => n.id !== node.id && n.type !== 'flowforge.stickyNote')
        .map((n) => n.name),
      workflowId: workflowId ?? undefined,
      workflowName,
      timezone,
      vars: vars as IDataObject,
      parameters: node.parameters as IDataObject,
      readOnly,
    }),
    [
      inputItems,
      inputSource,
      pinData,
      runData,
      nodes,
      node.id,
      node.parameters,
      workflowId,
      workflowName,
      timezone,
      vars,
      readOnly,
    ],
  );

  const commitName = () => {
    if (name.trim() === node.name) return;
    const result = useEditor.getState().renameNode(node.id, name);
    if (result === null) {
      toast.error(`A node named "${name.trim()}" already exists`);
      setName(node.name);
    }
  };

  const setParameters = (parameters: INodeParameters) =>
    useEditor.getState().setParameters(node.id, parameters);

  return (
    <NdvContext.Provider value={ctx}>
      <div
        className="fixed inset-0 z-40 flex flex-col bg-black/50 p-3 sm:p-6"
        onMouseDown={() => useEditor.getState().openNode(null)}
      >
        <div
          className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-line bg-panel shadow-2xl"
          onMouseDown={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className="flex items-center gap-3 border-b border-line px-4 py-2.5">
            <button
              className="flex items-center gap-1 text-[13px] text-muted hover:text-fg"
              onClick={() => useEditor.getState().openNode(null)}
            >
              <ArrowLeft size={15} /> Back to canvas
            </button>
            <div className="mx-auto flex min-w-0 items-center gap-2">
              <NodeIcon icon={description?.icon} color={description?.iconColor} size={20} />
              <input
                value={name}
                disabled={readOnly}
                onChange={(e) => setName(e.target.value)}
                onBlur={commitName}
                onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
                className="min-w-0 rounded bg-transparent px-1 py-0.5 text-[15px] font-semibold outline-none focus:bg-panel-2"
                aria-label="Node name"
              />
              {description && (
                <span className="hidden text-xs text-muted md:inline">
                  {description.displayName}
                </span>
              )}
            </div>
            {!readOnly && (
              <Button
                variant="primary"
                size="sm"
                icon={Play}
                loading={running && status?.status === 'running'}
                disabled={running}
                onClick={() => actions.executeStep(node.name)}
              >
                {trigger ? 'Test trigger' : 'Execute step'}
              </Button>
            )}
          </div>

          {/* Columns */}
          <div
            className={clsx(
              'grid min-h-0 flex-1',
              trigger
                ? 'lg:grid-cols-[minmax(380px,1fr)_minmax(0,1fr)]'
                : 'lg:grid-cols-[minmax(0,1fr)_minmax(380px,1.1fr)_minmax(0,1fr)]',
            )}
          >
            {!trigger && (
              <section className="hidden min-h-0 border-r border-line bg-panel-2/40 lg:block">
                <DataPanel
                  items={inputItems}
                  draggable={!readOnly}
                  header={
                    <div className="flex items-center gap-2">
                      <span className="text-[11px] font-semibold tracking-wide text-muted uppercase">
                        Input
                      </span>
                      {parents.length > 1 ? (
                        <select
                          className="ff-input w-auto py-0.5 text-xs"
                          value={activeParent?.name}
                          onChange={(e) => setParentName(e.target.value)}
                        >
                          {parents.map((p) => (
                            <option key={p.id} value={p.name}>
                              {p.name}
                            </option>
                          ))}
                        </select>
                      ) : activeParent ? (
                        <span className="truncate text-xs text-muted">
                          from {activeParent.name}
                        </span>
                      ) : null}
                    </div>
                  }
                  empty={
                    <div className="flex flex-col items-center gap-3 p-8 text-center text-[13px] text-muted">
                      {activeParent ? (
                        <>
                          <div>No input data yet.</div>
                          {!readOnly && (
                            <Button
                              size="sm"
                              icon={Play}
                              disabled={running}
                              onClick={() => actions.executeStep(activeParent.name)}
                            >
                              Execute previous nodes
                            </Button>
                          )}
                          <div className="text-xs">
                            Then drag fields from here into the parameters.
                          </div>
                        </>
                      ) : (
                        <div>This node has no input connection.</div>
                      )}
                    </div>
                  }
                />
              </section>
            )}

            <section className="flex min-h-0 flex-col">
              <div className="flex gap-4 border-b border-line px-4">
                {(['parameters', 'settings'] as const).map((t) => (
                  <button
                    key={t}
                    onClick={() => setTab(t)}
                    className={clsx(
                      '-mb-px border-b-2 py-2 text-[13px] font-medium capitalize',
                      tab === t
                        ? 'border-accent text-fg'
                        : 'border-transparent text-muted hover:text-fg',
                    )}
                  >
                    {t}
                  </button>
                ))}
              </div>
              <div className="ff-scroll min-h-0 flex-1 overflow-y-auto p-4">
                {!description ? (
                  <div className="rounded-md border border-danger/40 bg-danger-soft p-3 text-[13px] text-danger">
                    Unknown node type “{node.type}”. The node is not installed on this server.
                  </div>
                ) : tab === 'parameters' ? (
                  <div className="space-y-4">
                    {description.webhook && <WebhookPanel node={node} description={description} />}
                    {description.triggerKind === 'event' && !readOnly && (
                      <EventTriggerPanel node={node} />
                    )}
                    <NodeCredentials node={node} description={description} />
                    {description.properties.length === 0 ? (
                      <div className="text-[13px] text-muted">This node has no parameters.</div>
                    ) : (
                      <ParameterForm
                        properties={description.properties}
                        values={getNodeParameters(description.properties, node.parameters)}
                        onChange={setParameters}
                      />
                    )}
                  </div>
                ) : (
                  <NodeSettings node={node} />
                )}
              </div>
            </section>

            <section className="flex min-h-0 flex-col border-t border-line lg:border-t-0 lg:border-l">
              <OutputHeader
                labels={labels}
                outputIndex={outputIndex}
                setOutputIndex={setOutputIndex}
                runs={runs.length}
                runIndex={runIndex}
                setRunIndex={setRunIndex}
                pinned={Boolean(pinned)}
                canPin={
                  !readOnly && Boolean(task?.data?.main[outputIndex]?.length) && outputIndex === 0
                }
                onPin={() => {
                  const items = task?.data?.main[0];
                  if (items)
                    useEditor.getState().setPinData(
                      node.name,
                      items.map(({ json, binary }) => ({ json, ...(binary ? { binary } : {}) })),
                    );
                }}
                onUnpin={() => useEditor.getState().setPinData(node.name, null)}
                onEdit={readOnly ? undefined : () => setPinEditor(true)}
              />
              <PinDataModal
                open={pinEditor}
                onClose={() => setPinEditor(false)}
                nodeName={node.name}
                initial={pinned ?? task?.data?.main[0] ?? null}
              />
              {task?.error && <ErrorBox error={task.error} />}
              {pinned && (
                <div className="flex items-center gap-2 border-b border-line bg-panel-2 px-3 py-1.5 text-xs text-info">
                  <Pin size={13} /> This data is pinned: the node won't run, it outputs this data
                  instead.
                </div>
              )}
              <div className="min-h-0 flex-1">
                <DataPanel
                  items={task?.executionStatus === 'error' && !pinned ? null : outputItems}
                  header={
                    <span className="text-[11px] font-semibold tracking-wide text-muted uppercase">
                      Output
                    </span>
                  }
                  empty={
                    <div className="p-8 text-center text-[13px] text-muted">
                      {task?.executionStatus === 'error'
                        ? 'The node failed - see the error above.'
                        : status?.status === 'running'
                          ? 'Executing…'
                          : 'Execute this node to see its output.'}
                    </div>
                  }
                />
              </div>
              {task?.logs?.length || task?.hints?.length ? (
                <div className="ff-scroll max-h-40 overflow-auto border-t border-line bg-panel-2 px-3 py-2 font-mono text-[11.5px]">
                  {task?.hints?.map((h) => (
                    <div key={h} className="text-warning">
                      ⚠ {h}
                    </div>
                  ))}
                  {task?.logs?.map((line, i) => (
                    <div key={i} className="flex gap-2 text-muted">
                      <Terminal size={12} className="mt-0.5 shrink-0" />{' '}
                      <span className="break-all whitespace-pre-wrap">{line}</span>
                    </div>
                  ))}
                </div>
              ) : null}
            </section>
          </div>
        </div>
      </div>
    </NdvContext.Provider>
  );
}

function OutputHeader(props: {
  labels: string[];
  outputIndex: number;
  setOutputIndex: (i: number) => void;
  runs: number;
  runIndex: number;
  setRunIndex: (i: number) => void;
  pinned: boolean;
  canPin: boolean;
  onPin: () => void;
  onUnpin: () => void;
  onEdit?: () => void;
}) {
  if (
    props.labels.length <= 1 &&
    props.runs <= 1 &&
    !props.pinned &&
    !props.canPin &&
    !props.onEdit
  )
    return null;
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-1.5">
      {props.labels.length > 1 && (
        <div className="flex rounded-md border border-line p-0.5 text-xs">
          {props.labels.map((label, i) => (
            <button
              key={i}
              onClick={() => props.setOutputIndex(i)}
              className={clsx(
                'rounded px-2 py-0.5',
                props.outputIndex === i ? 'bg-panel-2 font-medium' : 'text-muted',
              )}
            >
              {label || `Output ${i + 1}`}
            </button>
          ))}
        </div>
      )}
      {props.runs > 1 && (
        <select
          className="ff-input w-auto py-0.5 text-xs"
          value={props.runIndex}
          onChange={(e) => props.setRunIndex(Number(e.target.value))}
        >
          {Array.from({ length: props.runs }, (_, i) => (
            <option key={i} value={i}>
              Run {i + 1} of {props.runs}
            </option>
          ))}
        </select>
      )}
      <div className="ml-auto flex items-center gap-1">
        {props.onEdit && (
          <Button
            size="sm"
            variant="ghost"
            icon={Pencil}
            onClick={props.onEdit}
            title="Edit or mock this node's output (pins it)"
          >
            {props.pinned ? 'Edit' : 'Set mock data'}
          </Button>
        )}
        {props.pinned ? (
          <Button size="sm" variant="ghost" icon={PinOff} onClick={props.onUnpin}>
            Unpin
          </Button>
        ) : props.canPin ? (
          <Button
            size="sm"
            variant="ghost"
            icon={Pin}
            onClick={props.onPin}
            title="Reuse this output in future runs instead of executing the node"
          >
            Pin data
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function ErrorBox({ error }: { error: NodeErrorJSON }) {
  const [details, setDetails] = useState(false);
  return (
    <div className="border-b border-danger/30 bg-danger-soft px-4 py-3 text-[13px]">
      <div className="flex items-start gap-2 text-danger">
        <AlertTriangle size={16} className="mt-0.5 shrink-0" />
        <div className="min-w-0">
          <div className="font-semibold break-words">{error.message}</div>
          {error.description && (
            <div className="mt-1 break-words whitespace-pre-wrap text-fg/80">
              {error.description}
            </div>
          )}
          <div className="mt-1.5 flex flex-wrap gap-x-3 text-xs text-muted">
            {error.itemIndex !== undefined && <span>Item {error.itemIndex}</span>}
            {error.httpCode && <span>HTTP {error.httpCode}</span>}
            <span>{error.name}</span>
            {error.stack && (
              <button className="underline" onClick={() => setDetails((d) => !d)}>
                {details ? 'Hide' : 'Show'} details
              </button>
            )}
          </div>
          {details && (
            <pre className="mt-2 max-h-48 overflow-auto font-mono text-[11px] whitespace-pre-wrap text-muted">
              {error.stack}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}

function NodeSettings({ node }: { node: INode }) {
  const update = (patch: Partial<INode>) => useEditor.getState().updateNode(node.id, patch);
  const readOnly = useEditor((s) => s.readOnly);
  const row = (label: string, hint: string, control: React.ReactNode) => (
    <div className="flex items-start justify-between gap-4 py-2">
      <div>
        <div className="text-[13px] font-medium">{label}</div>
        <div className="text-xs text-muted">{hint}</div>
      </div>
      {control}
    </div>
  );
  return (
    <div className={clsx('space-y-5', readOnly && 'pointer-events-none opacity-80')}>
      <Section title="Behaviour">
        {row(
          'Always Output Data',
          'Output an empty item if the node returns nothing, so the next nodes still run',
          <Toggle
            checked={Boolean(node.alwaysOutputData)}
            onChange={(v) => update({ alwaysOutputData: v || undefined })}
          />,
        )}
        {row(
          'Execute Once',
          'Only process the first input item',
          <Toggle
            checked={Boolean(node.executeOnce)}
            onChange={(v) => update({ executeOnce: v || undefined })}
          />,
        )}
        {row(
          'Deactivated',
          'Skip this node - its input is passed straight through',
          <Toggle
            checked={Boolean(node.disabled)}
            onChange={(v) => update({ disabled: v || undefined })}
          />,
        )}
      </Section>
      <Section title="Retries">
        {row(
          'Retry On Fail',
          'Run the node again if it fails',
          <Toggle
            checked={Boolean(node.retryOnFail)}
            onChange={(v) => update({ retryOnFail: v || undefined })}
          />,
        )}
        {node.retryOnFail && (
          <div className="grid grid-cols-2 gap-3">
            <label className="text-[12.5px] font-medium">
              Max Tries
              <input
                type="number"
                min={2}
                max={10}
                className="ff-input mt-1"
                value={node.maxTries ?? 3}
                onChange={(e) =>
                  update({ maxTries: Math.min(10, Math.max(2, Number(e.target.value) || 3)) })
                }
              />
            </label>
            <label className="text-[12.5px] font-medium">
              Wait Between Tries (ms)
              <input
                type="number"
                min={0}
                max={300000}
                className="ff-input mt-1"
                value={node.waitBetweenTries ?? 1000}
                onChange={(e) =>
                  update({
                    waitBetweenTries: Math.min(300000, Math.max(0, Number(e.target.value) || 0)),
                  })
                }
              />
            </label>
          </div>
        )}
      </Section>
      <Section title="On Error">
        <select
          className="ff-input"
          value={node.onError ?? 'stopWorkflow'}
          onChange={(e) => {
            const value = e.target.value as OnErrorBehaviour;
            update({ onError: value === 'stopWorkflow' ? undefined : value });
          }}
        >
          <option value="stopWorkflow">Stop Workflow</option>
          <option value="continueRegularOutput">Continue</option>
          <option value="continueErrorOutput">Continue (using error output)</option>
        </select>
        <div className="mt-1 text-xs text-muted">
          “Continue (using error output)” adds an extra <span className="text-danger">error</span>{' '}
          output for failed items.
        </div>
      </Section>
      <Section title="Notes">
        <textarea
          className="ff-input"
          rows={3}
          placeholder="Notes for your team…"
          value={node.notes ?? ''}
          onChange={(e) => update({ notes: e.target.value || undefined })}
        />
      </Section>
    </div>
  );
}
