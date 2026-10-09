'use client';

import { Download, Monitor, Smartphone } from 'lucide-react';
import Link from 'next/link';
import { platformNames } from '@/lib/platform';
import { formatSize, type Download as DownloadInfo } from '@/lib/releases';
import { usePlatform } from './use-platform';

function WindowsIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M3 5.5 10.5 4.5v7H3v-6zm0 13 7.5 1v-7H3v6zm8.5 1.1L21 21v-8.5h-9.5v7.1zm0-15.2v7.1H21V3l-9.5 1.4z" />
    </svg>
  );
}

interface Props {
  download: DownloadInfo | null;
  version: string | null;
  releasesUrl: string;
  size?: 'lg' | 'md';
  showDetailsLink?: boolean;
  /** Hide the "not on Windows" notices (e.g. in a compact call to action). */
  hideNotices?: boolean;
  /** Why there is nothing to download yet (from the server). */
  setupHint?: string | null;
  /** Phone apps of the same release: phone visitors get their app first. */
  phones?: { android?: DownloadInfo | null; ios?: DownloadInfo | null };
}

export function DownloadButton({
  download,
  version,
  releasesUrl,
  size = 'lg',
  showDetailsLink,
  hideNotices,
  phones,
  setupHint,
}: Props) {
  const platform = usePlatform();
  const big = size === 'lg';
  const buttonClass = `inline-flex items-center justify-center gap-2.5 rounded-xl bg-accent font-semibold text-white shadow-[0_8px_24px_-8px_rgb(255_109_58/0.7)] transition hover:bg-accent-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${big ? 'h-13 px-7 text-[16px]' : 'h-11 px-5 text-[15px]'}`;

  const phoneApp =
    platform === 'android' ? phones?.android : platform === 'ios' ? phones?.ios : null;

  if (phoneApp) {
    return (
      <div className="flex flex-col items-start gap-3">
        <a
          href={phoneApp.url}
          className={buttonClass}
          download
          data-testid={`download-${platform}`}
        >
          <Smartphone size={20} /> Download for {platformNames[platform as 'android' | 'ios']}
        </a>
        <p className="text-[13px] text-muted">
          {[`Version ${version}`, formatSize(phoneApp.size), phoneApp.requirements]
            .filter(Boolean)
            .join(' · ')}
        </p>
      </div>
    );
  }

  if (!download) {
    return (
      <div className="flex flex-col items-start gap-3">
        <span className={`${buttonClass} cursor-not-allowed opacity-60`} aria-disabled="true">
          <WindowsIcon /> Download for Windows
        </span>
        {setupHint && (
          <p className="max-w-md text-sm text-muted" data-testid="setup-hint">
            {setupHint}
          </p>
        )}
        <p className="text-sm text-muted">
          The first release is on its way.{' '}
          <a
            href={releasesUrl}
            className="font-medium text-accent-strong underline underline-offset-2"
          >
            Check GitHub Releases
          </a>
        </p>
      </div>
    );
  }

  const meta = [
    `Version ${version}`,
    formatSize(download.size),
    download.requirements ?? 'Windows 10 or 11, 64-bit',
  ].join(' · ');
  const mobile = platform === 'android' || platform === 'ios';
  const otherDesktop = platform === 'macos' || platform === 'linux';
  return (
    <div className="flex flex-col items-start gap-3">
      {mobile && !hideNotices && (
        <div className="flex max-w-md items-start gap-2.5 rounded-xl border border-line bg-panel px-4 py-3 text-sm text-muted">
          <Smartphone size={18} className="mt-0.5 shrink-0 text-accent" />
          <span>
            The {platformNames[platform]} app is not in this release yet. FlowForge runs on a
            Windows PC - open this page there to install it.
          </span>
        </div>
      )}
      {otherDesktop && !hideNotices && (
        <div className="flex max-w-md items-start gap-2.5 rounded-xl border border-line bg-panel px-4 py-3 text-sm text-muted">
          <Monitor size={18} className="mt-0.5 shrink-0 text-accent" />
          <span>
            FlowForge is available for Windows. {platformNames[platform]} support is planned.
          </span>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <a href={download.url} className={buttonClass} download data-testid="download-windows">
          {big ? <WindowsIcon size={20} /> : <Download size={18} />}
          {otherDesktop || mobile ? 'Download for Windows anyway' : 'Download for Windows'}
        </a>
        {showDetailsLink && (
          <Link
            href="/download"
            className="px-2 text-sm font-medium text-muted underline-offset-4 hover:text-fg hover:underline"
          >
            Checksums &amp; release notes
          </Link>
        )}
      </div>
      <p className="text-[13px] text-muted">{meta}</p>
    </div>
  );
}
