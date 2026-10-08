import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET } from '@/app/download/[platform]/route';
import { nextVersion, releaseInput, startRelease } from '@/lib/admin';
import { fromGithubRelease, getLatestRelease, platformDownload } from '@/lib/releases';
import { proxy } from '@/proxy';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const githubRelease = {
  tag_name: 'v0.4.0',
  name: 'FlowForge 0.4.0',
  body: 'notes',
  published_at: '2026-10-08T10:00:00Z',
  html_url: 'https://github.com/acme/flowforge/releases/tag/v0.4.0',
  assets: [
    {
      id: 1,
      name: 'FlowForge-Setup.exe',
      size: 150_000_000,
      browser_download_url: 'https://x/FlowForge-Setup.exe',
    },
    {
      id: 2,
      name: 'FlowForge.apk',
      size: 5_000_000,
      browser_download_url: 'https://x/FlowForge.apk',
    },
    {
      id: 3,
      name: 'FlowForge.ipa',
      size: 6_000_000,
      browser_download_url: 'https://x/FlowForge.ipa',
    },
  ],
};

describe('phone apps on the website', () => {
  it('finds the Android and iPhone apps in a release', () => {
    const release = fromGithubRelease(githubRelease, 'acme/flowforge')!;
    expect(release.downloads.map((d) => d.platform)).toEqual(['windows', 'android', 'ios']);
    expect(platformDownload(release, 'android')).toMatchObject({
      file: 'FlowForge.apk',
      size: 5_000_000,
    });
  });

  it('private repositories link every app through /download/<platform>', async () => {
    vi.stubEnv('RELEASES_GITHUB_TOKEN', 'github_pat_test');
    const fetcher = vi.fn(async (url: string) =>
      url.endsWith('/releases/latest')
        ? json(githubRelease)
        : new Response('nope', { status: 404 }),
    );
    const release = await getLatestRelease(fetcher);
    expect(release?.downloads.map((d) => d.url)).toEqual([
      '/download/windows',
      '/download/android',
      '/download/ios',
    ]);
  });

  it('/download/android redirects to the newest APK; unknown platforms are 404', async () => {
    vi.stubEnv('RELEASE_MANIFEST_URL', 'https://example.com/release.json');
    vi.stubGlobal(
      'fetch',
      vi
        .fn(async () => json({ message: 'no manifest' }, 404))
        .mockResolvedValueOnce(
          json({
            version: '0.4.0',
            tag: 'v0.4.0',
            publishedAt: '2026-10-08T10:00:00Z',
            repo: 'acme/flowforge',
            downloads: [
              {
                file: 'FlowForge.apk',
                platform: 'android',
                label: 'Android app (.apk)',
                url: 'https://x/FlowForge.apk',
                size: 5,
              },
            ],
          }),
        ),
    );
    const params = (platform: string) => ({ params: Promise.resolve({ platform }) });
    const ok = await GET(new Request('https://site/download/android'), params('android'));
    expect(ok.status).toBe(302);
    expect(ok.headers.get('location')).toBe('https://x/FlowForge.apk');
    expect((await GET(new Request('https://site/download/macos'), params('macos'))).status).toBe(
      404,
    );
  });
});

describe('release admin', () => {
  const request = (path: string, auth?: string) =>
    new NextRequest(
      `https://flowforge.example${path}`,
      auth ? { headers: { authorization: auth } } : undefined,
    );

  it('does not exist without ADMIN_PASSWORD and needs it when set', () => {
    expect(proxy(request('/admin')).status).toBe(404);
    vi.stubEnv('ADMIN_PASSWORD', 'admin-secret');
    expect(proxy(request('/admin')).status).toBe(401);
    expect(proxy(request('/admin/release', `Basic ${btoa('x:wrong')}`)).status).toBe(401);
    expect(proxy(request('/admin', `Basic ${btoa('x:admin-secret')}`)).status).toBe(200);
    // The rest of the site stays public unless SITE_PASSWORD is set.
    expect(proxy(request('/download')).status).toBe(200);
  });

  it('suggests the next version and validates input', () => {
    expect(nextVersion('v0.3.9')).toBe('0.3.10');
    expect(nextVersion(undefined)).toBe('0.3.0');
    expect(releaseInput.parse({ version: 'v1.2.3' }).version).toBe('1.2.3');
    expect(releaseInput.safeParse({ version: '1.2' }).success).toBe(false);
  });

  it('starts the Release workflow on GitHub', async () => {
    vi.stubEnv('RELEASES_GITHUB_TOKEN', 'github_pat_test');
    vi.stubEnv('FLOWFORGE_RELEASES_REPO', 'acme/flowforge');
    const calls: Array<{ url: string; body: unknown; auth: string | null }> = [];
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({
        url,
        body: JSON.parse(String(init?.body)),
        auth: new Headers(init?.headers).get('authorization'),
      });
      return new Response(null, { status: 204 });
    });
    expect(await startRelease({ version: '0.4.0', notes: 'Phone apps' }, fetcher)).toEqual({
      ok: true,
    });
    expect(calls[0]).toEqual({
      url: 'https://api.github.com/repos/acme/flowforge/actions/workflows/release.yml/dispatches',
      body: { ref: 'main', inputs: { version: '0.4.0', notes: 'Phone apps' } },
      auth: 'Bearer github_pat_test',
    });
    const denied = await startRelease({ version: '0.4.0', notes: '' }, async () =>
      json({ message: 'nope' }, 403),
    );
    expect(denied).toMatchObject({
      ok: false,
      message: expect.stringContaining('Actions: read and write'),
    });
  });
});
