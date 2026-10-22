import { create } from 'zustand';
import { endpoints, setToken, getToken, type User } from '../lib/api';
import { push } from '../lib/push';

interface AuthState {
  user: User | null;
  status: 'loading' | 'authenticated' | 'anonymous';
  init(): Promise<void>;
  setSession(token: string, user: User): void;
  logout(): void;
}

export const useAuth = create<AuthState>((set) => ({
  user: null,
  status: 'loading',
  async init() {
    if (!getToken()) {
      set({ status: 'anonymous', user: null });
      return;
    }
    try {
      const { user } = await endpoints.me();
      if (!user) throw new Error('No user');
      set({ user, status: 'authenticated' });
      push.start();
    } catch {
      setToken(null);
      set({ status: 'anonymous', user: null });
    }
  },
  setSession(token, user) {
    setToken(token);
    set({ user, status: 'authenticated' });
    push.stop();
    push.start();
  },
  logout() {
    setToken(null);
    push.stop();
    set({ user: null, status: 'anonymous' });
  },
}));
