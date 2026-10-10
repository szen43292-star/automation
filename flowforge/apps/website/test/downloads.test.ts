import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET } from '@/app/download/[platform]/route';
import { getLatestRelease } from '@/lib/releases';
// @ts-expect-error - plain JavaScript build script
import { bundleDownloads } from '../scripts/bundle-downloads.mjs';

/** Apps committed to the repository (flowforge/downloads) are served by the site itself. */
const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'ff-downloads-'));
  dirs.push(dir);
  return dir;
};
const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const entry = (file: string, platform: string, data: Buffer) => ({
  file,
  platform,
  label: file,
  url: `https://github.com/acme/flowforge/releases/download/v0.3.0/${file}`,
  size: data.length,
  sha256: sha(data),
});

const bundled = (downloads: Array<{ file: string; platform: string }>) =>
  JSON.stringify({
    version: '0.3.0',
    tag: 'v0.3.0',
    publishedAt: '2026-10-09T16:19:08Z',
    repo: 'acme/flowforge',
    downloads: downloads.map((d) => ({
      ...d,
      label: d.file,
      url: `/downloads/${d.file}`,
      size: 10,
    })),
  });

describe('apps bundled into the website', () => {
  it('joins the installer parts, checks every file and links them from the site', async () => {
    const source = temp();
    const target = join(temp(), 'downloads');
    const exe = Buffer.from('MZ'.repeat(50_000));
    const apk = Buffer.from('android app');
    const ipa = Buffer.from('iphone app');
    writeFileSync(join(source, 'FlowForge-Setup.exe.part0'), exe.subarray(0, 40_000));
    writeFileSync(join(source, 'FlowForge-Setup.exe.part1'), exe.subarray(40_000, 80_000));
    writeFileSync(join(source, 'FlowForge-Setup.exe.part2'), exe.subarray(80_000));
    writeFileSync(join(source, 'FlowForge.apk'), apk);
    writeFileSync(join(source, 'FlowForge.ipa'), Buffer.from('tampered'));
    writeFileSync(
      join(source, 'release.json'),
      JSON.stringify({
        version: '0.3.0',
        tag: 'v0.3.0',
        publishedAt: '2026-10-09T16:19:08Z',
        repo: 'acme/flowforge',
        downloads: [
          entry('FlowForge-Setup.exe', 'windows', exe),
          entry('FlowForge.apk', 'android', apk),
          entry('FlowForge.ipa', 'ios', ipa),
        ],
      }),
    );
    const lines: string[] = [];
    const release = await bundleDownloads(source, target, (line: string) => lines.push(line));

    expect(readFileSync(join(target, 'FlowForge-Setup.exe')).equals(exe)).toBe(true);
    expect(release.downloads.map((d: { url: string }) => d.url)).toEqual([
      '/downloads/FlowForge-Setup.exe',
      '/downloads/FlowForge.apk',
    ]);
    // A file that does not match its checksum is left out, never served.
    expect(existsSync(join(target, 'FlowForge.ipa'))).toBe(false);
    expect(lines.join('\n')).toContain('FlowForge.ipa does not match');
    expect(JSON.parse(readFileSync(join(target, 'release.json'), 'utf8'))).toEqual(release);
  });

  it('nothing in the repository yet: no downloads folder, the build goes on', async () => {
    const target = join(temp(), 'downloads');
    expect(await bundleDownloads(temp(), target, () => {})).toBeNull();
    expect(existsSync(target)).toBe(false);
  });

  it('the site uses its own apps first, without asking GitHub', async () => {
    vi.stubEnv(
      'FLOWFORGE_BUNDLED_RELEASE',
      bundled([
        { file: 'FlowForge-Setup.exe', platform: 'windows' },
        { file: 'FlowForge.apk', platform: 'android' },
        { file: 'FlowForge.ipa', platform: 'ios' },
      ]),
    );
    const fetcher = vi.fn();
    const release = await getLatestRelease(fetcher);
    expect(fetcher).not.toHaveBeenCalled();
    expect(release?.downloads.map((d) => d.url)).toEqual([
      '/downloads/FlowForge-Setup.exe',
      '/downloads/FlowForge.apk',
      '/downloads/FlowForge.ipa',
    ]);

    const params = (platform: string) => ({ params: Promise.resolve({ platform }) });
    const ios = await GET(new Request('https://site.example/download/ios'), params('ios'));
    expect(ios.status).toBe(302);
    expect(ios.headers.get('location')).toBe('https://site.example/downloads/FlowForge.ipa');
  });

  it('an app the site does not carry (a private Windows build) still comes from GitHub', async () => {
    vi.stubEnv(
      'FLOWFORGE_BUNDLED_RELEASE',
      bundled([
        { file: 'FlowForge.apk', platform: 'android' },
        { file: 'FlowForge.ipa', platform: 'ios' },
      ]),
    );
    vi.stubEnv('RELEASES_GITHUB_TOKEN', 'github_pat_test');
    const fetcher = vi.fn(async (url: string) =>
      url.endsWith('/releases/latest')
        ? new Response(
            JSON.stringify({
              tag_name: 'v0.3.0',
              name: null,
              body: '',
              published_at: '2026-10-09T16:19:08Z',
              html_url: 'https://github.com/acme/flowforge/releases/tag/v0.3.0',
              assets: [
                {
                  id: 1,
                  name: 'FlowForge-Setup.exe',
                  size: 9,
                  browser_download_url: 'https://x/FlowForge-Setup.exe',
                },
              ],
            }),
          )
        : new Response('nope', { status: 404 }),
    );
    const release = await getLatestRelease(fetcher);
    expect(release?.downloads.map((d) => d.url)).toEqual([
      '/downloads/FlowForge.apk',
      '/downloads/FlowForge.ipa',
      '/download/windows',
    ]);
  });
});
