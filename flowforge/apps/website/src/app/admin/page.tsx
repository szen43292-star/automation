import { CheckCircle2, CircleDashed, ExternalLink, Rocket, XCircle } from 'lucide-react';
import type { Metadata } from 'next';
import { adminOverview } from '@/lib/admin';
import { formatDate, formatSize, releasesRepo } from '@/lib/releases';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Releases admin', robots: { index: false } };

const platformOf = (file: string) =>
  file.endsWith('.exe')
    ? 'Windows'
    : file.endsWith('.apk')
      ? 'Android'
      : file.endsWith('.ipa')
        ? 'iPhone'
        : null;

export default async function AdminPage({
  searchParams,
}: {
  searchParams: Promise<{ started?: string; error?: string }>;
}) {
  const { started, error } = await searchParams;
  const data = await adminOverview().catch((e: Error) => ({
    configured: true as const,
    releases: [],
    runs: [],
    nextVersion: '0.3.0',
    error: e.message,
  }));
  const repo = releasesRepo();

  return (
    <div className="mx-auto max-w-5xl px-4 py-12 sm:px-6">
      <h1 className="text-3xl font-bold tracking-tight">Releases</h1>
      <p className="mt-2 text-muted">
        Build the Windows, Android and iPhone apps and publish them together. Repository{' '}
        <a href={`https://github.com/${repo}`} className="text-accent-strong underline">
          {repo}
        </a>
        .
      </p>

      {started && (
        <div
          className="mt-6 rounded-xl border border-success/40 bg-success/10 p-4 text-sm"
          data-testid="started"
        >
          Release {started} started - the builds take about 20 minutes. Refresh to follow them
          below.
        </div>
      )}
      {(error || ('error' in data && data.error)) && (
        <div
          className="mt-6 rounded-xl border border-red-500/40 bg-red-500/10 p-4 text-sm"
          data-testid="admin-error"
        >
          {error || ('error' in data ? data.error : '')}
        </div>
      )}

      {!data.configured ? (
        <div className="mt-8 rounded-2xl border border-line bg-panel p-6 text-sm leading-relaxed text-muted">
          Set <code>RELEASES_GITHUB_TOKEN</code> on the website (a fine-grained token for {repo}{' '}
          with Contents: read and Actions: read &amp; write) to see releases and start new ones
          here.
        </div>
      ) : (
        <>
          <form
            action="/admin/release"
            method="post"
            className="mt-8 rounded-2xl border border-line bg-panel p-6"
          >
            <h2 className="flex items-center gap-2 font-semibold">
              <Rocket size={18} className="text-accent" /> Start a release
            </h2>
            <div className="mt-4 grid gap-4 sm:grid-cols-[180px_1fr]">
              <label className="text-sm">
                <span className="mb-1 block font-medium">Version</span>
                <input
                  name="version"
                  defaultValue={data.nextVersion}
                  required
                  className="h-10 w-full rounded-lg border border-line bg-bg px-3"
                />
              </label>
              <label className="text-sm">
                <span className="mb-1 block font-medium">Release notes (optional)</span>
                <textarea
                  name="notes"
                  rows={3}
                  placeholder="Empty = the list of changes since the last release"
                  className="w-full rounded-lg border border-line bg-bg px-3 py-2"
                />
              </label>
            </div>
            <button className="mt-4 inline-flex h-10 items-center gap-2 rounded-xl bg-accent px-5 text-sm font-semibold text-white hover:bg-accent-strong">
              <Rocket size={16} /> Build and publish
            </button>
          </form>

          <section className="mt-10">
            <h2 className="text-xl font-semibold">Builds</h2>
            <div className="mt-3 divide-y divide-line rounded-2xl border border-line bg-panel">
              {data.runs.length === 0 && (
                <div className="p-4 text-sm text-muted">No builds yet.</div>
              )}
              {data.runs.map((run) => (
                <a
                  key={run.id}
                  href={run.url}
                  className="flex items-center gap-3 px-4 py-3 text-sm hover:bg-bg-2"
                  data-testid="run"
                >
                  {run.status !== 'completed' ? (
                    <CircleDashed size={16} className="animate-spin text-accent" />
                  ) : run.conclusion === 'success' ? (
                    <CheckCircle2 size={16} className="text-success" />
                  ) : (
                    <XCircle size={16} className="text-red-500" />
                  )}
                  <span className="w-28 shrink-0 font-medium">{run.workflow}</span>
                  <span className="min-w-0 flex-1 truncate text-muted">{run.title}</span>
                  <span className="hidden text-xs text-muted sm:inline">{run.branch}</span>
                  <span className="text-xs text-muted">{formatDate(run.createdAt)}</span>
                </a>
              ))}
            </div>
          </section>

          <section className="mt-10">
            <h2 className="text-xl font-semibold">Published</h2>
            <div className="mt-3 space-y-3">
              {data.releases.length === 0 && (
                <div className="text-sm text-muted">Nothing published yet.</div>
              )}
              {data.releases.map((release) => (
                <div
                  key={release.tag}
                  className="rounded-2xl border border-line bg-panel p-5"
                  data-testid="release"
                >
                  <div className="flex items-center gap-3">
                    <span className="font-semibold">{release.name}</span>
                    {release.draft && <span className="text-xs text-muted">draft</span>}
                    <span className="text-sm text-muted">
                      {release.publishedAt ? formatDate(release.publishedAt) : ''}
                    </span>
                    <a
                      href={release.url}
                      className="ml-auto text-muted hover:text-fg"
                      title="On GitHub"
                    >
                      <ExternalLink size={16} />
                    </a>
                  </div>
                  <ul className="mt-3 grid gap-1 text-sm sm:grid-cols-3">
                    {release.files
                      .filter((f) => platformOf(f.name))
                      .map((f) => (
                        <li key={f.name} className="rounded-lg bg-bg-2 px-3 py-2">
                          <div className="font-medium">{platformOf(f.name)}</div>
                          <div className="text-xs text-muted">
                            {formatSize(f.size)} · {f.downloads} downloads
                          </div>
                        </li>
                      ))}
                  </ul>
                </div>
              ))}
            </div>
          </section>
        </>
      )}
    </div>
  );
}
