import { create } from 'zustand';
import type { INodeTypeDescription } from '@flowforge/workflow';
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

/** Number of outputs including the extra "error" output when continueErrorOutput is on. */
export function outputLabels(
  description: INodeTypeDescription | undefined,
  onError?: string,
): string[] {
  const base = (description?.outputs ?? [{ type: 'main' }]).map((o) => o.displayName ?? '');
  return onError === 'continueErrorOutput' ? [...base, 'error'] : base;
}
