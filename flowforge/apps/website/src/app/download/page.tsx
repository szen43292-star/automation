import { AlertTriangle, Calendar, FileDown, HardDrive, ShieldCheck, Tag } from 'lucide-react';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { CopyButton } from '@/components/copy-button';
import { DownloadButton } from '@/components/download-button';
import { PageQrCode } from '@/components/qr-code';
import { Markdown } from '@/lib/markdown';
import {
  formatDate,
  formatSize,
  getLatestRelease,
  platformDownload,
  releasesRepo,
  setupHint,
  windowsDownload,
  type Download,
} from '@/lib/releases';

// Re-check GitHub for a new release every 5 minutes (must be a literal for Next.js).
export const revalidate = 300;

export const metadata: Metadata = {
  title: 'Download for Windows',
  description:
    'Download FlowForge for Windows 10 and 11. One-click install, no administrator rights, no API keys. SHA-256 checksums and release notes.',
};

export default async function DownloadPage() {
  const release = await getLatestRelease();
  const download = windowsDownload(release);
  const android = platformDownload(release, 'android');
  const ios = platformDownload(release, 'ios');
  const repo = releasesRepo();
  const releasesUrl = `https://github.com/${repo}/releases`;

  return (
    <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6 sm:py-20">
      <div className="grid gap-10 lg:grid-cols-[1fr_340px]">
        <div>
          <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">Download FlowForge</h1>
          <p className="mt-4 max-w-2xl text-lg leading-relaxed text-muted">
            Everything is included: the editor, the automation server and its database. Install it
            and start building - no API keys, no account, no configuration.
          </p>
          <div className="mt-8">
            <DownloadButton
              download={download}
              version={release?.version ?? null}
              releasesUrl={releasesUrl}
              phones={{ android, ios }}
              setupHint={setupHint(release)}
            />
          </div>
        </div>

        <aside className="hidden h-fit items-center gap-4 rounded-2xl border border-line bg-panel p-5 lg:flex">
          <PageQrCode />
          <div className="text-sm">
            <div className="font-semibold">On your phone?</div>
            <p className="mt-1 leading-relaxed text-muted">
              Scan to open this page on your phone and install the app there.
            </p>
          </div>
        </aside>
      </div>

      {(android || ios) && (
        <section className="mt-14" aria-labelledby="phones-heading">
          <h2 id="phones-heading" className="text-2xl font-bold tracking-tight">
            Phone apps
          </h2>
          <p className="mt-2 max-w-2xl text-muted">
            Answer WhatsApp calls, chat with customers and watch your AI agent from your phone. The
            app connects to your FlowForge (the Windows app or your server).
          </p>
          <div className="mt-6 grid gap-4 md:grid-cols-2">
            {android && (
              <PhoneCard
                download={android}
                title="Android"
                steps={[
                  'Download FlowForge.apk on your phone.',
                  'Open it and allow your browser to install apps when asked.',
                  'Sign in with your FlowForge account.',
                ]}
              />
            )}
            {ios && (
              <PhoneCard
                download={ios}
                title="iPhone"
                steps={
                  ios.requirements?.includes('unsigned')
                    ? [
                        'Install AltStore or Sideloadly on your computer.',
                        'Download FlowForge.ipa and install it with your Apple ID.',
                        'Sign in with your FlowForge account.',
                      ]
                    : [
                        'Download FlowForge.ipa on an iPhone registered in your Apple developer account.',
                        'Open it to install, then trust the developer in Settings → General → VPN & Device Management.',
                        'Sign in with your FlowForge account.',
                      ]
                }
              />
            )}
          </div>
        </section>
      )}

      {release && download && (
        <section
          className="mt-14 grid gap-4 lg:grid-cols-[1fr_340px]"
          aria-labelledby="release-heading"
        >
          <div className="rounded-2xl border border-line bg-panel p-6 sm:p-8">
            <h2 id="release-heading" className="text-xl font-semibold tracking-tight">
              What&apos;s new in {release.version}
            </h2>
            <div className="mt-4 text-[15px] leading-relaxed text-muted">
              {release.notes ? (
                <Markdown source={release.notes} />
              ) : (
                <p>Bug fixes and improvements.</p>
              )}
            </div>
            <a
              href={`${releasesUrl}/tag/${release.tag}`}
              className="mt-6 inline-block text-sm font-medium text-accent-strong underline-offset-4 hover:underline"
              rel="noopener noreferrer"
            >
              All releases on GitHub →
            </a>
          </div>

          <div className="rounded-2xl border border-line bg-panel p-6">
            <h2 className="font-semibold">Release details</h2>
            <dl className="mt-4 grid gap-3 text-sm">
              <Detail icon={<Tag size={16} />} label="Version">
                {release.version}
              </Detail>
              {formatDate(release.publishedAt) && (
                <Detail icon={<Calendar size={16} />} label="Released">
                  {formatDate(release.publishedAt)}
                </Detail>
              )}
              <Detail icon={<FileDown size={16} />} label="File">
                {download.file}
              </Detail>
              <Detail icon={<HardDrive size={16} />} label="Size">
                {formatSize(download.size)}
              </Detail>
            </dl>
            {download.sha256 && (
              <div className="mt-5 border-t border-line pt-5">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <ShieldCheck size={16} className="text-success" /> SHA-256
                </div>
                <div className="mt-2 flex items-start gap-2">
                  <code
                    className="min-w-0 flex-1 rounded-md bg-bg-2 px-2.5 py-1.5 font-mono text-[12px] leading-relaxed break-all"
                    data-testid="sha256"
                  >
                    {download.sha256}
                  </code>
                  <CopyButton value={download.sha256} />
                </div>
                <p className="mt-3 text-xs leading-relaxed text-muted">
                  To verify, run in PowerShell and compare:
                  <code className="mt-1.5 block rounded-md bg-bg-2 px-2.5 py-1.5 font-mono text-[11.5px] break-all text-fg">
                    Get-FileHash .\{download.file} -Algorithm SHA256
                  </code>
                </p>
              </div>
            )}
          </div>
        </section>
      )}

      <section className="mt-14" aria-labelledby="install-heading">
        <h2 id="install-heading" className="text-2xl font-bold tracking-tight">
          Install in a minute
        </h2>
        <ol className="mt-6 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          <InstallStep n={1} title="Run the installer">
            Open{' '}
            <strong className="font-medium text-fg">
              {download?.file ?? 'FlowForge-Setup.exe'}
            </strong>{' '}
            from your Downloads folder. No administrator rights needed.
          </InstallStep>
          <InstallStep n={2} title="If Windows warns you">
            Click <strong className="font-medium text-fg">More info</strong>, then{' '}
            <strong className="font-medium text-fg">Run anyway</strong>. See the note below.
          </InstallStep>
          <InstallStep n={3} title="Create your account">
            FlowForge opens by itself. Create the owner account - it is stored only on your PC.
          </InstallStep>
          <InstallStep n={4} title="Build & leave it running">
            Close the window any time: FlowForge keeps your workflows running from the tray.
          </InstallStep>
        </ol>

        <div className="mt-6 flex gap-3 rounded-2xl border border-warning-line bg-warning-soft p-5 text-[15px] leading-relaxed">
          <AlertTriangle size={20} className="mt-0.5 shrink-0 text-[#c98a00]" />
          <div>
            <div className="font-semibold">
              About the &ldquo;Windows protected your PC&rdquo; message
            </div>
            <p className="mt-1 text-muted">
              Windows SmartScreen shows this for apps that are new or not yet code-signed with a
              paid certificate - it does not mean a virus was found. FlowForge is built
              automatically by GitHub Actions from its source code, and you can check that your
              download is untouched by comparing its SHA-256 checksum with the one above.
            </p>
          </div>
        </div>
      </section>

      <section id="faq" className="mt-16 scroll-mt-20" aria-labelledby="faq-heading">
        <h2 id="faq-heading" className="text-2xl font-bold tracking-tight">
          Questions
        </h2>
        <div className="mt-6 grid gap-3 md:grid-cols-2">
          <Faq q="Do I need any API keys or accounts?">
            No. FlowForge creates its own database and security keys on your PC the first time it
            starts. You only add keys later for the services you decide to connect - for example an
            API your workflow calls.
          </Faq>
          <Faq q="What does it need?">
            Windows 10 or 11 (64-bit), about 1 GB of disk space and 4 GB of RAM. It works offline;
            workflows that call web services need internet, of course.
          </Faq>
          <Faq q="Where is my data?">
            In{' '}
            <code className="rounded bg-bg-2 px-1 font-mono text-[13px]">%APPDATA%\FlowForge</code>:
            the database, the generated keys and logs. Back up this folder to keep your workflows
            safe.
          </Faq>
          <Faq q="How do updates work?">
            FlowForge checks for new versions in the background, downloads them, and installs them
            the next time it restarts. You can also choose &ldquo;Check for updates&rdquo; from the
            tray icon.
          </Faq>
          <Faq q="Does it keep running when I close it?">
            Yes - it stays in the system tray so webhooks and schedules keep working, and starts
            with Windows. Both can be changed from the tray menu; &ldquo;Quit FlowForge&rdquo; stops
            it completely.
          </Faq>
          <Faq q="How do I uninstall it?">
            Settings → Apps → FlowForge → Uninstall. Your data folder is kept in case you reinstall;
            delete{' '}
            <code className="rounded bg-bg-2 px-1 font-mono text-[13px]">%APPDATA%\FlowForge</code>{' '}
            to remove it too.
          </Faq>
        </div>
      </section>
    </div>
  );
}

function Detail({
  icon,
  label,
  children,
}: {
  icon: ReactNode;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center gap-3">
      <span className="text-muted">{icon}</span>
      <dt className="w-20 text-muted">{label}</dt>
      <dd className="min-w-0 truncate font-medium">{children}</dd>
    </div>
  );
}

function InstallStep({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <li className="rounded-2xl border border-line bg-panel p-5">
      <div className="grid size-8 place-items-center rounded-lg bg-accent-soft text-sm font-bold text-accent-strong">
        {n}
      </div>
      <h3 className="mt-3 font-semibold">{title}</h3>
      <p className="mt-1 text-[15px] leading-relaxed text-muted">{children}</p>
    </li>
  );
}

function Faq({ q, children }: { q: string; children: ReactNode }) {
  return (
    <details className="group rounded-2xl border border-line bg-panel p-5 [&_summary::-webkit-details-marker]:hidden">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-4 font-semibold">
        {q}
        <span className="text-xl leading-none text-muted transition group-open:rotate-45">+</span>
      </summary>
      <p className="mt-3 text-[15px] leading-relaxed text-muted">{children}</p>
    </details>
  );
}

function PhoneCard({
  download,
  title,
  steps,
}: {
  download: Download;
  title: string;
  steps: string[];
}) {
  return (
    <div
      className="rounded-2xl border border-line bg-panel p-6"
      data-testid={`phone-${download.platform}`}
    >
      <div className="flex items-center gap-3">
        <div className="text-lg font-semibold">{title}</div>
        <span className="text-sm text-muted">{formatSize(download.size)}</span>
        <a
          href={download.url}
          download
          className="ml-auto inline-flex h-10 items-center gap-2 rounded-xl bg-accent px-4 text-sm font-semibold text-white hover:bg-accent-strong"
        >
          <FileDown size={16} /> {download.file}
        </a>
      </div>
      <p className="mt-2 text-sm text-muted">{download.requirements}</p>
      <ol className="mt-4 list-decimal space-y-1 pl-5 text-sm text-muted">
        {steps.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
    </div>
  );
}
