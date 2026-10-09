import { NextResponse, type NextRequest } from 'next/server';

/**
 * Optional password for the whole site (SITE_PASSWORD). Use it when the installer is a private
 * build - for example one with your own API keys built in - so only you can download it.
 * /admin (release admin) always needs ADMIN_PASSWORD.
 */
export function proxy(request: NextRequest) {
  // The release admin has its own password and does not exist without one.
  if (request.nextUrl.pathname === '/admin' || request.nextUrl.pathname.startsWith('/admin/')) {
    const admin = process.env.ADMIN_PASSWORD;
    if (!admin) return new NextResponse('Not found', { status: 404 });
    return passwordGate(request, admin, 'FlowForge admin');
  }
  const password = process.env.SITE_PASSWORD;
  if (!password) return NextResponse.next();
  return passwordGate(request, password, 'FlowForge');
}

function passwordGate(request: NextRequest, password: string, realm: string) {
  const header = request.headers.get('authorization') ?? '';
  const [scheme, encoded] = header.split(' ');
  if (scheme === 'Basic' && encoded) {
    const decoded = atob(encoded);
    const given = decoded.slice(decoded.indexOf(':') + 1);
    if (safeEqual(given, password)) return NextResponse.next();
  }
  return new NextResponse('Password required', {
    status: 401,
    headers: { 'WWW-Authenticate': `Basic realm="${realm}", charset="UTF-8"` },
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
