import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { freePort, isPortFree, rotateLog, run, sleep, tail, type Logger } from './util';

export interface ServerOptions {
  nodePath: string;
  /** The deployed server package: dist/, prisma/, node_modules/. */
  serverDir: string;
  editorDir: string;
  logDir: string;
  databaseUrl: string;
  jwtSecret: string;
  encryptionKey: string;
  preferredPort: number;
  log: Logger;
}

/** Runs the FlowForge server (API, editor, webhooks, schedules) as a child Node process. */
export class ServerProcess {
  port = 0;
  private child: ChildProcess | null = null;
  private readonly logFile: string;

  constructor(private readonly options: ServerOptions) {
    this.logFile = join(options.logDir, 'server.log');
  }

  get url(): string {
    return `http://localhost:${this.port}`;
  }

  private env(): NodeJS.ProcessEnv {
    const { databaseUrl, jwtSecret, encryptionKey, editorDir } = this.options;
    return {
      ...process.env,
      // Electron sets this for its own helpers; it must not leak into a plain Node child.
      ELECTRON_RUN_AS_NODE: undefined,
      NODE_ENV: 'production',
      DATABASE_URL: databaseUrl,
      JWT_SECRET: jwtSecret,
      ENCRYPTION_KEY: encryptionKey,
      EDITOR_DIST: editorDir,
      HOST: '127.0.0.1',
      PORT: String(this.port),
      PUBLIC_URL: this.url,
      EXECUTIONS_MODE: 'regular',
      DEFAULT_TIMEZONE: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      LOG_LEVEL: 'info',
      // Prisma CLI: no update checks or telemetry.
      CHECKPOINT_DISABLE: '1',
      PRISMA_HIDE_UPDATE_MESSAGE: '1',
    };
  }

  /** Applies database migrations (fast no-op when the schema is current). */
  async migrate(): Promise<void> {
    const { nodePath, serverDir, log } = this.options;
    log('Preparing the database…');
    const prismaLog = join(this.options.logDir, 'migrate.log');
    const result = await run(
      nodePath,
      [
        join(serverDir, 'node_modules', 'prisma', 'build', 'index.js'),
        'migrate',
        'deploy',
        '--schema',
        join(serverDir, 'prisma', 'schema.prisma'),
      ],
      { logFile: prismaLog, cwd: serverDir, env: this.env(), timeoutMs: 180_000 },
    );
    if (result.code !== 0) throw new Error(`Database migration failed.\n${tail(prismaLog)}`);
  }

  async start(): Promise<void> {
    const { nodePath, serverDir, preferredPort, log } = this.options;
    this.port = (await isPortFree(preferredPort)) ? preferredPort : await freePort();
    await this.migrate();

    log('Starting FlowForge…');
    rotateLog(this.logFile);
    const fd = openSync(this.logFile, 'a');
    const child = spawn(nodePath, ['--no-node-snapshot', join(serverDir, 'dist', 'index.js')], {
      cwd: serverDir,
      env: this.env(),
      // The IPC channel lets the server shut down cleanly on request, and exit if this app dies.
      stdio: ['ignore', fd, fd, 'ipc'],
      windowsHide: true,
    });
    closeSync(fd);
    this.child = child;

    const exited = new Promise<never>((_, reject) => {
      child.once('exit', (code) => {
        this.child = null;
        reject(
          new Error(`The FlowForge server stopped (exit code ${code}).\n${tail(this.logFile)}`),
        );
      });
      child.once('error', reject);
    });
    exited.catch(() => undefined);
    await Promise.race([this.waitUntilReady(), exited]);
  }

  private async waitUntilReady(timeoutMs = 90_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`http://127.0.0.1:${this.port}/readyz`);
        if (response.ok) return;
      } catch {
        // not listening yet
      }
      await sleep(300);
    }
    throw new Error(
      `FlowForge did not become ready within ${timeoutMs / 1000}s.\n${tail(this.logFile)}`,
    );
  }

  /** Called when the server exits unexpectedly after it was ready. */
  onExit(listener: (code: number | null) => void): void {
    this.child?.once('exit', listener);
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child || child.exitCode !== null) return;
    this.options.log('Stopping FlowForge…');
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    try {
      child.send('shutdown');
    } catch {
      child.kill();
    }
    const timedOut = await Promise.race([exited.then(() => false), sleep(20_000).then(() => true)]);
    if (timedOut) child.kill('SIGKILL');
    this.child = null;
  }
}
