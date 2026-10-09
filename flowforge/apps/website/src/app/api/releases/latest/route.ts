import { NextResponse } from 'next/server';
import { getLatestRelease, REVALIDATE_SECONDS } from '@/lib/releases';

// Re-check GitHub for a new release every 5 minutes (must be a literal for Next.js).
export const revalidate = 300;

/** Release metadata for apps and scripts: GET /api/releases/latest (public, no key). */
export async function GET() {
  const release = await getLatestRelease();
  if (!release) {
    return NextResponse.json(
      { error: 'NotFound', message: 'No release has been published yet' },
      { status: 404 },
    );
  }
  return NextResponse.json(release, {
    headers: {
      'Cache-Control': `public, s-maxage=${REVALIDATE_SECONDS}, stale-while-revalidate=86400`,
      'Access-Control-Allow-Origin': '*',
    },
  });
}
