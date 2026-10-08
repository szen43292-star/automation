import { spawn } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { dirname } from 'node:path';

export type Logger = (message: string) => void;

export const exe = (name: string) => (process.platform === 'win32' ? `${name}.exe` : name);

/** Keep log files bounded: once a file passes `maxBytes` it moves to `<file>.1`. */
export function rotateLog(file: string, maxBytes = 5 * 1024 * 1024): void {
  mkdirSync(dirname(file), { recursive: true });
  if (existsSync(file) && statSync(file).size > maxBytes) {
    rmSync(`${file}.1`, { force: true });
    renameSync(file, `${file}.1`);
  }
}

/** Last lines of a log file, for error messages. */
export function tail(file: string, lines = 15): string {
  try {
    return readFileSync(file, 'utf8').trimEnd().split(/\r?\n/).slice(-lines).join('\n');
  } catch {
    return '';
  }
}

export function isPortFree(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.listen(port, host, () => server.close(() => resolve(true)));
  });
}

export function freePort(host = '127.0.0.1'): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, host, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

/**
 * Runs a tool to completion with its output appended to a log file. Output goes to a file rather
 * than a pipe because pg_ctl leaves the server running with inherited handles: a pipe would never close.
 */
export function run(
  command: string,
  args: string[],
  options: { logFile: string; env?: NodeJS.ProcessEnv; cwd?: string; timeoutMs?: number },
): Promise<{ code: number }> {
  rotateLog(options.logFile);
  const fd = openSync(options.logFile, 'a');
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['ignore', fd, fd],
      windowsHide: true,
    });
    const timer = setTimeout(() => child.kill(), options.timeoutMs ?? 120_000);
    const done = () => {
      clearTimeout(timer);
      closeSync(fd);
    };
    child.once('error', (error) => {
      done();
      reject(error);
    });
    child.once('exit', (code, signal) => {
      done();
      resolve({ code: code ?? (signal ? 1 : 0) });
    });
  });
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
