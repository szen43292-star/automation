import { NextResponse } from 'next/server';
import { releasesRepo } from '@/lib/releases';

/**
 * Identifies this site: the Windows app build looks for its download website (where updates come
 * from) and checks here that the site belongs to the same repository. Public, no data.
 */
export function GET() {
  return NextResponse.json({ app: 'flowforge-website', repo: releasesRepo() });
}
