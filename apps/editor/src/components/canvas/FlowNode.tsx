import { Handle, Position, type NodeProps, type Node } from '@xyflow/react';
import { clsx } from 'clsx';
import { AlertTriangle, Check, Pin, Play, Plus, Power, Trash2, Zap } from 'lucide-react';
import { memo, type MouseEvent } from 'react';
import type { INode } from '@flowforge/workflow';
import { useEditor } from '../../stores/editor';
import { isTrigger, outputLabels, useNodeTypes } from '../../stores/nodeTypes';
import { NodeIcon, Spinner } from '../ui';
import { useCanvasActions } from './actions';

export type FlowNodeData = { node: INode };
export type FlowNodeType = Node<FlowNodeData, 'flow'>;

const BOX = 96;

function FlowNodeComponent({ data, selected }: NodeProps<FlowNodeType>) {
  const { node } = data;
  const description = useNodeTypes((s) => s.byName[node.type]);
  const status = useEditor((s) => s.nodeStatus[node.name]);
  const pinned = useEditor((s) => Boolean(s.pinData[node.name]));
  const readOnly = useEditor((s) => s.readOnly);
  const running = useEditor((s) => s.executionStatus === 'running');
  const outputs = outputLabels(description, node);
  const inputs = description?.inputs ?? [{ type: 'main' as const }];
  const connectedOutputs = useEditor((s) =>
    outputs
      .map((_, i) =>
        s.connections.some((c) => c.source === node.id && c.sourceOutput === i) ? '1' : '0',
      )
      .join(''),
  );
  const actions = useCanvasActions();
  const trigger = isTrigger(description);
  const unknown = !description;
  const height = Math.max(BOX, Math.max(outputs.length, inputs.length) * 32 + 16);

  const stop = (fn: () => void) => (e: MouseEvent) => {
    e.stopPropagation();
    fn();
  };

  return (
    <div className="group relative" style={{ width: BOX }}>
      {/* Hover toolbar */}
      {!readOnly && (
        <div className="nodrag absolute -top-9 left-1/2 z-10 hidden -translate-x-1/2 items-center gap-0.5 rounded-md border border-line bg-panel p-0.5 shadow-card group-hover:flex">
          <ToolbarButton
            label="Execute step"
            onClick={stop(() => actions.executeStep(node.name))}
            disabled={running}
          >
            <Play size={13} />
          </ToolbarButton>
          <ToolbarButton
            label={node.disabled ? 'Enable' : 'Deactivate'}
            onClick={stop(() => useEditor.getState().toggleDisabled([node.id]))}
          >
            <Power size={13} />
          </ToolbarButton>
          <ToolbarButton
            label="Delete"
            onClick={stop(() => useEditor.getState().removeNodes([node.id]))}
          >
            <Trash2 size={13} />
          </ToolbarButton>
        </div>
      )}

      <div
        className={clsx(
          'ff-node-box relative flex items-center justify-center border-2 bg-node shadow-card transition-colors',
          trigger ? 'rounded-l-[40px] rounded-r-xl' : 'rounded-xl',
          status?.status === 'running' && 'ff-running border-accent',
          status?.status === 'success' && 'border-success',
          (status?.status === 'error' || unknown) && 'border-danger',
          status?.status === 'canceled' && 'border-warning',
          !status && !unknown && (selected ? 'border-line' : 'border-line'),
          node.disabled && 'opacity-50',
        )}
        style={{ height }}
      >
        {trigger && (
          <Zap
            size={13}
            className="absolute -left-5 top-1/2 -translate-y-1/2 text-accent"
            fill="currentColor"
          />
        )}
        {status?.status === 'running' ? (
          <Spinner size={30} className="text-accent" />
        ) : (
          <NodeIcon
            icon={unknown ? 'circle-help' : description.icon}
            color={description?.iconColor}
            size={34}
          />
        )}

        {/* Status badges */}
        <div className="absolute right-1.5 bottom-1 flex items-center gap-1">
          {pinned && <Pin size={13} className="text-info" />}
          {status?.status === 'success' && (
            <Check size={15} strokeWidth={3} className="text-success" />
          )}
          {(status?.status === 'error' || unknown) && (
            <span title={unknown ? `Unknown node type "${node.type}"` : status?.error?.message}>
              <AlertTriangle size={15} className="text-danger" />
            </span>
          )}
        </div>
        {status && status.runs > 1 && (
          <span className="absolute top-1 right-1.5 text-[10px] font-semibold text-muted">
            {status.runs}×
          </span>
        )}

        {/* Inputs */}
        {inputs.map((_, i) => (
          <Handle
            key={`in-${i}`}
            id={`in-${i}`}
            type="target"
            position={Position.Left}
            style={{ top: `${((i + 1) / (inputs.length + 1)) * 100}%` }}
            isConnectable={!readOnly}
          />
        ))}

        {/* Outputs */}
        {outputs.map((label, i) => {
          const top = `${((i + 1) / (outputs.length + 1)) * 100}%`;
          const connected = connectedOutputs[i] === '1';
          const count =
            status && status.status !== 'running' ? (status.itemCounts[i] ?? 0) : undefined;
          return (
            <div key={`out-${i}`}>
              <Handle
                id={`out-${i}`}
                type="source"
                position={Position.Right}
                style={{ top, background: label === 'error' ? 'var(--ff-danger)' : undefined }}
                isConnectable={!readOnly}
              />
              {(label || (!connected && count !== undefined)) && (
                <span
                  className={clsx(
                    'pointer-events-none absolute left-full -translate-y-1/2 text-[11px] whitespace-nowrap',
                    label === 'error' ? 'text-danger' : 'text-muted',
                  )}
                  // Connected: just above the edge. Unconnected: to the right of the "+" button.
                  style={{
                    top: `calc(${top} - ${connected ? 9 : 0}px)`,
                    marginLeft: !connected && !readOnly ? 66 : 8,
                  }}
                >
                  {label}
                  {!connected && count !== undefined && (
                    <span
                      className={clsx('font-medium', count > 0 ? 'text-success' : 'text-muted')}
                    >
                      {label ? ' · ' : ''}
                      {count} item{count === 1 ? '' : 's'}
                    </span>
                  )}
                </span>
              )}
              {!connected && !readOnly && (
                <div
                  className="nodrag absolute left-full flex -translate-y-1/2 items-center"
                  style={{ top, marginLeft: 6 }}
                >
                  <span className="h-px w-8 bg-[var(--ff-edge)]" />
                  <button
                    title="Add node"
                    onClick={stop(() =>
                      useEditor.getState().openCreator({ source: { nodeId: node.id, output: i } }),
                    )}
                    className="flex h-5.5 w-5.5 items-center justify-center rounded-md border border-line bg-panel text-muted hover:border-accent hover:text-accent"
                  >
                    <Plus size={13} />
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Label */}
      <div className="pointer-events-none absolute top-full left-1/2 mt-1.5 w-44 -translate-x-1/2 text-center">
        <div
          className={clsx(
            'truncate text-[12.5px] font-semibold leading-tight',
            node.disabled && 'line-through',
          )}
        >
          {node.name}
        </div>
        <Subtitle node={node} template={description?.subtitle} />
        {node.disabled && <div className="text-[11px] text-muted">(Deactivated)</div>}
      </div>
    </div>
  );
}

function Subtitle({ node, template }: { node: INode; template?: string }) {
  if (!template) return null;
  const text = template
    .replace(/^=/, '')
    .replace(/\{\{\s*\$parameter\.(\w+)\s*\}\}/g, (_m, key: string) => {
      const value = node.parameters[key];
      return typeof value === 'string' || typeof value === 'number'
        ? String(value).replace(/^=/, '')
        : '';
    })
    .trim();
  if (!text) return null;
  return <div className="truncate text-[11px] text-muted">{text}</div>;
}

function ToolbarButton({
  label,
  onClick,
  children,
  disabled,
}: {
  label: string;
  onClick: (e: MouseEvent) => void;
  children: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="flex h-6 w-6 items-center justify-center rounded text-muted hover:bg-panel-2 hover:text-fg disabled:opacity-40"
    >
      {children}
    </button>
  );
}

export const FlowNode = memo(FlowNodeComponent);
