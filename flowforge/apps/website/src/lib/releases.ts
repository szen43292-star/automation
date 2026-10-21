import { z } from 'zod';

/**
 * Where the apps come from, first match wins - none of them needs a setting:
 *  1. The apps bundled into this site (public/downloads, see scripts/bundle-downloads.mjs): the
 *     release workflow commits them to the repository, so even a private repository works.
 *  2. A private repository with RELEASES_GITHUB_TOKEN: the releases API, through the server.
 *  3. Public GitHub Releases: release.json from
 *     https://github.com/<repo>/releases/latest/download/release.json (a plain file, not the API,
 *     so there is no rate limit), else the public releases API for the basic facts.
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
  name: z.string().default('AutoForge'),
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

const REPO_PATTERN = /^[\w.-]+\/[\w.-]+$/;

/**
 * Where releases come from: FLOWFORGE_RELEASES_REPO, else the GitHub repository Vercel deployed
 * this site from (Vercel sets VERCEL_GIT_REPO_OWNER / _SLUG), else the project repository.
 */
export function releasesRepo(): string {
  const repo = process.env.FLOWFORGE_RELEASES_REPO?.trim();
  if (repo && REPO_PATTERN.test(repo)) return repo;
  const { VERCEL_GIT_PROVIDER, VERCEL_GIT_REPO_OWNER, VERCEL_GIT_REPO_SLUG } = process.env;
  const deployed = `${VERCEL_GIT_REPO_OWNER ?? ''}/${VERCEL_GIT_REPO_SLUG ?? ''}`;
  if ((!VERCEL_GIT_PROVIDER || VERCEL_GIT_PROVIDER === 'github') && REPO_PATTERN.test(deployed))
    return deployed;
  return DEFAULT_REPO;
}

export function manifestUrl(repo = releasesRepo()): string {
  return (
    process.env.RELEASE_MANIFEST_URL?.trim() ||
    `https://github.com/${repo}/releases/latest/download/release.json`
  );
}

export const APP_PLATFORMS = ['windows', 'android', 'ios'] as const;
export type AppPlatform = (typeof APP_PLATFORMS)[number];

/** Release files per platform (names written by the release workflow). */
export const ASSETS: Record<
  AppPlatform,
  { file: string; match: RegExp; label: string; arch: string; requirements: string }
> = {
  windows: {
    file: 'FlowForge-Setup.exe',
    match: /\.exe$/i,
    label: 'Windows installer (.exe)',
    arch: 'x64',
    requirements: 'Windows 10 or 11, 64-bit',
  },
  android: {
    file: 'FlowForge.apk',
    match: /\.apk$/i,
    label: 'Android app (.apk)',
    arch: 'universal',
    requirements: 'Android 7 or newer',
  },
  ios: {
    file: 'FlowForge.ipa',
    match: /\.ipa$/i,
    label: 'iPhone app (.ipa)',
    arch: 'arm64',
    requirements: 'iOS 15 or newer',
  },
};

/** Maps a GitHub API release to our manifest shape (no checksums available this way). */
export function fromGithubRelease(data: unknown, repo: string): Release | null {
  const parsed = githubReleaseSchema.safeParse(data);
  if (!parsed.success) return null;
  const release = parsed.data;
  const downloads: Download[] = [];
  for (const [platform, info] of Object.entries(ASSETS) as Array<
    [AppPlatform, (typeof ASSETS)[AppPlatform]]
  >) {
    const asset = release.assets.find((a) => info.match.test(a.name));
    if (!asset) continue;
    downloads.push({
      file: asset.name,
      platform,
      arch: info.arch,
      kind: platform === 'windows' ? 'installer' : 'app',
      label: info.label,
      url: asset.browser_download_url,
      size: asset.size,
      sha256: null,
      requirements: info.requirements,
    });
  }
  if (!downloads.length) return null;
  return {
    name: 'AutoForge',
    version: release.tag_name.replace(/^v/, ''),
    tag: release.tag_name,
    publishedAt: release.published_at ?? new Date(0).toISOString(),
    repo,
    notes: release.body ?? '',
    downloads,
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
      (APP_PLATFORMS as readonly string[]).includes(d.platform)
        ? { ...d, url: `/download/${d.platform}` }
        : d,
    ),
  };
}

/** The apps built into this site (set at build time from public/downloads/release.json). */
export function bundledRelease(): Release | null {
  const raw = process.env.FLOWFORGE_BUNDLED_RELEASE;
  if (!raw) return null;
  try {
    const parsed = releaseSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function getLatestRelease(fetcher: Fetcher = fetch): Promise<Release | null> {
  const bundled = bundledRelease();
  if (bundled && APP_PLATFORMS.every((platform) => platformDownload(bundled, platform)))
    return bundled;
  const remote = await remoteRelease(fetcher);
  if (!bundled || !remote) return bundled ?? remote;
  // Apps the site does not carry (e.g. a Windows installer with keys built in) come from GitHub.
  const missing = remote.downloads.filter((d) => !platformDownload(bundled, d.platform));
  return { ...bundled, downloads: [...bundled.downloads, ...missing] };
}

async function remoteRelease(fetcher: Fetcher): Promise<Release | null> {
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

export function platformDownload(release: Release | null, platform: string): Download | null {
  return release?.downloads.find((d) => d.platform === platform) ?? null;
}

export function windowsDownload(release: Release | null): Download | null {
  return platformDownload(release, 'windows');
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

/** Shown instead of the download button when no release could be read: what to do about it. */
export function setupHint(release: Release | null): string | null {
  if (release) return null;
  return 'No apps yet: run Actions → Release on GitHub. The Windows, Android and iPhone apps are then added to this site by themselves (about 20 minutes).';
}
