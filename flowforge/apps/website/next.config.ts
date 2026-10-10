import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NextConfig } from 'next';

// Apps bundled into the site by scripts/bundle-downloads.mjs (run before `next build`).
const bundled = join(process.cwd(), 'public', 'downloads', 'release.json');

const config: NextConfig = {
  reactStrictMode: true,
  env: {
    FLOWFORGE_BUNDLED_RELEASE: existsSync(bundled) ? readFileSync(bundled, 'utf8') : '',
  },
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
        ],
      },
    ];
  },
};

export default config;
