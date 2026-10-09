'use client';

import QRCode from 'qrcode';
import { useEffect, useState } from 'react';

/** QR code for the current page, so it can be opened on a phone. Generated in the browser. */
export function PageQrCode({ size = 132 }: { size?: number }) {
  const [svg, setSvg] = useState<string | null>(null);
  useEffect(() => {
    const url = window.location.href.split('#')[0] ?? window.location.href;
    QRCode.toString(url, {
      type: 'svg',
      margin: 1,
      errorCorrectionLevel: 'M',
      color: { dark: '#14151a', light: '#ffffff' },
    })
      .then(setSvg)
      .catch(() => setSvg(null));
  }, []);
  return (
    <div
      className="shrink-0 overflow-hidden rounded-lg bg-white p-1.5 ring-1 ring-line [&_svg]:block [&_svg]:size-full"
      style={{ width: size, height: size }}
      aria-label="QR code for this page"
      role="img"
      // The SVG is generated locally by the qrcode library from this page's own URL.
      dangerouslySetInnerHTML={svg ? { __html: svg } : undefined}
    />
  );
}
