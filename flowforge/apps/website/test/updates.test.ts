import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET as site } from '@/app/api/releases/site/route';
// @ts-expect-error - plain JavaScript build script
import { bundleDownloads } from '../scripts/bundle-downloads.mjs';

/** The Windows app updates itself from this site: it finds the site, then reads latest.yml. */
const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'ff-updates-'));
  dirs.push(dir);
  return dir;
};

describe('updates for the Windows app', () => {
  it('the site says which repository it belongs to', async () => {
    vi.stubEnv('FLOWFORGE_RELEASES_REPO', 'owner/automation');
    expect(await site().json()).toEqual({ app: 'flowforge-website', repo: 'owner/automation' });
  });

  it('ships latest.yml and the delta map next to the installer, and only with it', async () => {
    const source = temp();
    const exe = Buffer.from('installer');
    writeFileSync(join(source, 'FlowForge-Setup.exe.part0'), exe);
    writeFileSync(join(source, 'latest.yml'), 'version: 0.3.1\npath: FlowForge-Setup.exe\n');
    writeFileSync(join(source, 'FlowForge-Setup.exe.blockmap'), 'map');
    const manifest = (downloads: unknown[]) =>
      JSON.stringify({ version: '0.3.1', tag: 'v0.3.1', publishedAt: 'x', repo: 'o/r', downloads });
    const windows = {
      file: 'FlowForge-Setup.exe',
      platform: 'windows',
      label: 'Windows',
      url: 'https://x',
      size: exe.length,
      sha256: createHash('sha256').update(exe).digest('hex'),
    };
    writeFileSync(join(source, 'release.json'), manifest([windows]));
    const target = join(temp(), 'downloads');
    await bundleDownloads(source, target, () => {});
    expect(readFileSync(join(target, 'latest.yml'), 'utf8')).toContain('version: 0.3.1');
    expect(existsSync(join(target, 'FlowForge-Setup.exe.blockmap'))).toBe(true);

    // No installer on the site (e.g. a build with keys): no update manifest either.
    writeFileSync(join(source, 'FlowForge.apk'), 'apk');
    writeFileSync(
      join(source, 'release.json'),
      manifest([
        {
          file: 'FlowForge.apk',
          platform: 'android',
          label: 'Android',
          url: 'https://x',
          size: 3,
          sha256: createHash('sha256').update('apk').digest('hex'),
        },
      ]),
    );
    await bundleDownloads(source, target, () => {});
    expect(existsSync(join(target, 'latest.yml'))).toBe(false);
  });
});
