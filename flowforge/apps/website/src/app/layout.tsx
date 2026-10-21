import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { SiteFooter, SiteHeader } from '@/components/chrome';
import './globals.css';

export const metadata: Metadata = {
  title: {
    default: 'AutoForge - workflow automation that runs on your PC',
    template: '%s · AutoForge',
  },
  description:
    'Visual workflow automation for Windows: webhooks, schedules, APIs and JavaScript, running privately on your own PC. No account and no API keys needed.',
  icons: { icon: '/favicon.svg' },
  openGraph: {
    title: 'AutoForge',
    description: 'Workflow automation that runs on your PC. Free download for Windows.',
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#fbfbfc' },
    { media: '(prefers-color-scheme: dark)', color: '#0f1014' },
  ],
};

// Applies the saved or system theme before the first paint (no flash).
const themeScript = `(function(){try{var t=localStorage.getItem('ff-theme');if(t!=='light'&&t!=='dark'){t=matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'}document.documentElement.dataset.theme=t}catch(e){}})()`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="flex min-h-screen flex-col">
        <SiteHeader />
        <main className="flex-1">{children}</main>
        <SiteFooter />
      </body>
    </html>
  );
}
