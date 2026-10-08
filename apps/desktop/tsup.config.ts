import { defineConfig } from 'tsup';

export default defineConfig({
  // main: the Electron app. smoke: starts the bundled runtime with plain Node (used in CI and tests).
  entry: { main: 'src/main.ts', smoke: 'src/smoke.ts' },
  format: ['cjs'],
  outExtension: () => ({ js: '.cjs' }),
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  clean: true,
  // Everything except Electron itself is bundled, so the packaged app needs no node_modules.
  external: ['electron'],
  noExternal: [/^(?!electron$)/],
  publicDir: 'src/assets',
});
