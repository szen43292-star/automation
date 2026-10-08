// Builds the editor for the mobile app into www/ (hash routing, relative asset paths) and writes
// the server address into it.
//   MOBILE_SERVER_URL=https://flow.example.com node scripts/build-web.mjs
// Private builds: BUNDLE_PUBLIC_URL (the PUBLIC_URL secret) is used when MOBILE_SERVER_URL is not
// set. Without either, the app asks for the server address on first start.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const mobileDir = resolve(here, '..');
const editorDir = resolve(mobileDir, '../editor');
const out = join(mobileDir, 'www');

export function serverUrlFrom(env) {
  const raw = (env.MOBILE_SERVER_URL || env.BUNDLE_PUBLIC_URL || '').trim().replace(/\/+$/, '');
  if (!raw) return '';
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`MOBILE_SERVER_URL is not a URL: ${raw}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    throw new Error(`MOBILE_SERVER_URL must start with https:// (got ${raw})`);
  return url.toString().replace(/\/+$/, '');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const serverUrl = serverUrlFrom(process.env);
  console.log(
    `Building the editor for mobile${serverUrl ? ` (server ${serverUrl})` : ' (server asked on first start)'}`,
  );
  const vite = join(
    editorDir,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'vite.cmd' : 'vite',
  );
  if (!existsSync(vite)) throw new Error('Run pnpm install first');
  execFileSync(vite, ['build', '--outDir', out, '--emptyOutDir'], {
    cwd: editorDir,
    stdio: 'inherit',
    env: {
      ...process.env,
      FLOWFORGE_BASE: './',
      VITE_ROUTER: 'hash',
      VITE_PLATFORM: 'mobile',
      VITE_DEFAULT_SERVER_URL: serverUrl,
    },
    shell: process.platform === 'win32',
  });
}
