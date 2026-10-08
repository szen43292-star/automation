import { NextResponse } from 'next/server';
import { getLatestRelease, releasesRepo, windowsDownload } from '@/lib/releases';

// Re-check GitHub for a new release every 5 minutes (must be a literal for Next.js).
export const revalidate = 300;

/** A short, permanent link to the newest Windows installer: /download/windows */
export async function GET() {
  const download = windowsDownload(await getLatestRelease());
  const target = download?.url ?? `https://github.com/${releasesRepo()}/releases/latest`;
  return NextResponse.redirect(target, 302);
}
