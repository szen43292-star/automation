import { Download } from 'lucide-react';
import Link from 'next/link';
import { releasesRepo } from '@/lib/releases';
import { LogoMark } from './logo';
import { ThemeToggle } from './theme-toggle';

function GithubIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 border-b border-line/70 bg-bg/80 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-6xl items-center gap-6 px-4 sm:px-6">
        <Link href="/" className="flex items-center gap-2.5 font-semibold tracking-tight">
          <LogoMark />
          <span className="text-[17px]">FlowForge</span>
        </Link>
        <nav className="hidden items-center gap-1 text-sm text-muted md:flex">
          <Link href="/#features" className="rounded-md px-3 py-1.5 transition hover:text-fg">
            Features
          </Link>
          <Link href="/#how-it-works" className="rounded-md px-3 py-1.5 transition hover:text-fg">
            How it works
          </Link>
          <Link href="/#roadmap" className="rounded-md px-3 py-1.5 transition hover:text-fg">
            Roadmap
          </Link>
          <Link href="/download#faq" className="rounded-md px-3 py-1.5 transition hover:text-fg">
            FAQ
          </Link>
        </nav>
        <div className="ml-auto flex items-center gap-1.5">
          <ThemeToggle />
          <Link
            href="/download"
            className="inline-flex h-9 items-center gap-2 rounded-lg bg-accent px-3.5 text-sm font-semibold text-white shadow-sm transition hover:bg-accent-strong"
          >
            <Download size={16} />
            <span>Download</span>
          </Link>
        </div>
      </div>
    </header>
  );
}

export function SiteFooter() {
  const repo = releasesRepo();
  return (
    <footer className="border-t border-line bg-bg-2/50">
      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-10 text-sm text-muted sm:flex-row sm:items-center sm:px-6">
        <div className="flex items-center gap-2.5">
          <LogoMark size={22} />
          <span className="font-medium text-fg">FlowForge</span>
          <span>· Workflow automation that runs on your PC</span>
        </div>
        <div className="flex items-center gap-5 sm:ml-auto">
          <Link href="/download" className="transition hover:text-fg">
            Download
          </Link>
          <Link href="/download#faq" className="transition hover:text-fg">
            FAQ
          </Link>
          <a
            href={`https://github.com/${repo}/releases`}
            className="inline-flex items-center gap-1.5 transition hover:text-fg"
            rel="noopener noreferrer"
          >
            <GithubIcon /> Releases
          </a>
        </div>
      </div>
    </footer>
  );
}
