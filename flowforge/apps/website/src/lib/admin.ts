import { z } from 'zod';
import { githubToken, releasesRepo } from './releases';

/**
 * Release admin (/admin, behind ADMIN_PASSWORD): releases with their files and download counts,
 * the latest build runs, and "Start a release" - which runs the Release workflow on GitHub. Uses
 * RELEASES_GITHUB_TOKEN on the server (needs Contents: read and Actions: read & write).
 */
type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

const api = (path: string) => `https://api.github.com/repos/${releasesRepo()}${path}`;
const headers = (token: string) => ({
  authorization: `Bearer ${token}`,
  accept: 'application/vnd.github+json',
  'user-agent': 'flowforge-website',
  'x-github-api-version': '2022-11-28',
});

export interface AdminRelease {
  tag: string;
  name: string;
  publishedAt: string | null;
  draft: boolean;
  url: string;
  files: Array<{ name: string; size: number; downloads: number }>;
}

export interface AdminRun {
  id: number;
  workflow: string;
  title: string;
  branch: string;
  status: string;
  conclusion: string | null;
  createdAt: string;
  url: string;
}

const releaseList = z.array(
  z.object({
    tag_name: z.string(),
    name: z.string().nullable(),
    published_at: z.string().nullable(),
    draft: z.boolean(),
    html_url: z.string(),
    assets: z.array(z.object({ name: z.string(), size: z.number(), download_count: z.number() })),
  }),
);

const runList = z.object({
  workflow_runs: z.array(
    z.object({
      id: z.number(),
      name: z.string().nullable(),
      display_title: z.string(),
      head_branch: z.string().nullable(),
      status: z.string().nullable(),
      conclusion: z.string().nullable(),
      created_at: z.string(),
      html_url: z.string(),
    }),
  ),
});

export async function adminOverview(fetcher: Fetcher = fetch) {
  const token = githubToken();
  if (!token) return { configured: false as const };
  const [releasesResponse, runsResponse] = await Promise.all([
    fetcher(api('/releases?per_page=10'), { headers: headers(token), cache: 'no-store' }),
    fetcher(api('/actions/runs?per_page=15'), { headers: headers(token), cache: 'no-store' }),
  ]);
  const releases: AdminRelease[] = releasesResponse.ok
    ? releaseList.parse(await releasesResponse.json()).map((r) => ({
        tag: r.tag_name,
        name: r.name ?? r.tag_name,
        publishedAt: r.published_at,
        draft: r.draft,
        url: r.html_url,
        files: r.assets.map((a) => ({ name: a.name, size: a.size, downloads: a.download_count })),
      }))
    : [];
  const runs: AdminRun[] = runsResponse.ok
    ? runList
        .parse(await runsResponse.json())
        .workflow_runs.filter((r) =>
          ['Release', 'Windows app', 'Phone apps', 'CI'].includes(r.name ?? ''),
        )
        .map((r) => ({
          id: r.id,
          workflow: r.name ?? '',
          title: r.display_title,
          branch: r.head_branch ?? '',
          status: r.status ?? 'unknown',
          conclusion: r.conclusion,
          createdAt: r.created_at,
          url: r.html_url,
        }))
    : [];
  return {
    configured: true as const,
    releases,
    runs,
    nextVersion: nextVersion(releases[0]?.tag),
    error: releasesResponse.ok
      ? null
      : `GitHub answered ${releasesResponse.status} - check RELEASES_GITHUB_TOKEN`,
  };
}

/** v0.3.1 → 0.3.2; nothing yet → 0.3.0 */
export function nextVersion(tag: string | undefined): string {
  const match = tag?.match(/^v?(\d+)\.(\d+)\.(\d+)/);
  if (!match) return '0.3.0';
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

export const releaseInput = z.object({
  version: z
    .string()
    .trim()
    .transform((v) => v.replace(/^v/, ''))
    .pipe(z.string().regex(/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/, 'Use a version like 1.2.3')),
  notes: z.string().max(10_000).default(''),
});

/** Runs .github/workflows/release.yml: Windows, Android and iPhone builds, then one release. */
export async function startRelease(
  input: z.infer<typeof releaseInput>,
  fetcher: Fetcher = fetch,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const token = githubToken();
  if (!token) return { ok: false, message: 'RELEASES_GITHUB_TOKEN is not set' };
  const response = await fetcher(api('/actions/workflows/release.yml/dispatches'), {
    method: 'POST',
    headers: { ...headers(token), 'content-type': 'application/json' },
    body: JSON.stringify({
      ref: process.env.RELEASES_BRANCH?.trim() || 'main',
      inputs: { version: input.version, notes: input.notes },
    }),
  });
  if (response.status === 204) return { ok: true };
  const body = (await response.json().catch(() => ({}))) as { message?: string };
  return {
    ok: false,
    message:
      response.status === 403 || response.status === 404
        ? 'The token cannot run workflows - give it "Actions: read and write" on the repository'
        : `GitHub answered ${response.status}: ${body.message ?? ''}`,
  };
}
