import { create } from 'zustand';

export type ThemeMode = 'light' | 'dark' | 'system';

const media =
  typeof window !== 'undefined' ? window.matchMedia('(prefers-color-scheme: dark)') : null;

function apply(mode: ThemeMode) {
  const dark = mode === 'dark' || (mode === 'system' && Boolean(media?.matches));
  document.documentElement.classList.toggle('dark', dark);
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', dark ? '#0e1015' : '#f5f6f8');
  return dark;
}

function initial(): ThemeMode {
  try {
    return (localStorage.getItem('ff.theme') as ThemeMode | null) ?? 'system';
  } catch {
    return 'system';
  }
}

export const useTheme = create<{ mode: ThemeMode; dark: boolean; setMode(mode: ThemeMode): void }>(
  (set) => {
    const mode = initial();
    media?.addEventListener('change', () => {
      const current = useTheme.getState().mode;
      if (current === 'system') set({ dark: apply('system') });
    });
    return {
      mode,
      dark: typeof document !== 'undefined' ? apply(mode) : false,
      setMode(next) {
        try {
          localStorage.setItem('ff.theme', next);
        } catch {
          /* ignore */
        }
        set({ mode: next, dark: apply(next) });
      },
    };
  },
);
