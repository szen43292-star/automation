import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { exe, freePort, run, tail, type Logger } from './util';

export interface PostgresOptions {
  /** Folder with initdb, pg_ctl and postgres. */
  binDir: string;
  /** PGDATA - created on first start. */
  dataDir: string;
  logDir: string;
  user: string;
  password: string;
  log: Logger;
}

/**
 * A private PostgreSQL instance for the desktop app: initialised on first start, listening on
 * 127.0.0.1 only, password-protected. Started through pg_ctl, which on Windows drops
 * administrator rights (PostgreSQL refuses to run elevated) - so it also works for admin users.
 */
export class LocalPostgres {
  port = 0;
  private readonly serverLog: string;
  private readonly toolLog: string;

  constructor(private readonly options: PostgresOptions) {
    this.serverLog = join(options.logDir, 'postgres.log');
    this.toolLog = join(options.logDir, 'postgres-tools.log');
  }

  get databaseUrl(): string {
    const { user, password } = this.options;
    return `postgresql://${user}:${encodeURIComponent(password)}@127.0.0.1:${this.port}/postgres`;
  }

  private bin(name: string): string {
    return join(this.options.binDir, exe(name));
  }

  private async tool(name: string, args: string[], timeoutMs = 120_000) {
    const result = await run(this.bin(name), args, { logFile: this.toolLog, timeoutMs });
    if (result.code !== 0) {
      throw new Error(
        `${name} failed (exit code ${result.code}).\n${tail(this.toolLog)}\n${tail(this.serverLog)}`.trim(),
      );
    }
  }

  async initialise(): Promise<void> {
    const { dataDir, user, password, log } = this.options;
    if (existsSync(join(dataDir, 'PG_VERSION'))) return;
    // A folder without PG_VERSION is a first start that was interrupted - start over.
    if (existsSync(dataDir) && readdirSync(dataDir).length > 0)
      rmSync(dataDir, { recursive: true, force: true });
    mkdirSync(dirname(dataDir), { recursive: true });
    mkdirSync(this.options.logDir, { recursive: true });
    log('Creating the local database (first start only)…');
    const pwFile = join(dirname(dataDir), `.pw-${randomBytes(6).toString('hex')}`);
    writeFileSync(pwFile, password, { mode: 0o600 });
    try {
      await this.tool('initdb', [
        '-D',
        dataDir,
        '-U',
        user,
        `--pwfile=${pwFile}`,
        '--auth=scram-sha-256',
        '--encoding=UTF8',
        '--locale=C',
        '--no-instructions',
      ]);
    } finally {
      rmSync(pwFile, { force: true });
    }
  }

  /** Port of an instance that is still running from an earlier session (e.g. after a crash). */
  private runningPort(): number | null {
    const pidFile = join(this.options.dataDir, 'postmaster.pid');
    if (!existsSync(pidFile)) return null;
    const [pidLine, , , portLine] = readFileSync(pidFile, 'utf8').split(/\r?\n/);
    const pid = Number(pidLine);
    const port = Number(portLine);
    if (!pid || !port) return null;
    try {
      process.kill(pid, 0);
      return port;
    } catch {
      return null;
    }
  }

  async start(): Promise<void> {
    await this.initialise();
    const { dataDir, log } = this.options;
    const existing = this.runningPort();
    if (existing) {
      const status = await run(this.bin('pg_ctl'), ['status', '-D', dataDir], {
        logFile: this.toolLog,
      });
      if (status.code === 0) {
        this.port = existing;
        log(`Database already running on port ${existing}`);
        return;
      }
    }
    // Left behind by a crash; PostgreSQL would refuse to start while it exists.
    rmSync(join(dataDir, 'postmaster.pid'), { force: true });

    this.port = await freePort();
    const serverOptions = [`-p ${this.port}`, '-c listen_addresses=127.0.0.1'];
    if (process.platform !== 'win32') serverOptions.push("-c unix_socket_directories=''");
    log('Starting the database…');
    await this.tool(
      'pg_ctl',
      [
        'start',
        '-D',
        dataDir,
        '-w',
        '-t',
        '90',
        '-l',
        this.serverLog,
        '-o',
        serverOptions.join(' '),
      ],
      120_000,
    );
  }

  async stop(): Promise<void> {
    if (!existsSync(join(this.options.dataDir, 'postmaster.pid'))) return;
    this.options.log('Stopping the database…');
    await run(
      this.bin('pg_ctl'),
      ['stop', '-D', this.options.dataDir, '-m', 'fast', '-w', '-t', '30'],
      {
        logFile: this.toolLog,
        timeoutMs: 45_000,
      },
    );
  }
}
