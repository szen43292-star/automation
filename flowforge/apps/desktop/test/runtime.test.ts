import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkResources, loadBundledConfig, loadSecrets } from '../src/runtime';
import { freePort, isPortFree, rotateLog, run, tail } from '../src/runtime/util';

const dirs: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'ff-desktop-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('secrets', () => {
  it('are generated once and then reused, so credentials stay decryptable', () => {
    const dir = tempDir();
    const first = loadSecrets(dir);
    expect(first.encryptionKey).toMatch(/^[0-9a-f]{64}$/);
    expect(first.jwtSecret.length).toBeGreaterThanOrEqual(64);
    expect(first.databasePassword).not.toBe(first.encryptionKey);
    expect(loadSecrets(dir)).toEqual(first);
    if (process.platform !== 'win32')
      expect(statSync(join(dir, 'secrets.json')).mode & 0o777).toBe(0o600);
  });
});

describe('resources check', () => {
  it('names every missing part of the bundled runtime', () => {
    expect(() => checkResources(tempDir())).toThrow(/missing .*node.*server.*editor.*pg_ctl/s);
  });
});

describe('ports', () => {
  it('finds free ports and detects busy ones', async () => {
    const port = await freePort();
    expect(port).toBeGreaterThan(0);
    expect(await isPortFree(port)).toBe(true);
    const server = createServer().listen(port, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    expect(await isPortFree(port)).toBe(false);
    await new Promise((resolve) => server.close(resolve));
  });
});

describe('run', () => {
  it('appends tool output to a log file and reports the exit code', async () => {
    const log = join(tempDir(), 'logs', 'tool.log');
    const ok = await run(process.execPath, ['-e', 'console.log("hello"); console.error("oops")'], {
      logFile: log,
    });
    expect(ok.code).toBe(0);
    const failed = await run(process.execPath, ['-e', 'process.exit(3)'], { logFile: log });
    expect(failed.code).toBe(3);
    expect(readFileSync(log, 'utf8')).toContain('hello');
    expect(tail(log)).toContain('oops');
  });

  it('stops tools that hang', async () => {
    const log = join(tempDir(), 'tool.log');
    const started = Date.now();
    const result = await run(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
      logFile: log,
      timeoutMs: 300,
    });
    expect(result.code).not.toBe(0);
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

describe('log rotation', () => {
  it('moves large logs aside', () => {
    const file = join(tempDir(), 'server.log');
    writeFileSync(file, 'x'.repeat(2000));
    rotateLog(file, 1000);
    expect(readFileSync(`${file}.1`, 'utf8')).toHaveLength(2000);
    rotateLog(file, 1000); // nothing to rotate now
    expect(tail(`${file}.1`)).toHaveLength(2000);
  });
});

describe('private builds', () => {
  it('passes only known keys to the server and keeps the update token for the updater', () => {
    const dir = tempDir();
    expect(loadBundledConfig(dir)).toEqual({ env: {}, updateToken: null, updateUrl: null });
    writeFileSync(
      join(dir, 'config.json'),
      JSON.stringify({
        env: {
          META_APP_ID: '123',
          META_APP_SECRET: ' secret ',
          OPENAI_API_KEY: '',
          DATABASE_URL: 'postgresql://evil',
          UPDATE_GITHUB_TOKEN: 'github_pat_x',
          UPDATE_URL: 'https://my-flowforge.vercel.app/',
        },
      }),
    );
    expect(loadBundledConfig(dir)).toEqual({
      env: { META_APP_ID: '123', META_APP_SECRET: 'secret' },
      updateToken: 'github_pat_x',
      updateUrl: 'https://my-flowforge.vercel.app',
    });
    // Only an https address is used for updates.
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ env: { UPDATE_URL: 'http://x' } }));
    expect(loadBundledConfig(dir).updateUrl).toBeNull();
    writeFileSync(join(dir, 'config.json'), '{ broken');
    expect(loadBundledConfig(dir).env).toEqual({});
  });
});
