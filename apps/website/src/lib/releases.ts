import { z } from 'zod';

/**
 * Release data comes from public GitHub Releases - no token, no API key:
 *  1. release.json, attached to every release by the "Windows app" workflow, downloaded from
 *     https://github.com/<repo>/releases/latest/download/release.json (a plain file, not the API,
 *     so there is no rate limit). It has sizes and SHA-256 checksums.
 *  2. If that file is missing, the public releases API (unauthenticated) for the basic facts.
 */

export const DEFAULT_REPO = 'szen43292-star/automation';
export const REVALIDATE_SECONDS = 300;

const downloadSchema = z.object({
  file: z.string().min(1),
  platform: z.enum(['windows', 'android', 'ios', 'macos', 'linux']),
  arch: z.string().default('x64'),
  kind: z.string().default('installer'),
  label: z.string().min(1),
  /** Absolute URL, or /download/windows for private repositories. */
  url: z.string().regex(/^(https?:\/\/|\/)/),
  size: z.number().int().nonnegative(),
  sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable()
    .default(null),
  requirements: z.string().optional(),
});

export const releaseSchema = z.object({
  name: z.string().default('FlowForge'),
  version: z.string().min(1),
  tag: z.string().min(1),
  publishedAt: z.string(),
  repo: z.string(),
  notes: z.string().default(''),
  downloads: z.array(downloadSchema).min(1),
});

export type Release = z.infer<typeof releaseSchema>;
export type Download = Release['downloads'][number];

const githubReleaseSchema = z.object({
  tag_name: z.string(),
  name: z.string().nullable(),
  body: z.string().nullable(),
  published_at: z.string().nullable(),
  html_url: z.string(),
  assets: z.array(
    z.object({ name: z.string(), size: z.number(), browser_download_url: z.string() }),
  ),
});

export function releasesRepo(): string {
  const repo = process.env.FLOWFORGE_RELEASES_REPO?.trim();
  return repo && /^[\w.-]+\/[\w.-]+$/.test(repo) ? repo : DEFAULT_REPO;
}

export function manifestUrl(repo = releasesRepo()): string {
  return (
    process.env.RELEASE_MANIFEST_URL?.trim() ||
    `https://github.com/${repo}/releases/latest/download/release.json`
  );
}

/** Maps a GitHub API release to our manifest shape (no checksums available this way). */
export function fromGithubRelease(data: unknown, repo: string): Release | null {
  const parsed = githubReleaseSchema.safeParse(data);
  if (!parsed.success) return null;
  const release = parsed.data;
  const installer = release.assets.find((asset) => /\.exe$/i.test(asset.name));
  if (!installer) return null;
  return {
    name: 'FlowForge',
    version: release.tag_name.replace(/^v/, ''),
    tag: release.tag_name,
    publishedAt: release.published_at ?? new Date(0).toISOString(),
    repo,
    notes: release.body ?? '',
    downloads: [
      {
        file: installer.name,
        platform: 'windows',
        arch: 'x64',
        kind: 'installer',
        label: 'Windows installer (.exe)',
        url: installer.browser_download_url,
        size: installer.size,
        sha256: null,
        requirements: 'Windows 10 or 11, 64-bit',
      },
    ],
  };
}

type Fetcher = (
  url: string,
  init?: RequestInit & { next?: { revalidate?: number } },
) => Promise<Response>;

/** Server-side token for a private releases repository (never sent to browsers). */
export function githubToken(): string | null {
  return process.env.RELEASES_GITHUB_TOKEN?.trim() || null;
}

/**
 * Private repository: read the latest release through the API with the server's token. Download
 * links point at /download/windows, which hands the browser a short-lived signed URL.
 */
async function privateRelease(
  fetcher: Fetcher,
  repo: string,
  token: string,
): Promise<Release | null> {
  const headers = {
    authorization: `Bearer ${token}`,
    'user-agent': 'flowforge-website',
    'x-github-api-version': '2022-11-28',
  };
  const latest = await fetcher(`https://api.github.com/repos/${repo}/releases/latest`, {
    next: { revalidate: REVALIDATE_SECONDS },
    headers: { ...headers, accept: 'application/vnd.github+json' },
  });
  if (!latest.ok) {
    console.warn(`GitHub releases API answered ${latest.status} for ${repo}`);
    return null;
  }
  const data = (await latest.json()) as { assets?: Array<{ id: number; name: string }> };
  const manifest = data.assets?.find((asset) => asset.name === 'release.json');
  let release: Release | null = null;
  if (manifest) {
    const file = await fetcher(
      `https://api.github.com/repos/${repo}/releases/assets/${manifest.id}`,
      {
        next: { revalidate: REVALIDATE_SECONDS },
        headers: { ...headers, accept: 'application/octet-stream' },
      },
    );
    if (file.ok) {
      const parsed = releaseSchema.safeParse(await file.json());
      if (parsed.success) release = parsed.data;
    }
  }
  release ??= fromGithubRelease(data, repo);
  if (!release) return null;
  return {
    ...release,
    downloads: release.downloads.map((d) =>
      d.platform === 'windows' ? { ...d, url: '/download/windows' } : d,
    ),
  };
}

export async function getLatestRelease(fetcher: Fetcher = fetch): Promise<Release | null> {
  const repo = releasesRepo();
  const token = githubToken();
  if (token && !process.env.RELEASE_MANIFEST_URL) {
    try {
      return await privateRelease(fetcher, repo, token);
    } catch (error) {
      console.warn('Could not load the private release:', (error as Error).message);
      return null;
    }
  }
  const options = {
    next: { revalidate: REVALIDATE_SECONDS },
    headers: { accept: 'application/json' },
  };
  try {
    const response = await fetcher(manifestUrl(repo), options);
    if (response.ok) {
      const parsed = releaseSchema.safeParse(await response.json());
      if (parsed.success) return parsed.data;
      console.warn('release.json is not valid:', parsed.error.issues.slice(0, 3));
    }
  } catch (error) {
    console.warn('Could not load release.json:', (error as Error).message);
  }
  try {
    const response = await fetcher(`https://api.github.com/repos/${repo}/releases/latest`, {
      ...options,
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'flowforge-website' },
    });
    if (response.ok) return fromGithubRelease(await response.json(), repo);
  } catch (error) {
    console.warn('Could not load the latest GitHub release:', (error as Error).message);
  }
  return null;
}

/**
 * A short-lived download link for a release file of a private repository: GitHub answers the
 * authenticated asset request with a redirect to a signed URL, which is safe to give the browser.
 */
export async function signedAssetUrl(
  fileName: string,
  fetcher: Fetcher = fetch,
): Promise<string | null> {
  const token = githubToken();
  if (!token) return null;
  const repo = releasesRepo();
  const headers = { authorization: `Bearer ${token}`, 'user-agent': 'flowforge-website' };
  const latest = await fetcher(`https://api.github.com/repos/${repo}/releases/latest`, {
    cache: 'no-store',
    headers: { ...headers, accept: 'application/vnd.github+json' },
  });
  if (!latest.ok) return null;
  const { assets } = (await latest.json()) as { assets?: Array<{ id: number; name: string }> };
  const asset = assets?.find((a) => a.name === fileName);
  if (!asset) return null;
  const file = await fetcher(`https://api.github.com/repos/${repo}/releases/assets/${asset.id}`, {
    cache: 'no-store',
    redirect: 'manual',
    headers: { ...headers, accept: 'application/octet-stream' },
  });
  return file.headers.get('location');
}

export function windowsDownload(release: Release | null): Download | null {
  return release?.downloads.find((d) => d.platform === 'windows') ?? null;
}

export function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(0)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime()) || date.getTime() === 0) return '';
  return new Intl.DateTimeFormat('en', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}
