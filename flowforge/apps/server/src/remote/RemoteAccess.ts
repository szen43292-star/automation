import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';

/** Paths a request from the internet may open through the tunnel. */
export const REMOTE_PATH_PREFIX = '/approve/';

const TUNNEL_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
const RELEASES = 'https://github.com/cloudflare/cloudflared/releases/latest/download';

/** The cloudflared download for this computer (null: not available for this platform). */
export function cloudflaredAsset(platform = process.platform, arch = process.arch): string | null {
  const cpu = arch === 'x64' ? 'amd64' : arch === 'arm64' ? 'arm64' : null;
  if (!cpu) return null;
  if (platform === 'win32') return cpu === 'amd64' ? 'cloudflared-windows-amd64.exe' : null;
  if (platform === 'linux') return `cloudflared-linux-${cpu}`;
  return null;
}

/** True for addresses only this computer or its local network can open. */
export function isLocalUrl(url: string): boolean {
  const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
  return (
    host === 'localhost' ||
    host.endsWith('.local') ||
    host === '::1' ||
    host === '0.0.0.0' ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  );
}

export interface RemoteAccessOptions {
  publicUrl: string;
  /** Port of this server on 127.0.0.1 (what the tunnel forwards to). */
  port: number;
  /** "tunnel": open a Cloudflare quick tunnel when a link is needed and PUBLIC_URL is local. */
  mode: 'off' | 'tunnel';
  dataDir: string;
  /** cloudflared to run instead of the downloaded one. */
  binary?: string;
  logger: FastifyBaseLogger;
}

/**
 * The address that opens this server from anywhere, for links sent to a phone (approvals).
 *
 * A server with a public PUBLIC_URL already has one. The Windows app runs on localhost, so it
 * opens a Cloudflare quick tunnel (free, no account) the first time a link is needed. Requests
 * that come through the tunnel may only open the approval pages (see allows()).
 */
export class RemoteAccess {
  private child: ChildProcess | null = null;
  private current: string | null = null;
  private starting: Promise<string | null> | null = null;
  private waiters: Array<(url: string | null) => void> = [];
  private stopped = false;
  private restartDelay = 5_000;

  constructor(private readonly options: RemoteAccessOptions) {}

  /** True when links need the tunnel (local server with remote access switched on). */
  get usesTunnel(): boolean {
    return this.options.mode === 'tunnel' && isLocalUrl(this.options.publicUrl);
  }

  /** Base URL reachable from the internet, or null when there is none. */
  async url(timeoutMs = 30_000): Promise<string | null> {
    if (!isLocalUrl(this.options.publicUrl)) return this.options.publicUrl.replace(/\/+$/, '');
    if (!this.usesTunnel) return null;
    if (this.current) return this.current;
    this.starting ??= this.start(timeoutMs).finally(() => {
      this.starting = null;
    });
    const started = await this.starting;
    if (started || !this.child) return started;
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), timeoutMs);
      this.waiters.push((url) => {
        clearTimeout(timer);
        resolve(url);
      });
    });
  }

  /**
   * Whether a request may be served: requests through the quick tunnel only reach the approval
   * pages, everything else (editor, API, webhooks) stays on this computer.
   */
  allows(
    host: string | undefined,
    path: string,
    headers: Record<string, string | string[] | undefined> = {},
  ): boolean {
    if (!this.usesTunnel) return true;
    const name = (host ?? '').split(':')[0]!.toLowerCase();
    // Cloudflare marks every request it forwards; requests made on this computer have neither.
    const viaTunnel =
      name.endsWith('.trycloudflare.com') || headers['cf-connecting-ip'] !== undefined;
    return !viaTunnel || path.startsWith(REMOTE_PATH_PREFIX);
  }

  stop() {
    this.stopped = true;
    this.child?.kill();
    this.child = null;
    this.current = null;
  }

  /** Starts cloudflared; resolves with its address, or null when none appeared in time. */
  private async start(timeoutMs = 30_000): Promise<string | null> {
    if (this.child) return this.current;
    let binary: string;
    try {
      binary = await this.binary();
    } catch (error) {
      this.options.logger.warn(
        { err: error },
        'Remote access: cloudflared is not available, links only work on this network',
      );
      return null;
    }
    return new Promise((resolve) => {
      let settled = false;
      const settle = (url: string | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(url);
      };
      // Still running without an address: give up waiting (a later address wakes url() callers).
      const timer = setTimeout(() => settle(null), timeoutMs);
      const child = spawn(
        binary,
        ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${this.options.port}`],
        { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
      );
      this.child = child;
      const onOutput = (chunk: Buffer) => {
        const url = chunk.toString('utf8').match(TUNNEL_URL)?.[0];
        if (!url || this.current === url) return;
        this.current = url;
        this.restartDelay = 5_000;
        this.options.logger.info({ url }, 'Remote access: approval links open from anywhere');
        this.waiters.splice(0).forEach((wake) => wake(url));
        settle(url);
      };
      child.stdout?.on('data', onOutput);
      child.stderr?.on('data', onOutput);
      child.on('error', (error) => {
        this.options.logger.warn({ err: error }, 'Remote access: cloudflared could not start');
      });
      child.on('exit', (code) => {
        if (this.child === child) this.child = null;
        this.current = null;
        settle(null);
        if (this.stopped) return;
        this.options.logger.warn({ code }, 'Remote access: the tunnel closed, reopening');
        const delay = this.restartDelay;
        this.restartDelay = Math.min(this.restartDelay * 2, 300_000);
        setTimeout(() => {
          if (!this.stopped) void this.start(timeoutMs);
        }, delay).unref();
      });
    });
  }

  /** The cloudflared executable: configured, or downloaded once into DATA_DIR/bin. */
  private async binary(): Promise<string> {
    if (this.options.binary) return this.options.binary;
    const asset = cloudflaredAsset();
    if (!asset) throw new Error(`No cloudflared download for ${process.platform}-${process.arch}`);
    const dir = join(this.options.dataDir, 'bin');
    const file = join(dir, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
    if (existsSync(file)) return file;
    mkdirSync(dir, { recursive: true });
    this.options.logger.info({ asset }, 'Remote access: downloading cloudflared (once)');
    const response = await fetch(`${RELEASES}/${asset}`, { signal: AbortSignal.timeout(300_000) });
    if (!response.ok) throw new Error(`Download failed (HTTP ${response.status})`);
    const partial = `${file}.download`;
    try {
      writeFileSync(partial, Buffer.from(await response.arrayBuffer()));
      if (process.platform !== 'win32') chmodSync(partial, 0o755);
      renameSync(partial, file);
    } finally {
      rmSync(partial, { force: true });
    }
    return file;
  }
}
