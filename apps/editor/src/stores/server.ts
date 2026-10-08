import { create } from 'zustand';
import type { IDataObject } from '@flowforge/workflow';
import { endpoints, type ServerSettings } from '../lib/api';

interface ServerState {
  settings: ServerSettings | null;
  vars: IDataObject;
  load(): Promise<void>;
  reloadVars(): Promise<void>;
}

/** Server settings (public URL for webhooks, OAuth callback) and $vars for previews. */
export const useServer = create<ServerState>((set, get) => ({
  settings: null,
  vars: {},
  async load() {
    if (get().settings) return;
    const [settings] = await Promise.all([endpoints.settings(), get().reloadVars()]);
    set({ settings });
  },
  async reloadVars() {
    const { data } = await endpoints.variables().catch(() => ({ data: [] }));
    set({ vars: Object.fromEntries(data.map((v) => [v.key, v.value])) });
  },
}));
