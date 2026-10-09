import {
  Bot,
  Braces,
  CalendarClock,
  Check,
  Download,
  HardDrive,
  KeyRound,
  MousePointerClick,
  PhoneCall,
  RefreshCw,
  ShieldCheck,
  Smartphone,
  Webhook,
  Workflow,
  Zap,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { DownloadButton } from '@/components/download-button';
import {
  getLatestRelease,
  platformDownload,
  releasesRepo,
  setupHint,
  windowsDownload,
} from '@/lib/releases';

// Re-check GitHub for a new release every 5 minutes (must be a literal for Next.js).
export const revalidate = 300;

const features: Array<{ icon: typeof Zap; title: string; text: string }> = [
  {
    icon: Workflow,
    title: 'Visual workflow editor',
    text: 'Drag, connect and run nodes on an infinite canvas. See every item flowing through, pin test data, undo anything.',
  },
  {
    icon: Webhook,
    title: 'Webhooks & APIs',
    text: 'Receive webhooks, call any HTTP API, respond with JSON. Merge, switch, loop and wait between steps.',
  },
  {
    icon: CalendarClock,
    title: 'Schedules',
    text: 'Run workflows every few minutes, daily, weekly or on any cron expression, in your own time zone.',
  },
  {
    icon: Braces,
    title: 'JavaScript when you need it',
    text: 'Expressions with autocomplete and a Code node - both run in a locked-down sandbox with time and memory limits.',
  },
  {
    icon: KeyRound,
    title: 'Encrypted credentials',
    text: 'API keys and OAuth2 logins are stored encrypted with a key generated on your PC. Secrets never reach the browser.',
  },
  {
    icon: HardDrive,
    title: 'Private by design',
    text: 'The database, server and editor all run on your computer. Your workflows and data never leave it.',
  },
];

export default async function HomePage() {
  const release = await getLatestRelease();
  const download = windowsDownload(release);
  const releasesUrl = `https://github.com/${releasesRepo()}/releases`;

  return (
    <>
      {/* Hero */}
      <section className="relative overflow-hidden">
        <div className="grid-bg pointer-events-none absolute inset-0 -z-10 opacity-60" />
        <div className="mx-auto max-w-6xl px-4 pt-16 pb-12 sm:px-6 sm:pt-24">
          <div className="max-w-3xl">
            <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-line bg-panel px-3 py-1 text-[13px] text-muted shadow-sm">
              <span className="size-1.5 rounded-full bg-success" />
              Free for Windows · No account · No API keys
            </div>
            <h1 className="text-[40px] leading-[1.05] font-bold tracking-tight text-balance sm:text-6xl">
              Automate your work, <span className="text-accent">right on your PC</span>
            </h1>
            <p className="mt-6 max-w-2xl text-lg leading-relaxed text-pretty text-muted">
              FlowForge is a visual workflow builder - webhooks, schedules, APIs and JavaScript -
              that installs in one click and runs entirely on your Windows computer. Nothing to
              configure, nothing to sign up for.
            </p>
            <div className="mt-9">
              <DownloadButton
                download={download}
                version={release?.version ?? null}
                releasesUrl={releasesUrl}
                showDetailsLink
                setupHint={setupHint(release)}
                phones={{
                  android: platformDownload(release, 'android'),
                  ios: platformDownload(release, 'ios'),
                }}
              />
            </div>
          </div>

          <div className="mt-16 overflow-hidden rounded-2xl border border-line bg-panel shadow-card">
            <div className="flex h-9 items-center gap-1.5 border-b border-line bg-bg-2 px-4">
              <span className="size-2.5 rounded-full bg-line" />
              <span className="size-2.5 rounded-full bg-line" />
              <span className="size-2.5 rounded-full bg-line" />
              <span className="ml-3 text-xs text-muted">FlowForge</span>
            </div>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/screens/editor-light.png"
              alt="The FlowForge editor with a workflow that receives a webhook, routes it with a Switch node and calls an API"
              width={2560}
              height={1520}
              className="block h-auto w-full dark:hidden"
            />
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/screens/editor-dark.png"
              alt=""
              width={2560}
              height={1520}
              className="hidden h-auto w-full dark:block"
            />
          </div>
        </div>
      </section>

      {/* How it works */}
      <section id="how-it-works" className="scroll-mt-20 border-y border-line bg-bg-2/60">
        <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
          <SectionHeading
            eyebrow="Zero setup"
            title="No API keys. No accounts. No servers to rent."
            text="Everything FlowForge needs - its database, server and editor - comes inside the installer and sets itself up the first time it starts. Keys are only needed later, for the services you choose to connect."
          />
          <ol className="mt-12 grid gap-4 md:grid-cols-3">
            <Step n={1} icon={<Download size={20} />} title="Download">
              One installer for Windows 10 and 11. No sign-up form, no email.
            </Step>
            <Step n={2} icon={<MousePointerClick size={20} />} title="Install">
              One click, about a minute. No administrator rights needed. FlowForge opens when
              it&apos;s done.
            </Step>
            <Step n={3} icon={<Zap size={20} />} title="Build">
              Create your local owner account and start automating. It keeps running in the tray,
              24/7.
            </Step>
          </ol>
        </div>
      </section>

      {/* Features */}
      <section id="features" className="scroll-mt-20">
        <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
          <SectionHeading
            eyebrow="What's inside"
            title="A complete automation platform, on your desktop"
            text="The same engine you would self-host on a server, packaged as a Windows app."
          />
          <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {features.map(({ icon: Icon, title, text }) => (
              <div
                key={title}
                className="rounded-2xl border border-line bg-panel p-6 transition hover:shadow-card"
              >
                <div className="mb-4 grid size-10 place-items-center rounded-xl bg-accent-soft text-accent">
                  <Icon size={20} />
                </div>
                <h3 className="font-semibold">{title}</h3>
                <p className="mt-2 text-[15px] leading-relaxed text-muted">{text}</p>
              </div>
            ))}
          </div>

          <div className="mt-6 grid gap-4 rounded-2xl border border-line bg-panel p-6 sm:p-8 md:grid-cols-[1.2fr_1fr] md:items-center">
            <div>
              <h3 className="text-xl font-semibold tracking-tight">Runs 24/7, quietly</h3>
              <p className="mt-2 leading-relaxed text-muted">
                Close the window and FlowForge keeps working from the system tray, so webhooks and
                schedules never miss a beat. It starts with Windows and updates itself when a new
                version is out.
              </p>
            </div>
            <ul className="grid gap-2.5 text-[15px]">
              {[
                'Keeps running in the tray when you close it',
                'Starts automatically with Windows (you can turn it off)',
                'Updates itself in the background',
                'Uninstalls cleanly - your data stays unless you delete it',
              ].map((item) => (
                <li key={item} className="flex items-start gap-2.5">
                  <Check size={18} className="mt-0.5 shrink-0 text-success" />
                  {item}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      {/* Roadmap */}
      <section id="roadmap" className="scroll-mt-20 border-t border-line bg-bg-2/60">
        <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
          <SectionHeading
            eyebrow="Roadmap"
            title="Next: your WhatsApp calls, answered by AI"
            text="FlowForge is growing into a platform that answers WhatsApp Business calls with an AI voice agent, around the clock. These arrive as free updates."
          />
          <div className="mt-12 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            <RoadmapCard
              icon={<Workflow size={20} />}
              title="Workflow engine & editor"
              status="available"
            >
              Triggers, two dozen nodes, expressions, credentials, execution history.
            </RoadmapCard>
            <RoadmapCard icon={<PhoneCall size={20} />} title="WhatsApp Business" status="next">
              Connect your number, send and receive messages, handle incoming calls.
            </RoadmapCard>
            <RoadmapCard icon={<Bot size={20} />} title="AI voice agent" status="planned">
              Answers calls 24/7 in English, Hindi or Hinglish, books appointments, transfers to
              you.
            </RoadmapCard>
            <RoadmapCard
              icon={<Smartphone size={20} />}
              title="Android & iOS apps"
              status="planned"
            >
              Watch calls live, get notified and take over from your phone.
            </RoadmapCard>
          </div>
        </div>
      </section>

      {/* Final call to action */}
      <section>
        <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
          <div className="relative overflow-hidden rounded-3xl bg-[#17181f] px-6 py-14 text-white sm:px-12">
            <div className="absolute -top-24 -right-24 size-72 rounded-full bg-accent/30 blur-3xl" />
            <div className="relative grid gap-8 md:grid-cols-[1.4fr_1fr] md:items-center">
              <div>
                <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">
                  Start automating in two minutes
                </h2>
                <p className="mt-3 max-w-xl text-white/70">
                  Free download. Runs on your PC. No API keys, no account, no credit card.
                </p>
              </div>
              <ul className="grid gap-2.5 text-sm text-white/75 md:justify-self-end">
                <li className="flex items-center gap-2.5">
                  <ShieldCheck size={18} className="text-accent" /> SHA-256 checksum for every
                  release
                </li>
                <li className="flex items-center gap-2.5">
                  <RefreshCw size={18} className="text-accent" /> Updates itself in the background
                </li>
              </ul>
            </div>
            <div className="relative mt-8 [&_p]:text-white/60">
              <DownloadButton
                download={download}
                version={release?.version ?? null}
                releasesUrl={releasesUrl}
                hideNotices
              />
            </div>
          </div>
        </div>
      </section>
    </>
  );
}

function SectionHeading({
  eyebrow,
  title,
  text,
}: {
  eyebrow: string;
  title: string;
  text: string;
}) {
  return (
    <div className="max-w-2xl">
      <div className="text-sm font-semibold tracking-wide text-accent uppercase">{eyebrow}</div>
      <h2 className="mt-2 text-3xl font-bold tracking-tight text-balance sm:text-4xl">{title}</h2>
      <p className="mt-4 text-lg leading-relaxed text-pretty text-muted">{text}</p>
    </div>
  );
}

function Step({
  n,
  icon,
  title,
  children,
}: {
  n: number;
  icon: ReactNode;
  title: string;
  children: ReactNode;
}) {
  return (
    <li className="relative rounded-2xl border border-line bg-panel p-6">
      <div className="flex items-center gap-3">
        <div className="grid size-10 place-items-center rounded-xl bg-accent text-white">
          {icon}
        </div>
        <span className="text-sm font-medium text-muted">Step {n}</span>
      </div>
      <h3 className="mt-4 text-lg font-semibold">{title}</h3>
      <p className="mt-1.5 leading-relaxed text-muted">{children}</p>
    </li>
  );
}

const statusStyles = {
  available: { label: 'Available now', className: 'bg-success/12 text-success' },
  next: { label: 'Coming next', className: 'bg-accent-soft text-accent-strong' },
  planned: { label: 'Planned', className: 'bg-bg-2 text-muted' },
} as const;

function RoadmapCard({
  icon,
  title,
  status,
  children,
}: {
  icon: ReactNode;
  title: string;
  status: keyof typeof statusStyles;
  children: ReactNode;
}) {
  const style = statusStyles[status];
  return (
    <div className="flex flex-col rounded-2xl border border-line bg-panel p-6">
      <div className="flex items-center justify-between">
        <div className="text-accent">{icon}</div>
        <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${style.className}`}>
          {style.label}
        </span>
      </div>
      <h3 className="mt-4 font-semibold">{title}</h3>
      <p className="mt-1.5 text-[15px] leading-relaxed text-muted">{children}</p>
    </div>
  );
}
