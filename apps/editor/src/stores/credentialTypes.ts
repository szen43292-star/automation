import { create } from 'zustand';
import type { ICredentialType } from '@flowforge/workflow';
import { endpoints } from '../lib/api';

export const useCredentialTypes = create<{
  byName: Record<string, ICredentialType>;
  list: ICredentialType[];
  load(): Promise<void>;
}>((set, get) => ({
  byName: {},
  list: [],
  async load() {
    if (get().list.length) return;
    const { data } = await endpoints.credentialTypes();
    set({ list: data, byName: Object.fromEntries(data.map((t) => [t.name, t])) });
  },
}));
