import { NextResponse, type NextRequest } from 'next/server';

/**
 * Optional password for the whole site (SITE_PASSWORD). Use it when the installer is a private
 * build - for example one with your own API keys built in - so only you can download it.
 */
export function proxy(request: NextRequest) {
  const password = process.env.SITE_PASSWORD;
  if (!password) return NextResponse.next();
  const header = request.headers.get('authorization') ?? '';
  const [scheme, encoded] = header.split(' ');
  if (scheme === 'Basic' && encoded) {
    const decoded = atob(encoded);
    const given = decoded.slice(decoded.indexOf(':') + 1);
    if (safeEqual(given, password)) return NextResponse.next();
  }
  return new NextResponse('Password required', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="FlowForge", charset="UTF-8"' },
  });
}

function safeEqual(a: string, b: string) {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++)
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.svg).*)'],
};
