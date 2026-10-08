import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  getSmoothStepPath,
  type Edge,
  type EdgeProps,
} from '@xyflow/react';
import { Plus, Trash2 } from 'lucide-react';
import { memo, useState } from 'react';
import type { IConnection } from '@flowforge/workflow';
import { useEditor } from '../../stores/editor';

export type FlowEdgeType = Edge<{ connection: IConnection; sourceName: string }, 'flow'>;

function FlowEdgeComponent(props: EdgeProps<FlowEdgeType>) {
  const {
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    data,
    markerEnd,
    selected,
  } = props;
  const [hover, setHover] = useState(false);
  const readOnly = useEditor((s) => s.readOnly);
  const count = useEditor((s) =>
    data ? s.nodeStatus[data.sourceName]?.itemCounts[data.connection.sourceOutput] : undefined,
  );
  const sourceStatus = useEditor((s) => (data ? s.nodeStatus[data.sourceName]?.status : undefined));

  // Backwards edges (loops) use a step path that routes around the nodes.
  const backwards = targetX < sourceX - 20;
  const [path, labelX, labelY] = backwards
    ? getSmoothStepPath({
        sourceX,
        sourceY,
        targetX,
        targetY,
        sourcePosition,
        targetPosition,
        borderRadius: 16,
        offset: 30,
      })
    : getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });

  const executed = count !== undefined && count > 0 && sourceStatus === 'success';
  const stroke =
    selected || hover ? 'var(--ff-accent)' : executed ? 'var(--ff-success)' : undefined;

  return (
    <>
      <BaseEdge path={path} markerEnd={markerEnd} style={{ stroke }} />
      {/* Wide invisible path for easier hovering */}
      <path
        d={path}
        fill="none"
        stroke="transparent"
        strokeWidth={22}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
      />
      <EdgeLabelRenderer>
        <div
          className="nodrag nopan pointer-events-auto absolute flex items-center gap-1"
          style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          onMouseEnter={() => setHover(true)}
          onMouseLeave={() => setHover(false)}
        >
          {(hover || selected) && !readOnly && data ? (
            <>
              <button
                title="Add node here"
                className="flex h-6 w-6 items-center justify-center rounded-md border border-line bg-panel text-muted shadow-card hover:text-accent"
                onClick={() => useEditor.getState().openCreator({ insertInto: data.connection })}
              >
                <Plus size={13} />
              </button>
              <button
                title="Delete connection"
                className="flex h-6 w-6 items-center justify-center rounded-md border border-line bg-panel text-muted shadow-card hover:text-danger"
                onClick={() => useEditor.getState().removeConnections([data.connection])}
              >
                <Trash2 size={13} />
              </button>
            </>
          ) : executed ? (
            <span className="rounded bg-[var(--ff-canvas)] px-1 text-[11px] font-medium text-success">
              {count} item{count === 1 ? '' : 's'}
            </span>
          ) : null}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

export const FlowEdge = memo(FlowEdgeComponent);
