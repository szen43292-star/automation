import { NextResponse } from 'next/server';
import {
  APP_PLATFORMS,
  ASSETS,
  bundledRelease,
  getLatestRelease,
  githubToken,
  platformDownload,
  releasesRepo,
  signedAssetUrl,
  type AppPlatform,
} from '@/lib/releases';

// Signed GitHub links expire, so this route always runs fresh.
export const dynamic = 'force-dynamic';

const NAMES: Record<AppPlatform, string> = {
  windows: 'Windows installer',
  android: 'Android app',
  ios: 'iPhone app',
};

/** Short, permanent links to the newest apps: /download/windows, /download/android, /download/ios */
export async function GET(request: Request, context: { params: Promise<{ platform: string }> }) {
  const { platform } = await context.params;
  if (!(APP_PLATFORMS as readonly string[]).includes(platform)) {
    return NextResponse.json({ error: 'NotFound', message: 'Unknown platform' }, { status: 404 });
  }
  const app = platform as AppPlatform;
  // Built into this site: a plain file next to the pages.
  const bundled = platformDownload(bundledRelease(), app);
  if (bundled) return NextResponse.redirect(new URL(bundled.url, request.url), 302);
  if (githubToken()) {
    // Private repository: hand out a short-lived signed link instead of the token.
    const signed = await signedAssetUrl(ASSETS[app].file).catch(() => null);
    if (signed) return NextResponse.redirect(signed, 302);
    return NextResponse.json(
      { error: 'NotFound', message: `No ${NAMES[app]} has been released yet` },
      { status: 404 },
    );
  }
  const download = platformDownload(await getLatestRelease(), app);
  const target = download?.url ?? `https://github.com/${releasesRepo()}/releases/latest`;
  return NextResponse.redirect(target, 302);
}
