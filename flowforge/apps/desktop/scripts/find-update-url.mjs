// Finds the download website the Windows app updates itself from, so nobody has to enter it:
// Vercel reports every deployment to GitHub (commit statuses "Vercel – <project>" linking to
// https://vercel.com/<team>/<project>/…, and GitHub deployments). Each project's address is tried
// and kept only if it answers /api/releases/site for this repository. UPDATE_URL (a repository
// secret) wins, e.g. for a custom domain. Prints "url=https://…" for $GITHUB_OUTPUT, or nothing.
//   GH_TOKEN=… GITHUB_REPOSITORY=owner/name node scripts/find-update-url.mjs
import { pathToFileURL } from 'node:url';

const VERCEL_LINK = /^https:\/\/vercel\.com\/([\w-]+)\/([\w-]+)(\/|$)/;

/** https://<project>.vercel.app and https://<project>-<team>.vercel.app from Vercel's links. */
export function candidatesFrom(links) {
  const urls = [];
  for (const link of links) {
    const match = typeof link === 'string' && link.match(VERCEL_LINK);
    if (!match) continue;
    const [, team, project] = match;
    urls.push(`https://${project}.vercel.app`, `https://${project}-${team}.vercel.app`);
  }
  return [...new Set(urls)];
}

export async function findUpdateUrl({ repo, token, override, fetcher = fetch, log = () => {} }) {
  if (override?.trim()) return override.trim().replace(/\/+$/, '');
  const github = async (path) => {
    const response = await fetcher(`https://api.github.com/repos/${repo}${path}`, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'user-agent': 'flowforge-build',
      },
    });
    if (!response.ok) throw new Error(`GitHub ${path} answered ${response.status}`);
    return response.json();
  };
  const links = [];
  try {
    for (const commit of await github('/commits?per_page=10')) {
      for (const status of await github(`/commits/${commit.sha}/statuses?per_page=50`)) {
        if (/^vercel/i.test(status.context ?? '')) links.push(status.target_url);
      }
    }
  } catch (error) {
    log(`Commit statuses: ${error.message}`);
  }
  try {
    for (const deployment of await github('/deployments?per_page=20')) {
      if (!/^production/i.test(deployment.environment ?? '')) continue;
      for (const status of await github(`/deployments/${deployment.id}/statuses?per_page=5`)) {
        links.push(status.log_url, status.target_url);
      }
    }
  } catch (error) {
    log(`Deployments: ${error.message}`);
  }
  for (const url of candidatesFrom(links)) {
    try {
      const response = await fetcher(`${url}/api/releases/site`, {
        signal: AbortSignal.timeout(10_000),
      });
      const site = response.ok ? await response.json() : null;
      if (site?.app === 'flowforge-website' && site.repo?.toLowerCase() === repo.toLowerCase()) {
        log(`Download website: ${url}`);
        return url;
      }
      log(`${url} is not this repository's download website`);
    } catch (error) {
      log(`${url}: ${error.message}`);
    }
  }
  log('No download website found: the app will update from GitHub Releases instead.');
  return null;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const url = await findUpdateUrl({
    repo: process.env.GITHUB_REPOSITORY ?? '',
    token: process.env.GH_TOKEN ?? '',
    override: process.env.UPDATE_URL,
    log: (line) => console.error(line),
  });
  if (url) console.log(`url=${url}`);
}
