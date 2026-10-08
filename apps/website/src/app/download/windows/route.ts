import { NextResponse } from 'next/server';
import {
  getLatestRelease,
  githubToken,
  releasesRepo,
  signedAssetUrl,
  windowsDownload,
} from '@/lib/releases';

// Signed GitHub links expire, so this route always runs fresh.
export const dynamic = 'force-dynamic';

/** A short, permanent link to the newest Windows installer: /download/windows */
export async function GET() {
  if (githubToken()) {
    // Private repository: hand out a short-lived signed link instead of the token.
    const signed = await signedAssetUrl('FlowForge-Setup.exe').catch(() => null);
    if (signed) return NextResponse.redirect(signed, 302);
    return NextResponse.json(
      { error: 'NotFound', message: 'No Windows installer has been released yet' },
      { status: 404 },
    );
  }
  const download = windowsDownload(await getLatestRelease());
  const target = download?.url ?? `https://github.com/${releasesRepo()}/releases/latest`;
  return NextResponse.redirect(target, 302);
}
