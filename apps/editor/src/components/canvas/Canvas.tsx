import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  applyEdgeChanges,
  applyNodeChanges,
  useReactFlow,
  type Connection,
  type EdgeChange,
  type FinalConnectionState,
  type NodeChange,
  type OnConnectEnd,
} from '@xyflow/react';
import { Plus } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { IConnection, INode } from '@flowforge/workflow';
import { connectionKey, useEditor } from '../../stores/editor';
import { STICKY_TYPE, useNodeTypes } from '../../stores/nodeTypes';
import { useTheme } from '../../lib/theme';
import { useCanvasActions } from './actions';
import { FlowEdge, type FlowEdgeType } from './FlowEdge';
import { FlowNode } from './FlowNode';
import { StickyNode } from './StickyNode';

type RFNode = {
  id: string;
  type: 'flow' | 'sticky';
  position: { x: number; y: number };
  data: { node: INode };
  selected?: boolean;
  zIndex?: number;
  width?: number;
  height?: number;
  measured?: { width?: number; height?: number };
  dragging?: boolean;
  style?: React.CSSProperties;
};

const nodeTypes = { flow: FlowNode, sticky: StickyNode };
const edgeTypes = { flow: FlowEdge };
const defaultEdgeOptions = {
  type: 'flow',
  markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
};

const parseHandle = (handle: string | null | undefined) =>
  Number((handle ?? '').split('-')[1] ?? 0) || 0;

export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const el = target;
  return (
    el.isContentEditable ||
    ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) ||
    Boolean(el.closest('.cm-editor'))
  );
}

export function Canvas() {
  const nodes = useEditor((s) => s.nodes);
  const connections = useEditor((s) => s.connections);
  const selection = useEditor((s) => s.selection);
  const readOnly = useEditor((s) => s.readOnly);
  const dark = useTheme((s) => s.dark);
  const flow = useReactFlow();
  const actions = useCanvasActions();
  const pointer = useRef({ x: 0, y: 0 });
  const wrapper = useRef<HTMLDivElement>(null);

  // --- Nodes: derive React Flow nodes from the store, keeping measured sizes ----
  const [rfNodes, setRfNodes] = useState<RFNode[]>([]);
  useEffect(() => {
    const selected = new Set(selection);
    setRfNodes((previous) => {
      const prevById = new Map(previous.map((n) => [n.id, n]));
      return nodes.map((node) => {
        const prev = prevById.get(node.id);
        const isSelected = selected.has(node.id);
        if (prev && prev.data.node === node && prev.selected === isSelected && !prev.dragging) {
          return prev;
        }
        const sticky = node.type === STICKY_TYPE;
        return {
          id: node.id,
          type: sticky ? 'sticky' : 'flow',
          position: { x: node.position[0], y: node.position[1] },
          data: { node },
          selected: isSelected,
          zIndex: sticky ? -1 : 0,
          ...(sticky ? { width: node.width ?? 260, height: node.height ?? 180 } : {}),
          measured: prev?.measured,
        };
      });
    });
  }, [nodes, selection]);

  // --- Edges ------------------------------------------------------------------
  const [selectedEdges, setSelectedEdges] = useState<Set<string>>(new Set());
  const edges = useMemo<FlowEdgeType[]>(() => {
    const names = new Map(nodes.map((n) => [n.id, n.name]));
    return connections.map((connection) => {
      const id = connectionKey(connection);
      return {
        id,
        type: 'flow',
        source: connection.source,
        target: connection.target,
        sourceHandle: `out-${connection.sourceOutput}`,
        targetHandle: `in-${connection.targetInput}`,
        selected: selectedEdges.has(id),
        data: { connection, sourceName: names.get(connection.source) ?? '' },
      };
    });
  }, [connections, nodes, selectedEdges]);

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    setRfNodes((current) => applyNodeChanges(changes, current as never) as unknown as RFNode[]);
    const ended = changes.filter(
      (c): c is Extract<NodeChange, { type: 'position' }> =>
        c.type === 'position' && c.dragging === false && Boolean(c.position),
    );
    if (ended.length) {
      useEditor.getState().setPositions(ended.map((c) => ({ id: c.id, position: c.position! })));
    }
    const selects = changes.filter(
      (c): c is Extract<NodeChange, { type: 'select' }> => c.type === 'select',
    );
    if (selects.length) {
      const state = useEditor.getState();
      const next = new Set(state.selection);
      for (const change of selects) {
        if (change.selected) next.add(change.id);
        else next.delete(change.id);
      }
      state.setSelection(state.nodes.filter((n) => next.has(n.id)).map((n) => n.id));
    }
  }, []);

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      const next = applyEdgeChanges(changes, edges);
      setSelectedEdges(new Set(next.filter((e) => e.selected).map((e) => e.id)));
    },
    [edges],
  );

  const onConnect = useCallback((c: Connection) => {
    useEditor.getState().connect({
      source: c.source,
      sourceOutput: parseHandle(c.sourceHandle),
      target: c.target,
      targetInput: parseHandle(c.targetHandle),
    });
  }, []);

  /** Dropping a connection on empty canvas opens the node panel. */
  const onConnectEnd: OnConnectEnd = useCallback(
    (event, state: FinalConnectionState) => {
      if (state.isValid || !state.fromNode || state.fromHandle?.type !== 'source') return;
      const point = 'changedTouches' in event ? event.changedTouches[0]! : (event as MouseEvent);
      const position = flow.screenToFlowPosition({ x: point.clientX, y: point.clientY });
      useEditor.getState().openCreator({
        source: { nodeId: state.fromNode.id, output: parseHandle(state.fromHandle.id) },
        position: { x: position.x, y: position.y - 48 },
      });
    },
    [flow],
  );

  const isValidConnection = useCallback(
    (c: Connection | FlowEdgeType) => c.source !== c.target,
    [],
  );

  // --- Keyboard shortcuts & clipboard ------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const state = useEditor.getState();
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();
      // Save and execute work everywhere, including while typing in a field.
      if (mod && key === 's') {
        e.preventDefault();
        void actions.save();
        return;
      }
      if (mod && key === 'enter') {
        e.preventDefault();
        actions.executeWorkflow();
        return;
      }
      if (state.openNodeId || state.creator.open || isTypingTarget(e.target)) return;
      if (document.querySelector('[role="dialog"]')) return;

      if (state.readOnly) {
        return;
      } else if (mod && key === 'z' && !e.shiftKey) {
        e.preventDefault();
        state.undo();
      } else if ((mod && key === 'z' && e.shiftKey) || (mod && key === 'y')) {
        e.preventDefault();
        state.redo();
      } else if (mod && key === 'a') {
        e.preventDefault();
        state.setSelection(state.nodes.map((n) => n.id));
      } else if (mod && key === 'd') {
        e.preventDefault();
        state.duplicateNodes(state.selection);
      } else if (key === 'delete' || key === 'backspace') {
        if (state.selection.length) state.removeNodes(state.selection);
        else if (selectedEdges.size) {
          state.removeConnections(
            state.connections.filter((c) => selectedEdges.has(connectionKey(c))),
          );
          setSelectedEdges(new Set());
        }
      } else if (key === 'tab') {
        e.preventDefault();
        const only = state.selection.length === 1 ? state.selection[0] : undefined;
        state.openCreator(only ? { source: { nodeId: only, output: 0 } } : {});
      } else if (key === 'd' && !mod) {
        state.toggleDisabled(state.selection);
      } else if (key === 's' && e.shiftKey && !mod) {
        state.addNode(STICKY_TYPE, {
          position: { x: pointer.current.x - 130, y: pointer.current.y - 90 },
        });
      } else if (key === 'enter' && state.selection.length === 1) {
        state.openNode(state.selection[0]!);
      } else if (key === 'f2' && state.selection.length === 1) {
        const node = state.nodes.find((n) => n.id === state.selection[0]);
        const name = node && window.prompt('Rename node', node.name);
        if (node && name && state.renameNode(node.id, name) === null)
          toast.error(`A node named "${name}" already exists`);
      } else if (key === '1' && !mod) {
        void flow.fitView({ padding: 0.2, duration: 200 });
      } else if (key === '0' && !mod) {
        void flow.zoomTo(1, { duration: 200 });
      } else if ((key === '+' || key === '=') && !mod) {
        void flow.zoomIn({ duration: 150 });
      } else if (key === '-' && !mod) {
        void flow.zoomOut({ duration: 150 });
      }
    };

    const onCopy = (e: ClipboardEvent) => {
      const state = useEditor.getState();
      if (state.openNodeId || isTypingTarget(e.target)) return;
      const data = state.copySelection();
      if (!data) return;
      e.preventDefault();
      e.clipboardData?.setData('text/plain', JSON.stringify(data, null, 2));
      if (e.type === 'cut' && !state.readOnly) state.removeNodes(state.selection);
      toast.success(
        `${e.type === 'cut' ? 'Cut' : 'Copied'} ${data.nodes.length} node${data.nodes.length === 1 ? '' : 's'}`,
      );
    };

    const onPaste = (e: ClipboardEvent) => {
      const state = useEditor.getState();
      if (state.openNodeId || state.readOnly || isTypingTarget(e.target)) return;
      const text = e.clipboardData?.getData('text/plain');
      if (!text) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return;
      }
      e.preventDefault();
      const count = state.paste(parsed, pointer.current);
      if (count) toast.success(`Pasted ${count} node${count === 1 ? '' : 's'}`);
      else toast.error('The clipboard does not contain FlowForge nodes');
    };

    window.addEventListener('keydown', onKey);
    document.addEventListener('copy', onCopy);
    document.addEventListener('cut', onCopy);
    document.addEventListener('paste', onPaste);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('copy', onCopy);
      document.removeEventListener('cut', onCopy);
      document.removeEventListener('paste', onPaste);
    };
  }, [actions, flow, selectedEdges]);

  const hasNodes = nodes.some((n) => n.type !== STICKY_TYPE);
  const typesLoaded = useNodeTypes((s) => s.loaded);

  return (
    <div
      ref={wrapper}
      className="relative h-full w-full"
      onMouseMove={(e) => {
        pointer.current = flow.screenToFlowPosition({ x: e.clientX, y: e.clientY });
      }}
    >
      <ReactFlow
        nodes={rfNodes as never}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        defaultEdgeOptions={defaultEdgeOptions}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onConnectEnd={onConnectEnd}
        isValidConnection={isValidConnection}
        onNodeDoubleClick={(_e, node) => {
          if ((node.data as { node: INode }).node.type !== STICKY_TYPE)
            useEditor.getState().openNode(node.id);
        }}
        onPaneClick={() => setSelectedEdges(new Set())}
        nodesDraggable={!readOnly}
        nodesConnectable={!readOnly}
        elementsSelectable
        deleteKeyCode={null}
        selectionKeyCode="Shift"
        multiSelectionKeyCode={['Meta', 'Control']}
        selectionOnDrag={false}
        panOnScroll={false}
        zoomOnDoubleClick={false}
        minZoom={0.1}
        maxZoom={2.5}
        snapToGrid
        snapGrid={[20, 20]}
        fitView
        fitViewOptions={{ padding: 0.25, maxZoom: 1.1 }}
        onlyRenderVisibleElements={nodes.length > 150}
        colorMode={dark ? 'dark' : 'light'}
        proOptions={{ hideAttribution: true }}
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={20}
          size={1.4}
          color="var(--ff-canvas-dot)"
        />
        <Controls showInteractive={false} position="bottom-left" />
        <MiniMap
          pannable
          zoomable
          position="bottom-right"
          nodeStrokeWidth={3}
          nodeBorderRadius={6}
        />
      </ReactFlow>

      {!hasNodes && typesLoaded && !readOnly && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <button
            onClick={() =>
              useEditor.getState().openCreator({
                position: flow.screenToFlowPosition({
                  x: window.innerWidth / 2,
                  y: window.innerHeight / 2,
                }),
              })
            }
            className="pointer-events-auto flex flex-col items-center gap-2 rounded-xl border-2 border-dashed border-line px-10 py-8 text-muted transition-colors hover:border-accent hover:text-accent"
          >
            <Plus size={30} />
            <span className="text-sm font-medium">Add first step</span>
            <span className="text-xs">or press Tab</span>
          </button>
        </div>
      )}
    </div>
  );
}
