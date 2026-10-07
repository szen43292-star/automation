import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const server = process.env.FLOWFORGE_SERVER ?? 'http://localhost:5678';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Desktop (Tauri) and mobile (Capacitor) builds use FLOWFORGE_BASE=./ with VITE_ROUTER=hash.
  base: process.env.FLOWFORGE_BASE ?? '/',
  server: {
    port: 5173,
    proxy: {
      '/api': { target: server, ws: true, changeOrigin: true },
      '/healthz': server,
    },
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2000,
  },
});
