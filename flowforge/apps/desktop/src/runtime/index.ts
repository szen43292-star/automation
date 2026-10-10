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

/** Variables a private build may carry; anything else in config.json is ignored. */
export const BUNDLED_KEYS = [
  'META_APP_ID',
  'META_APP_SECRET',
  'META_EMBEDDED_SIGNUP_CONFIG_ID',
  'WHATSAPP_WEBHOOK_VERIFY_TOKEN',
  'PUBLIC_URL',
  'OPENAI_API_KEY',
  'DEEPGRAM_API_KEY',
  'ELEVENLABS_API_KEY',
  'SARVAM_API_KEY',
  'GROQ_API_KEY',
  'GEMINI_API_KEY',
  'ANTHROPIC_API_KEY',
] as const;

/** "version: 0.3.1" from an electron-updater latest.yml. */
export function latestVersion(yml: string): string | null {
  return yml.match(/^version:\s*['"]?([0-9][^'"\s]*)/m)?.[1] ?? null;
}

/** Compares 1.2.3 versions (pre-release suffixes sort before the release). */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core = '', pre] = v.split('-', 2);
    return { parts: core.split('.').map((n) => Number(n) || 0), pre: pre ?? null };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) {
    const diff = (x.parts[i] ?? 0) - (y.parts[i] ?? 0);
    if (diff) return diff;
  }
  if (x.pre === y.pre) return 0;
  if (x.pre === null) return 1;
  if (y.pre === null) return -1;
  return x.pre < y.pre ? -1 : 1;
}

/**
 * Of the download websites, the one offering the newest version (null when none answers): sites
 * of different Vercel projects can be a release apart while they redeploy, and some may be gone.
 */
export async function pickUpdateSite(
  sites: string[],
  fetcher: typeof fetch = fetch,
): Promise<{ url: string; version: string } | null> {
  const offers = await Promise.all(
    sites.map(async (url) => {
      try {
        const response = await fetcher(`${url}/downloads/latest.yml`, {
          signal: AbortSignal.timeout(15_000),
        });
        const version = response.ok ? latestVersion(await response.text()) : null;
        return version ? { url, version } : null;
      } catch {
        return null;
      }
    }),
  );
  return offers.reduce<{ url: string; version: string } | null>(
    (best, offer) =>
      offer && (!best || compareVersions(offer.version, best.version) > 0) ? offer : best,
    null,
  );
}

/**
 * `config.json` next to the runtime: keys built into a private build from the repository's
 * GitHub secrets, so the app needs no setup. Missing or unreadable means none.
 */
export function loadBundledConfig(resourcesDir: string): {
  env: Record<string, string>;
  updateToken: string | null;
  /**
   * The download websites (https://…, no trailing slash) - every Vercel project of the repository
   * found when the app was built. Updates come from the /downloads of whichever has the newest.
   */
  updateUrls: string[];
} {
  try {
    const raw = JSON.parse(readFileSync(join(resourcesDir, 'config.json'), 'utf8')) as {
      env?: Record<string, unknown>;
    };
    const env: Record<string, string> = {};
    for (const key of BUNDLED_KEYS) {
      const value = raw.env?.[key];
      if (typeof value === 'string' && value.trim()) env[key] = value.trim();
    }
    const token = raw.env?.UPDATE_GITHUB_TOKEN;
    const urls = typeof raw.env?.UPDATE_URL === 'string' ? raw.env.UPDATE_URL.split(/[\s,]+/) : [];
    return {
      env,
      updateToken: typeof token === 'string' && token.trim() ? token.trim() : null,
      updateUrls: [
        ...new Set(
          urls
            .filter((url) => /^https:\/\/[^\s/]+(\/\S*)?$/.test(url))
            .map((url) => url.replace(/\/+$/, '')),
        ),
      ],
    };
  } catch {
    return { env: {}, updateToken: null, updateUrls: [] };
  }
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
      filesDir: join(dataDir, 'files'),
      databaseUrl: this.postgres.databaseUrl,
      jwtSecret: secrets.jwtSecret,
      encryptionKey: secrets.encryptionKey,
      preferredPort: this.options.preferredPort ?? 5678,
      bundledEnv: loadBundledConfig(resourcesDir).env,
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
