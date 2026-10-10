import { describe, expect, it } from 'vitest';
// @ts-expect-error - plain JavaScript build script
import { candidatesFrom, findUpdateUrl } from '../scripts/find-update-url.mjs';

/** The Windows app build finds the download website it updates from - no settings. */
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('finding the download website', () => {
  it('turns Vercel links into the project addresses', () => {
    expect(
      candidatesFrom([
        'https://vercel.com/acme-73b6/automation-p7ea/7WkiBoTJ9CHk2AszgEPY2LY2ZsDj',
        'https://example.com/other',
        null,
      ]),
    ).toEqual([
      'https://automation-p7ea.vercel.app',
      'https://automation-p7ea-acme-73b6.vercel.app',
    ]);
  });

  it("keeps only the site that answers for this repository, skipping other projects' sites", async () => {
    const asked: string[] = [];
    const fetcher = async (url: string) => {
      asked.push(url);
      if (url.endsWith('/commits?per_page=10')) return json([{ sha: 'abc' }]);
      if (url.endsWith('/commits/abc/statuses?per_page=50'))
        return json([
          { context: 'Vercel – automation', target_url: 'https://vercel.com/acme/automation/1' },
          { context: 'Vercel – flowforge', target_url: 'https://vercel.com/acme/flowforge/2' },
          { context: 'ci/other', target_url: 'https://vercel.com/acme/ignored/3' },
        ]);
      if (url.endsWith('/deployments?per_page=20')) return json([]);
      // automation.vercel.app belongs to someone else; flowforge.vercel.app is not live; the
      // team address is ours.
      if (url === 'https://automation.vercel.app/api/releases/site')
        return json({ app: 'something-else' });
      if (url === 'https://flowforge.vercel.app/api/releases/site') return json({}, 404);
      if (url === 'https://flowforge-acme.vercel.app/api/releases/site')
        return json({ app: 'flowforge-website', repo: 'Owner/Automation' });
      return json({}, 404);
    };
    const url = await findUpdateUrl({ repo: 'owner/automation', token: 't', fetcher });
    expect(url).toBe('https://flowforge-acme.vercel.app');
    expect(asked.some((u) => u.includes('ignored'))).toBe(false);
  });

  it('an UPDATE_URL secret wins; nothing found means GitHub Releases', async () => {
    expect(
      await findUpdateUrl({ repo: 'o/r', token: 't', override: 'https://dl.example.com/' }),
    ).toBe('https://dl.example.com');
    const fetcher = async () => json([], 200);
    expect(await findUpdateUrl({ repo: 'o/r', token: 't', fetcher })).toBeNull();
  });
});
