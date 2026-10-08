import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LocalPostgres } from './postgres';
import { ServerProcess } from './server';
import { exe, type Logger } from './util';

export interface RuntimeOptions {
  /** Bundled runtime: node/, server/, editor/, postgres/. */
  resourcesDir: string;
  /** Per-user data: database, secrets, logs. */
  dataDir: string;
  preferredPort?: number;
  log: Logger;
}

interface Secrets {
  jwtSecret: string;
  encryptionKey: string;
  databasePassword: string;
}

/**
 * Secrets are generated on first start and kept in the user's data folder, so nobody ever has to
 * create or paste a key. The encryption key protects saved credentials - it must survive updates.
 */
export function loadSecrets(dataDir: string): Secrets {
  const file = join(dataDir, 'secrets.json');
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8')) as Secrets;
  const secrets: Secrets = {
    jwtSecret: randomBytes(48).toString('hex'),
    encryptionKey: randomBytes(32).toString('hex'),
    databasePassword: randomBytes(24).toString('hex'),
  };
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(file, JSON.stringify(secrets, null, 2), { mode: 0o600 });
  return secrets;
}

export function checkResources(resourcesDir: string): void {
  const required = [
    join('node', exe('node')),
    join('server', 'dist', 'index.js'),
    join('editor', 'index.html'),
    join('postgres', 'bin', exe('pg_ctl')),
  ];
  const missing = required.filter((path) => !existsSync(join(resourcesDir, path)));
  if (missing.length) {
    throw new Error(
      `The app is incomplete - missing ${missing.join(', ')} in ${resourcesDir}.\n` +
        'Reinstall FlowForge (developers: run "pnpm --filter @flowforge/desktop resources").',
    );
  }
}

/** Everything FlowForge needs, on this computer: a private database and the server. */
export class LocalRuntime {
  private postgres: LocalPostgres | null = null;
  private server: ServerProcess | null = null;

  constructor(private readonly options: RuntimeOptions) {}

  get url(): string | null {
    return this.server?.port ? this.server.url : null;
  }

  async start(): Promise<string> {
    const { resourcesDir, dataDir, log } = this.options;
    if (process.platform !== 'win32' && process.getuid?.() === 0) {
      throw new Error('PostgreSQL cannot run as root. Start FlowForge as a regular user.');
    }
    checkResources(resourcesDir);
    const secrets = loadSecrets(dataDir);
    const logDir = join(dataDir, 'logs');

    this.postgres = new LocalPostgres({
      binDir: join(resourcesDir, 'postgres', 'bin'),
      dataDir: join(dataDir, 'database'),
      logDir,
      user: 'flowforge',
      password: secrets.databasePassword,
      log,
    });
    await this.postgres.start();

    this.server = new ServerProcess({
      nodePath: join(resourcesDir, 'node', exe('node')),
      serverDir: join(resourcesDir, 'server'),
      editorDir: join(resourcesDir, 'editor'),
      logDir,
      databaseUrl: this.postgres.databaseUrl,
      jwtSecret: secrets.jwtSecret,
      encryptionKey: secrets.encryptionKey,
      preferredPort: this.options.preferredPort ?? 5678,
      log,
    });
    await this.server.start();
    log(`FlowForge is running at ${this.server.url}`);
    return this.server.url;
  }

  onServerExit(listener: (code: number | null) => void): void {
    this.server?.onExit(listener);
  }

  async stop(): Promise<void> {
    await this.server
      ?.stop()
      .catch((error: Error) => this.options.log(`Server stop failed: ${error.message}`));
    await this.postgres
      ?.stop()
      .catch((error: Error) => this.options.log(`Database stop failed: ${error.message}`));
    this.server = null;
  }
}

export { tail } from './util';
