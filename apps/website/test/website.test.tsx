import { NextRequest } from 'next/server';
import { renderToStaticMarkup } from 'react-dom/server';
import { proxy } from '@/proxy';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Markdown } from '@/lib/markdown';
import { detectPlatform } from '@/lib/platform';
import {
  DEFAULT_REPO,
  formatSize,
  fromGithubRelease,
  getLatestRelease,
  manifestUrl,
  releasesRepo,
  signedAssetUrl,
  windowsDownload,
} from '@/lib/releases';

const manifest = {
  schema: 1,
  name: 'FlowForge',
  version: '0.3.0',
  tag: 'v0.3.0',
  publishedAt: '2026-10-08T06:00:00.000Z',
  repo: 'acme/flowforge',
  notes: '### Changes\n- Windows app',
  downloads: [
    {
      file: 'FlowForge-Setup.exe',
      platform: 'windows',
      arch: 'x64',
      kind: 'installer',
      label: 'Windows installer (.exe)',
      url: 'https://github.com/acme/flowforge/releases/download/v0.3.0/FlowForge-Setup.exe',
      size: 150_000_000,
      sha256: 'a'.repeat(64),
    },
  ],
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => vi.unstubAllEnvs());

describe('release source', () => {
  it('defaults to the project repository and validates overrides', () => {
    expect(releasesRepo()).toBe(DEFAULT_REPO);
    vi.stubEnv('FLOWFORGE_RELEASES_REPO', 'acme/flowforge');
    expect(manifestUrl()).toBe(
      'https://github.com/acme/flowforge/releases/latest/download/release.json',
    );
    vi.stubEnv('FLOWFORGE_RELEASES_REPO', 'not a repo; rm -rf');
    expect(releasesRepo()).toBe(DEFAULT_REPO);
  });

  it('reads release.json from the latest GitHub release - no API, no token', async () => {
    const fetcher = vi.fn(async (_url: string) => json(manifest));
    const release = await getLatestRelease(fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      `https://github.com/${DEFAULT_REPO}/releases/latest/download/release.json`,
    );
    expect(release?.version).toBe('0.3.0');
    expect(windowsDownload(release)?.sha256).toBe('a'.repeat(64));
  });

  it('falls back to the public releases API when there is no manifest', async () => {
    const fetcher = vi.fn(async (url: string) =>
      url.includes('api.github.com')
        ? json({
            tag_name: 'v0.2.9',
            name: 'FlowForge 0.2.9',
            body: 'Notes',
            published_at: '2026-10-01T00:00:00Z',
            html_url: 'https://github.com/x/y/releases/tag/v0.2.9',
            assets: [
              {
                name: 'FlowForge-Setup.exe',
                size: 1234,
                browser_download_url: 'https://example.com/a.exe',
              },
            ],
          })
        : new Response('Not Found', { status: 404 }),
    );
    const release = await getLatestRelease(fetcher);
    expect(release?.version).toBe('0.2.9');
    expect(windowsDownload(release)).toMatchObject({
      url: 'https://example.com/a.exe',
      size: 1234,
      sha256: null,
    });
  });

  it('returns null when nothing is published (e.g. private repository) or the manifest is invalid', async () => {
    expect(
      await getLatestRelease(async () => new Response('Not Found', { status: 404 })),
    ).toBeNull();
    expect(await getLatestRelease(async () => json({ version: 1 }))).toBeNull();
    expect(
      await getLatestRelease(async () => {
        throw new Error('offline');
      }),
    ).toBeNull();
    expect(fromGithubRelease({ tag_name: 'v1', assets: [] }, 'a/b')).toBeNull();
  });

  it('formats sizes', () => {
    expect(formatSize(150_000_000)).toBe('143 MB');
    expect(formatSize(2048)).toBe('2 KB');
  });
});

describe('platform detection', () => {
  it.each([
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36',
      '',
      0,
      'windows',
    ],
    [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 Version/17.5 Safari/605.1.15',
      '',
      0,
      'macos',
    ],
    [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 Version/17.5 Safari/605.1.15',
      '',
      5,
      'ios',
    ],
    [
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36',
      '',
      5,
      'android',
    ],
    [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148',
      '',
      5,
      'ios',
    ],
    [
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36',
      '',
      0,
      'linux',
    ],
    ['Mozilla/5.0', 'Windows', 0, 'windows'],
    ['curl/8.0', '', 0, 'unknown'],
  ])('%s', (ua, hint, touch, expected) => {
    expect(detectPlatform(ua, hint, touch)).toBe(expected);
  });
});

describe('release notes markdown', () => {
  it('renders headings, lists, code, bold and safe links', () => {
    const html = renderToStaticMarkup(
      <Markdown
        source={
          '### New\n- **Fast** start\n- `code` and [docs](https://example.com)\n\nPlain <b>text</b>'
        }
      />,
    );
    expect(html).toContain('<h4>New</h4>');
    expect(html).toContain('<li><strong>Fast</strong> start</li>');
    expect(html).toContain('<code>code</code>');
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('Plain &lt;b&gt;text&lt;/b&gt;');
  });

  it('does not turn javascript: URLs into links', () => {
    const html = renderToStaticMarkup(<Markdown source={'[x](javascript:alert(1))'} />);
    expect(html).not.toContain('href');
  });
});

describe('private repository', () => {
  it('reads the release through the API with the server token and links downloads to /download/windows', async () => {
    vi.stubEnv('RELEASES_GITHUB_TOKEN', 'github_pat_test');
    const seen: Array<{ url: string; auth: string | null; accept: string | null }> = [];
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      seen.push({ url, auth: headers.get('authorization'), accept: headers.get('accept') });
      if (url.endsWith('/releases/latest'))
        return json({
          tag_name: 'v0.3.0',
          assets: [
            { id: 7, name: 'release.json' },
            { id: 8, name: 'FlowForge-Setup.exe' },
          ],
        });
      if (url.endsWith('/releases/assets/7')) return json(manifest);
      return new Response('nope', { status: 404 });
    });
    const release = await getLatestRelease(fetcher);
    expect(release?.version).toBe('0.3.0');
    expect(windowsDownload(release)?.url).toBe('/download/windows');
    expect(seen.every((s) => s.auth === 'Bearer github_pat_test')).toBe(true);
    expect(seen[1]!.accept).toBe('application/octet-stream');
  });

  it('turns the installer into a short-lived signed link without exposing the token', async () => {
    vi.stubEnv('RELEASES_GITHUB_TOKEN', 'github_pat_test');
    const fetcher = vi.fn(async (url: string) => {
      if (url.endsWith('/releases/latest'))
        return json({ assets: [{ id: 8, name: 'FlowForge-Setup.exe' }] });
      return new Response(null, {
        status: 302,
        headers: { location: 'https://objects.githubusercontent.com/signed?x=1' },
      });
    });
    expect(await signedAssetUrl('FlowForge-Setup.exe', fetcher)).toBe(
      'https://objects.githubusercontent.com/signed?x=1',
    );
    expect(await signedAssetUrl('missing.exe', fetcher)).toBeNull();
  });
});

describe('site password', () => {
  const request = (auth?: string) =>
    new NextRequest(
      'https://flowforge.example/download',
      auth ? { headers: { authorization: auth } } : undefined,
    );

  it('is open without SITE_PASSWORD and asks for it when set', () => {
    expect(proxy(request()).status).toBe(200);
    vi.stubEnv('SITE_PASSWORD', 'open-sesame');
    const denied = proxy(request());
    expect(denied.status).toBe(401);
    expect(denied.headers.get('www-authenticate')).toContain('Basic');
    expect(proxy(request(`Basic ${btoa('me:wrong')}`)).status).toBe(401);
    expect(proxy(request(`Basic ${btoa('me:open-sesame')}`)).status).toBe(200);
  });
});
