import { create } from 'zustand';
import { resolveNodeOutputs, type INode, type INodeTypeDescription } from '@flowforge/workflow';
import { endpoints } from '../lib/api';

interface NodeTypesState {
  list: INodeTypeDescription[];
  byName: Record<string, INodeTypeDescription>;
  loaded: boolean;
  load(): Promise<void>;
}

export const useNodeTypes = create<NodeTypesState>((set, get) => ({
  list: [],
  byName: {},
  loaded: false,
  async load() {
    if (get().loaded) return;
    const { data } = await endpoints.nodeTypes();
    set({ list: data, byName: Object.fromEntries(data.map((d) => [d.name, d])), loaded: true });
  },
}));

export const STICKY_TYPE = 'flowforge.stickyNote';
export const MANUAL_TRIGGER = 'flowforge.manualTrigger';

export function isTrigger(description: INodeTypeDescription | undefined): boolean {
  return Boolean(description?.group.includes('trigger'));
}

/** Output labels including dynamic outputs (Switch) and the extra "error" output. */
export function outputLabels(
  description: INodeTypeDescription | undefined,
  node: Pick<INode, 'parameters' | 'onError'>,
): string[] {
  const outputs = description
    ? resolveNodeOutputs(description, node.parameters)
    : [{ type: 'main' as const }];
  const base = outputs.map((o) => o.displayName ?? '');
  return node.onError === 'continueErrorOutput' ? [...base, 'error'] : base;
}
