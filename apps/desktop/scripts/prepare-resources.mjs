// Collects everything the desktop app runs into apps/desktop/resources, for the current OS:
//   node/      the Node.js binary running this script (the same one that installed native modules)
//   server/    the FlowForge server with production node_modules and a generated Prisma client
//   editor/    the built editor
//   postgres/  PostgreSQL binaries (from @embedded-postgres/<os>-x64)
// electron-builder then ships the folder as resources/runtime.
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoDir = resolve(desktopDir, '../..');
const out = join(desktopDir, 'resources');
const isWindows = process.platform === 'win32';
const exe = (name) => (isWindows ? `${name}.exe` : name);

function sh(command, args, cwd = repoDir) {
  console.log(`> ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', shell: isWindows });
  if (result.status !== 0)
    throw new Error(`${command} ${args.join(' ')} failed (${result.status})`);
}

/** Remove files and folders below `dir` matching `test(relativePath, name, isDirectory)`. */
function prune(dir, test, base = dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    const relative = path.slice(base.length + 1).replaceAll('\\', '/');
    if (test(relative, entry.name, entry.isDirectory()))
      rmSync(path, { recursive: true, force: true });
    else if (entry.isDirectory()) prune(path, test, base);
  }
}

function size(path) {
  const stat = lstatSync(path);
  if (!stat.isDirectory()) return stat.size;
  return readdirSync(path).reduce((total, name) => total + size(join(path, name)), 0);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// 1. Build the editor and the server.
sh('pnpm', ['--filter', '@flowforge/editor', '--filter', '@flowforge/server', 'build']);

// 2. Node.js
mkdirSync(join(out, 'node'));
cpSync(process.execPath, join(out, 'node', exe('node')));

// 3. Editor
cpSync(join(repoDir, 'apps/editor/dist'), join(out, 'editor'), { recursive: true });

// 4. Server: production dependencies only, as plain folders (no symlinks) so the installer can copy them.
const serverOut = join(out, 'server');
sh('pnpm', [
  '--config.node-linker=hoisted',
  '--filter',
  '@flowforge/server',
  'deploy',
  '--prod',
  '--legacy',
  serverOut,
]);
sh(
  'node',
  [
    join(serverOut, 'node_modules/prisma/build/index.js'),
    'generate',
    '--schema',
    join(serverOut, 'prisma/schema.prisma'),
  ],
  serverOut,
);
prune(join(serverOut, 'dist'), (_, name) => name.endsWith('.map'));
prune(join(serverOut, 'node_modules'), (_, name, isDir) =>
  isDir
    ? ['__tests__', 'docs', 'examples'].includes(name)
    : /\.(map|md|markdown|tsbuildinfo)$/i.test(name),
);
// Prisma ships engines and runtimes for every database and platform; keep what a Node server on this OS uses.
prune(join(serverOut, 'node_modules/@prisma/client/runtime'), (_, name) =>
  /wasm|^edge|^react-native/.test(name),
);
prune(
  join(serverOut, 'node_modules/.prisma/client'),
  (_, name) =>
    /\.wasm$|^wasm|^edge|^react-native/.test(name) ||
    (isWindows ? /\.so\.node$/.test(name) : /musl/.test(name)),
);
for (const cli of ['prisma', '@prisma/engines']) {
  // The CLI (used for `migrate deploy`) re-downloads engines it can't find, so only other platforms' go.
  prune(
    join(serverOut, 'node_modules', cli),
    (relative, name) =>
      !relative.includes('/') && (isWindows ? /\.so\.node$/.test(name) : /musl/.test(name)),
  );
}
for (const unused of ['typescript', '.bin'])
  rmSync(join(serverOut, 'node_modules', unused), { recursive: true, force: true });
// Drop the other isolated-vm prebuilds.
prune(
  join(serverOut, 'node_modules/isolated-vm/prebuilds'),
  (relative, name, isDir) =>
    isDir && !relative.includes('/') && name !== `${process.platform}-${process.arch}`,
);

// 5. PostgreSQL
const pgPackage = `@embedded-postgres/${isWindows ? 'windows' : process.platform}-${process.arch}`;
const pgNative = join(desktopDir, 'node_modules', pgPackage, 'native');
if (!existsSync(pgNative))
  throw new Error(
    `${pgPackage} is not installed (run pnpm install on ${process.platform}-${process.arch})`,
  );
const pgOut = join(out, 'postgres');
cpSync(pgNative, pgOut, { recursive: true, dereference: true });
prune(pgOut, (relative, name, isDir) =>
  isDir
    ? relative === 'include' ||
      relative === 'doc' ||
      relative.endsWith('/pgxs') ||
      relative === 'share/doc' ||
      relative === 'share/man'
    : /\.(a|lib|pdb)$/.test(name) ||
      /^wx.*\.dll$/i.test(name) ||
      name === 'testplug.dll' ||
      name === 'pg-symlinks.json',
);
if (isWindows) {
  // The PostgreSQL build needs the Visual C++ runtime; ship it app-locally (allowed by its licence)
  // so it works on PCs that never installed the redistributable.
  const system32 = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
  for (const dll of ['vcruntime140.dll', 'vcruntime140_1.dll', 'msvcp140.dll']) {
    if (existsSync(join(system32, dll))) cpSync(join(system32, dll), join(pgOut, 'bin', dll));
  }
}

// Private builds: keys from the environment (GitHub secrets in CI) are built into the app, so it
// needs no setup. Only these names are taken; nothing is written when none are set.
const BUNDLED = [
  'META_APP_ID',
  'META_APP_SECRET',
  'META_EMBEDDED_SIGNUP_CONFIG_ID',
  'WHATSAPP_WEBHOOK_VERIFY_TOKEN',
  'PUBLIC_URL',
  'OPENAI_API_KEY',
  'DEEPGRAM_API_KEY',
  'ELEVENLABS_API_KEY',
  'SARVAM_API_KEY',
  'GEMINI_API_KEY',
  'ANTHROPIC_API_KEY',
  'UPDATE_GITHUB_TOKEN',
];
const bundled = Object.fromEntries(
  BUNDLED.map((key) => [key, process.env[`BUNDLE_${key}`]?.trim()]).filter(([, value]) => value),
);
if (Object.keys(bundled).length) {
  writeFileSync(join(out, 'config.json'), JSON.stringify({ env: bundled }, null, 2));
  console.log(`Built in: ${Object.keys(bundled).join(', ')}`);
}

writeFileSync(
  join(out, 'runtime.json'),
  JSON.stringify(
    {
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      builtAt: new Date().toISOString(),
    },
    null,
    2,
  ),
);

for (const name of ['node', 'server', 'editor', 'postgres']) {
  console.log(`${name.padEnd(9)} ${(size(join(out, name)) / 1024 / 1024).toFixed(1)} MB`);
}
console.log(`Runtime ready in ${out}`);
