import { create } from 'zustand';
import {
  getNodeParameters,
  randomId,
  uniqueNodeName,
  type IConnection,
  type INode,
  type INodeExecutionData,
  type INodeParameters,
  type IPinData,
  type IRunData,
  type IWorkflowSettings,
  type NodeErrorJSON,
} from '@flowforge/workflow';
import type { ExecutionDetail, WorkflowDTO } from '../lib/api';
import type { PushMessage } from '../lib/push';
import { STICKY_TYPE, isTrigger, useNodeTypes } from './nodeTypes';

export interface XY {
  x: number;
  y: number;
}

export type NodeRunState = {
  status: 'running' | 'success' | 'error' | 'canceled';
  itemCounts: number[];
  error?: { message: string; description?: string };
  runs: number;
};

export type ExecutionUiStatus = 'idle' | 'running' | 'success' | 'error' | 'canceled' | 'crashed';

interface Snapshot {
  nodes: INode[];
  connections: IConnection[];
}

export interface ClipboardData {
  nodes: INode[];
  connections: IConnection[];
}

export interface CreatorState {
  open: boolean;
  /** Connect the new node to this output. */
  source?: { nodeId: string; output: number };
  /** Insert the new node into this connection. */
  insertInto?: IConnection;
  position?: XY;
}

const GRID = 20;
const snap = (v: number) => Math.round(v / GRID) * GRID;
const HISTORY_LIMIT = 100;

interface EditorState {
  workflowId: string | null;
  name: string;
  active: boolean;
  versionId: string | null;
  settings: IWorkflowSettings;
  pinData: IPinData;
  nodes: INode[];
  connections: IConnection[];
  selection: string[];
  dirty: boolean;
  readOnly: boolean;
  openNodeId: string | null;
  creator: CreatorState;

  executionId: string | null;
  executionStatus: ExecutionUiStatus;
  nodeStatus: Record<string, NodeRunState>;
  runData: IRunData | null;
  executionError: NodeErrorJSON | null;

  past: Snapshot[];
  future: Snapshot[];
  lastHistoryKey: string | null;
  lastHistoryAt: number;

  load(
    workflow: Pick<WorkflowDTO, 'name' | 'nodes' | 'connections' | 'settings'> &
      Partial<WorkflowDTO>,
    options?: { readOnly?: boolean },
  ): void;
  reset(): void;
  markSaved(workflow: WorkflowDTO): void;
  setName(name: string): void;
  setActive(active: boolean): void;
  setSettings(settings: IWorkflowSettings): void;

  record(key?: string): void;
  undo(): void;
  redo(): void;

  addNode(
    type: string,
    options?: {
      position?: XY;
      source?: CreatorState['source'];
      insertInto?: IConnection;
      open?: boolean;
    },
  ): INode | null;
  updateNode(id: string, patch: Partial<INode>, historyKey?: string): void;
  setParameters(id: string, parameters: INodeParameters, historyKey?: string): void;
  renameNode(id: string, name: string): string | null;
  removeNodes(ids: string[]): void;
  duplicateNodes(ids: string[]): void;
  toggleDisabled(ids: string[]): void;
  setPositions(positions: Array<{ id: string; position: XY }>): void;
  connect(connection: IConnection): void;
  removeConnections(connections: IConnection[]): void;
  setSelection(ids: string[]): void;
  copySelection(): ClipboardData | null;
  paste(data: unknown, at?: XY): number;
  setPinData(nodeName: string, items: INodeExecutionData[] | null): void;

  openNode(id: string | null): void;
  openCreator(state: Omit<CreatorState, 'open'>): void;
  closeCreator(): void;

  startExecution(executionId: string): void;
  applyPush(message: PushMessage): void;
  applyExecution(detail: ExecutionDetail): void;
  clearExecution(): void;
}

const emptyExecution = {
  executionId: null,
  executionStatus: 'idle' as ExecutionUiStatus,
  nodeStatus: {},
  runData: null,
  executionError: null,
};

export const connectionKey = (c: IConnection) =>
  `${c.source}:${c.sourceOutput}->${c.target}:${c.targetInput}`;

/** Rewrite expression references when a node is renamed. */
function renameInParameters(value: unknown, from: string, to: string): unknown {
  if (typeof value === 'string' && value.startsWith('=')) {
    const esc = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return value
      .replace(
        new RegExp(`\\$node\\[(["'])${esc}\\1\\]`, 'g'),
        (_m, q: string) => `$node[${q}${to}${q}]`,
      )
      .replace(new RegExp(`\\$\\((["'])${esc}\\1\\)`, 'g'), (_m, q: string) => `$(${q}${to}${q})`);
  }
  if (Array.isArray(value)) return value.map((v) => renameInParameters(v, from, to));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, renameInParameters(v, from, to)]),
    );
  }
  return value;
}

function nodeStatusFromRunData(runData: IRunData): Record<string, NodeRunState> {
  const out: Record<string, NodeRunState> = {};
  for (const [name, runs] of Object.entries(runData)) {
    const last = runs[runs.length - 1];
    if (!last) continue;
    const itemCounts: number[] = [];
    for (const run of runs) {
      (run.data?.main ?? []).forEach((items, i) => {
        itemCounts[i] = (itemCounts[i] ?? 0) + (items?.length ?? 0);
      });
    }
    out[name] = {
      status: last.executionStatus,
      itemCounts,
      runs: runs.length,
      error: last.error
        ? { message: last.error.message, description: last.error.description }
        : undefined,
    };
  }
  return out;
}

export const useEditor = create<EditorState>((set, get) => ({
  workflowId: null,
  name: 'My workflow',
  active: false,
  versionId: null,
  settings: {},
  pinData: {},
  nodes: [],
  connections: [],
  selection: [],
  dirty: false,
  readOnly: false,
  openNodeId: null,
  creator: { open: false },
  ...emptyExecution,
  past: [],
  future: [],
  lastHistoryKey: null,
  lastHistoryAt: 0,

  load(workflow, options = {}) {
    set({
      workflowId: workflow.id ?? null,
      name: workflow.name,
      active: workflow.active ?? false,
      versionId: workflow.versionId ?? null,
      settings: workflow.settings ?? {},
      pinData: workflow.pinData ?? {},
      nodes: workflow.nodes,
      connections: workflow.connections,
      selection: [],
      dirty: false,
      readOnly: options.readOnly ?? false,
      openNodeId: null,
      creator: { open: false },
      ...emptyExecution,
      past: [],
      future: [],
      lastHistoryKey: null,
    });
  },

  reset() {
    get().load({ name: 'My workflow', nodes: [], connections: [], settings: {} });
  },

  markSaved(workflow) {
    set({
      workflowId: workflow.id,
      versionId: workflow.versionId,
      active: workflow.active,
      dirty: false,
    });
  },

  setName(name) {
    set({ name, dirty: true });
  },
  setActive(active) {
    set({ active });
  },
  setSettings(settings) {
    set({ settings, dirty: true });
  },

  record(key) {
    const state = get();
    const now = Date.now();
    // Merge rapid edits of the same field (typing) into one undo step.
    if (key && key === state.lastHistoryKey && now - state.lastHistoryAt < 1000) {
      set({ lastHistoryAt: now });
      return;
    }
    const past = [...state.past, { nodes: state.nodes, connections: state.connections }].slice(
      -HISTORY_LIMIT,
    );
    set({ past, future: [], lastHistoryKey: key ?? null, lastHistoryAt: now });
  },

  undo() {
    const { past, future, nodes, connections } = get();
    const previous = past[past.length - 1];
    if (!previous) return;
    set({
      past: past.slice(0, -1),
      future: [{ nodes, connections }, ...future].slice(0, HISTORY_LIMIT),
      nodes: previous.nodes,
      connections: previous.connections,
      dirty: true,
      lastHistoryKey: null,
    });
  },

  redo() {
    const { past, future, nodes, connections } = get();
    const next = future[0];
    if (!next) return;
    set({
      past: [...past, { nodes, connections }],
      future: future.slice(1),
      nodes: next.nodes,
      connections: next.connections,
      dirty: true,
      lastHistoryKey: null,
    });
  },

  addNode(type, options = {}) {
    const description = useNodeTypes.getState().byName[type];
    if (!description) return null;
    const state = get();
    if (state.readOnly) return null;
    if (
      description.maxNodes &&
      state.nodes.filter((n) => n.type === type).length >= description.maxNodes
    ) {
      return null;
    }

    let position = options.position ?? { x: 0, y: 0 };
    const source = options.source
      ? state.nodes.find((n) => n.id === options.source!.nodeId)
      : undefined;
    if (source && !options.position) {
      const siblings = state.connections.filter(
        (c) => c.source === source.id && c.sourceOutput === options.source!.output,
      ).length;
      position = {
        x: source.position[0] + 220,
        y: source.position[1] + options.source!.output * 120 + siblings * 140,
      };
    }
    if (options.insertInto) {
      const from = state.nodes.find((n) => n.id === options.insertInto!.source);
      const to = state.nodes.find((n) => n.id === options.insertInto!.target);
      if (from && to && !options.position) {
        position = {
          x: (from.position[0] + to.position[0]) / 2,
          y: (from.position[1] + to.position[1]) / 2,
        };
      }
    }

    const isSticky = type === STICKY_TYPE;
    const node: INode = {
      id: randomId(),
      name: uniqueNodeName(
        description.defaults.name,
        state.nodes.map((n) => n.name),
      ),
      type,
      typeVersion: description.version,
      position: [snap(position.x), snap(position.y)],
      parameters: getNodeParameters(description.properties, {}),
      ...(isSticky ? { width: 260, height: 180 } : {}),
    };

    state.record();
    let connections = state.connections;
    if (options.source && description.inputs.length > 0) {
      connections = [
        ...connections,
        {
          source: options.source.nodeId,
          sourceOutput: options.source.output,
          target: node.id,
          targetInput: 0,
        },
      ];
    }
    if (options.insertInto && description.inputs.length > 0 && description.outputs.length > 0) {
      const old = options.insertInto;
      connections = [
        ...connections.filter((c) => connectionKey(c) !== connectionKey(old)),
        { source: old.source, sourceOutput: old.sourceOutput, target: node.id, targetInput: 0 },
        { source: node.id, sourceOutput: 0, target: old.target, targetInput: old.targetInput },
      ];
    }
    const open =
      options.open ?? (!isSticky && description.properties.some((p) => p.type !== 'notice'));
    set({
      nodes: [...state.nodes, node],
      connections,
      selection: [node.id],
      dirty: true,
      openNodeId: open && !isTrigger(description) ? node.id : state.openNodeId,
      creator: { open: false },
    });
    return node;
  },

  updateNode(id, patch, historyKey) {
    const state = get();
    if (state.readOnly) return;
    state.record(historyKey ?? `node:${id}:${Object.keys(patch).join(',')}`);
    set({ nodes: state.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n)), dirty: true });
  },

  setParameters(id, parameters, historyKey) {
    const state = get();
    const node = state.nodes.find((n) => n.id === id);
    if (!node || state.readOnly) return;
    const description = useNodeTypes.getState().byName[node.type];
    const normalised = description
      ? getNodeParameters(description.properties, parameters)
      : parameters;
    state.record(historyKey ?? `params:${id}`);
    set({
      nodes: state.nodes.map((n) => (n.id === id ? { ...n, parameters: normalised } : n)),
      dirty: true,
    });
  },

  renameNode(id, rawName) {
    const state = get();
    const node = state.nodes.find((n) => n.id === id);
    const name = rawName.trim();
    if (!node || !name || name === node.name || state.readOnly) return node?.name ?? null;
    if (state.nodes.some((n) => n.name === name)) return null;
    const from = node.name;
    state.record();
    const pinData = { ...state.pinData };
    if (pinData[from]) {
      pinData[name] = pinData[from]!;
      delete pinData[from];
    }
    const rename = <T>(record: Record<string, T> | null) => {
      if (!record || !(from in record)) return record;
      const { [from]: value, ...rest } = record;
      return { ...rest, [name]: value } as Record<string, T>;
    };
    set({
      nodes: state.nodes.map((n) =>
        n.id === id
          ? { ...n, name }
          : { ...n, parameters: renameInParameters(n.parameters, from, name) as INodeParameters },
      ),
      pinData,
      nodeStatus: rename(state.nodeStatus) ?? {},
      runData: rename(state.runData),
      dirty: true,
    });
    return name;
  },

  removeNodes(ids) {
    const state = get();
    if (state.readOnly || ids.length === 0) return;
    const remove = new Set(ids);
    state.record();
    let connections = state.connections.filter(
      (c) => !remove.has(c.source) && !remove.has(c.target),
    );
    // Deleting a single node in the middle of a chain reconnects its neighbours.
    if (ids.length === 1) {
      const incoming = state.connections.filter((c) => c.target === ids[0]);
      const outgoing = state.connections.filter((c) => c.source === ids[0]);
      if (incoming.length === 1 && outgoing.length === 1) {
        const bridge = {
          source: incoming[0]!.source,
          sourceOutput: incoming[0]!.sourceOutput,
          target: outgoing[0]!.target,
          targetInput: outgoing[0]!.targetInput,
        };
        if (!connections.some((c) => connectionKey(c) === connectionKey(bridge)))
          connections = [...connections, bridge];
      }
    }
    const removedNames = new Set(state.nodes.filter((n) => remove.has(n.id)).map((n) => n.name));
    const pinData = Object.fromEntries(
      Object.entries(state.pinData).filter(([k]) => !removedNames.has(k)),
    );
    set({
      nodes: state.nodes.filter((n) => !remove.has(n.id)),
      connections,
      pinData,
      selection: state.selection.filter((id) => !remove.has(id)),
      openNodeId: state.openNodeId && remove.has(state.openNodeId) ? null : state.openNodeId,
      dirty: true,
    });
  },

  duplicateNodes(ids) {
    const state = get();
    const picked = new Set(ids);
    const nodes = state.nodes.filter((n) => picked.has(n.id));
    const connections = state.connections.filter(
      (c) => picked.has(c.source) && picked.has(c.target),
    );
    if (nodes.length) state.paste({ nodes, connections });
  },

  toggleDisabled(ids) {
    const state = get();
    if (state.readOnly || ids.length === 0) return;
    const targets = state.nodes.filter((n) => ids.includes(n.id) && n.type !== STICKY_TYPE);
    const disable = targets.some((n) => !n.disabled);
    state.record();
    set({
      nodes: state.nodes.map((n) =>
        targets.includes(n) ? { ...n, disabled: disable || undefined } : n,
      ),
      dirty: true,
    });
  },

  setPositions(positions) {
    const state = get();
    if (state.readOnly || positions.length === 0) return;
    const byId = new Map(positions.map((p) => [p.id, p.position]));
    state.record();
    set({
      nodes: state.nodes.map((n) => {
        const p = byId.get(n.id);
        return p ? { ...n, position: [snap(p.x), snap(p.y)] as [number, number] } : n;
      }),
      dirty: true,
    });
  },

  connect(connection) {
    const state = get();
    if (state.readOnly || connection.source === connection.target) return;
    if (state.connections.some((c) => connectionKey(c) === connectionKey(connection))) return;
    state.record();
    set({ connections: [...state.connections, connection], dirty: true });
  },

  removeConnections(list) {
    const state = get();
    if (state.readOnly || list.length === 0) return;
    const keys = new Set(list.map(connectionKey));
    state.record();
    set({ connections: state.connections.filter((c) => !keys.has(connectionKey(c))), dirty: true });
  },

  setSelection(ids) {
    const current = get().selection;
    if (current.length === ids.length && current.every((id, i) => id === ids[i])) return;
    set({ selection: ids });
  },

  copySelection() {
    const { nodes, connections, selection } = get();
    const ids = new Set(selection);
    const picked = nodes.filter((n) => ids.has(n.id));
    if (picked.length === 0) return null;
    return {
      nodes: picked,
      connections: connections.filter((c) => ids.has(c.source) && ids.has(c.target)),
    };
  },

  paste(data, at) {
    const state = get();
    if (state.readOnly) return 0;
    const input = data as Partial<ClipboardData> | null;
    if (!input || !Array.isArray(input.nodes) || input.nodes.length === 0) return 0;
    const byName = useNodeTypes.getState().byName;
    const incoming = input.nodes.filter((n): n is INode =>
      Boolean(n && typeof n.type === 'string' && Array.isArray(n.position) && n.name),
    );
    const names = state.nodes.map((n) => n.name);
    const idMap = new Map<string, string>();
    const nameMap = new Map<string, string>();
    const minX = Math.min(...incoming.map((n) => n.position[0]));
    const minY = Math.min(...incoming.map((n) => n.position[1]));
    const offset = at ? { x: at.x - minX, y: at.y - minY } : { x: 40, y: 40 };

    const added: INode[] = [];
    for (const original of incoming) {
      const description = byName[original.type];
      if (description?.maxNodes) {
        const count = [...state.nodes, ...added].filter((n) => n.type === original.type).length;
        if (count >= description.maxNodes) continue;
      }
      const id = randomId();
      const name = uniqueNodeName(original.name, names);
      names.push(name);
      idMap.set(original.id, id);
      nameMap.set(original.name, name);
      added.push({
        ...structuredClone(original),
        id,
        name,
        position: [snap(original.position[0] + offset.x), snap(original.position[1] + offset.y)],
      });
    }
    for (const node of added) {
      for (const [from, to] of nameMap) {
        if (from !== to)
          node.parameters = renameInParameters(node.parameters, from, to) as INodeParameters;
      }
    }
    const connections = (input.connections ?? [])
      .filter((c) => idMap.has(c.source) && idMap.has(c.target))
      .map((c) => ({ ...c, source: idMap.get(c.source)!, target: idMap.get(c.target)! }));
    if (added.length === 0) return 0;
    state.record();
    set({
      nodes: [...state.nodes, ...added],
      connections: [...state.connections, ...connections],
      selection: added.map((n) => n.id),
      dirty: true,
    });
    return added.length;
  },

  setPinData(nodeName, items) {
    const state = get();
    const pinData = { ...state.pinData };
    if (items) pinData[nodeName] = items;
    else delete pinData[nodeName];
    set({ pinData, dirty: true });
  },

  openNode(id) {
    set({ openNodeId: id, creator: { open: false } });
  },
  openCreator(creator) {
    if (get().readOnly) return;
    set({ creator: { ...creator, open: true } });
  },
  closeCreator() {
    set({ creator: { open: false } });
  },

  startExecution(executionId) {
    set({
      executionId,
      executionStatus: 'running',
      nodeStatus: {},
      runData: null,
      executionError: null,
    });
  },

  applyPush(message) {
    const state = get();
    if (!('data' in message) || !message.data || !('executionId' in message.data)) return;
    if (message.data.executionId !== state.executionId) return;
    switch (message.type) {
      case 'nodeExecuteBefore': {
        const prev = state.nodeStatus[message.data.nodeName];
        set({
          nodeStatus: {
            ...state.nodeStatus,
            [message.data.nodeName]: {
              status: 'running',
              itemCounts: prev?.itemCounts ?? [],
              runs: prev?.runs ?? 0,
            },
          },
        });
        break;
      }
      case 'nodeExecuteAfter': {
        const prev = state.nodeStatus[message.data.nodeName];
        const itemCounts = message.data.itemCounts.map(
          (n, i) => n + (prev?.runs ? (prev.itemCounts[i] ?? 0) : 0),
        );
        set({
          nodeStatus: {
            ...state.nodeStatus,
            [message.data.nodeName]: {
              status: message.data.status,
              itemCounts,
              error: message.data.error,
              runs: (prev?.runs ?? 0) + 1,
            },
          },
        });
        break;
      }
      case 'executionFinished':
        set({ executionStatus: message.data.status as ExecutionUiStatus });
        break;
    }
  },

  applyExecution(detail) {
    const runData = detail.data?.resultData.runData ?? {};
    set({
      executionId: detail.id,
      executionStatus: detail.running ? 'running' : (detail.status as ExecutionUiStatus),
      runData,
      nodeStatus: nodeStatusFromRunData(runData),
      executionError: detail.data?.resultData.error ?? null,
    });
  },

  clearExecution() {
    set({ ...emptyExecution });
  },
}));

/** Selector helpers */
export const selectNodeById = (id: string | null) => (s: EditorState) =>
  id ? s.nodes.find((n) => n.id === id) : undefined;
