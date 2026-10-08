import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const require = createRequire(import.meta.url);
const server = process.env.FLOWFORGE_SERVER ?? 'http://localhost:5678';

/** `virtual:luxon-global`: luxon's browser build as a string, for the expression preview sandbox. */
function luxonGlobal(): Plugin {
  const id = 'virtual:luxon-global';
  return {
    name: 'flowforge-luxon-global',
    resolveId: (source) => (source === id ? `\0${id}` : undefined),
    load(resolved) {
      if (resolved !== `\0${id}`) return undefined;
      // luxon's global build is not listed in its package "exports", so resolve it next to the main entry.
      const file = join(dirname(require.resolve('luxon')), '../global/luxon.min.js');
      return `export default ${JSON.stringify(readFileSync(file, 'utf8'))};`;
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), luxonGlobal()],
  // Desktop (Tauri) and mobile (Capacitor) builds use FLOWFORGE_BASE=./ with VITE_ROUTER=hash.
  base: process.env.FLOWFORGE_BASE ?? '/',
  server: {
    port: 5173,
    proxy: {
      '/api': { target: server, ws: true, changeOrigin: true },
      '/webhook': server,
      '/webhook-test': server,
      '/rest': server,
      '/healthz': server,
    },
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2000,
  },
});
