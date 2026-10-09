import { NextResponse } from 'next/server';
import { releaseInput, startRelease } from '@/lib/admin';

export const dynamic = 'force-dynamic';

/** The admin page's "Start release" form (protected by ADMIN_PASSWORD in the proxy). */
export async function POST(request: Request) {
  const form = await request.formData();
  const back = new URL('/admin', request.url);
  const parsed = releaseInput.safeParse({
    version: String(form.get('version') ?? ''),
    notes: String(form.get('notes') ?? ''),
  });
  if (!parsed.success) {
    back.searchParams.set('error', parsed.error.issues[0]?.message ?? 'Invalid input');
    return NextResponse.redirect(back, 303);
  }
  const result = await startRelease(parsed.data);
  if (result.ok) back.searchParams.set('started', parsed.data.version);
  else back.searchParams.set('error', result.message);
  return NextResponse.redirect(back, 303);
}
