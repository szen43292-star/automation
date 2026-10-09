import { useQuery } from '@tanstack/react-query';
import { clsx } from 'clsx';
import {
  Bot,
  Clock,
  MessageCircle,
  Phone,
  PhoneMissed,
  Workflow as WorkflowIcon,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Spinner } from '../components/ui';
import { endpoints, type DashboardData } from '../lib/api';
import { timeAgo } from '../lib/format';

const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const percent = (value: number | null) => (value == null ? '-' : `${Math.round(value * 100)}%`);
const shortDay = (day: string) =>
  new Date(`${day}T12:00:00`).toLocaleDateString([], { weekday: 'short', day: 'numeric' });

export function DashboardPage() {
  const [days, setDays] = useState(7);
  const data = useQuery({
    queryKey: ['dashboard', days],
    queryFn: () => endpoints.dashboard(days, timezone),
    refetchInterval: 30_000,
  });
  const d = data.data;

  return (
    <div className="ff-scroll h-full overflow-y-auto">
      <div className="mx-auto max-w-6xl px-4 py-8 sm:px-8">
        <div className="mb-6 flex flex-wrap items-end gap-3">
          <div>
            <h1 className="text-xl font-semibold">Dashboard</h1>
            <p className="text-[13px] text-muted">Calls, messages and automations at a glance.</p>
          </div>
          <div
            className="ml-auto flex rounded-md border border-line p-0.5"
            role="group"
            aria-label="Period"
          >
            {[7, 30, 90].map((n) => (
              <button
                key={n}
                onClick={() => setDays(n)}
                aria-pressed={days === n}
                className={clsx(
                  'rounded px-3 py-1 text-xs font-medium',
                  days === n ? 'bg-panel-2 text-fg' : 'text-muted hover:text-fg',
                )}
              >
                {n} days
              </button>
            ))}
          </div>
        </div>

        {!d ? (
          <div className="flex justify-center py-16">
            <Spinner />
          </div>
        ) : (
          <div className="space-y-6">
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="kpis">
              <Kpi
                icon={Phone}
                label="Calls"
                value={d.totals.calls}
                sub={`${percent(d.totals.answerRate)} answered`}
              />
              <Kpi
                icon={Bot}
                label="Answered by AI"
                value={d.totals.handledByAi}
                sub={`${d.totals.handledByPeople} by people · ${d.totals.voicemail} voicemail`}
              />
              <Kpi
                icon={PhoneMissed}
                label="Missed"
                value={d.totals.missed}
                sub={`${d.totals.talkMinutes} min talk time`}
                tone={d.totals.missed ? 'danger' : undefined}
              />
              <Kpi
                icon={MessageCircle}
                label="WhatsApp messages"
                value={d.totals.messagesReceived + d.totals.messagesSent}
                sub={`${d.totals.messagesReceived} in · ${d.totals.messagesSent} out`}
              />
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
              <Card title="Calls per day">
                <Bars
                  rows={d.series.calls.map((c) => ({
                    label: shortDay(c.day),
                    parts: [c.answered, c.missed, c.other],
                  }))}
                  colors={['bg-success', 'bg-danger', 'bg-panel-3']}
                  legend={['Answered', 'Missed / declined', 'Other']}
                />
              </Card>
              <Card title="Messages per day">
                <Bars
                  rows={d.series.messages.map((m) => ({
                    label: shortDay(m.day),
                    parts: [m.received, m.sent],
                  }))}
                  colors={['bg-[#25D366]', 'bg-accent']}
                  legend={['Received', 'Sent']}
                />
              </Card>
              <Card title="Busiest hours (calls)">
                <Bars
                  rows={d.busiestHours.map((h) => ({
                    label: h.hour % 3 === 0 ? `${h.hour}h` : '',
                    parts: [h.count],
                  }))}
                  colors={['bg-accent']}
                  compact
                />
              </Card>
              <Card
                title="Workflow runs"
                extra={
                  <span className="text-xs text-muted">
                    {d.totals.workflowRuns} runs · {d.totals.workflowErrors} failed
                  </span>
                }
              >
                <Bars
                  rows={d.series.executions.map((e) => ({
                    label: shortDay(e.day),
                    parts: [e.success, e.error],
                  }))}
                  colors={['bg-success', 'bg-danger']}
                  legend={['Succeeded', 'Failed']}
                />
              </Card>
            </div>

            <div className="grid gap-4 lg:grid-cols-3">
              <Card title="Missed calls to call back">
                {d.recentMissed.length ? (
                  <ul className="space-y-2 text-[13px]">
                    {d.recentMissed.map((m) => (
                      <li key={m.id} className="flex items-center gap-2">
                        <PhoneMissed size={14} className="text-danger" />
                        <span className="truncate">{m.contactName ?? `+${m.contact}`}</span>
                        <span className="ml-auto text-xs text-muted">{timeAgo(m.startedAt)}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <Empty>No missed calls 🎉</Empty>
                )}
              </Card>
              <Card title="Top callers">
                {d.topCallers.length ? (
                  <ul className="space-y-2 text-[13px]">
                    {d.topCallers.map((c) => (
                      <li key={c.contact} className="flex items-center gap-2">
                        <span className="truncate">{c.contactName ?? `+${c.contact}`}</span>
                        <span className="ml-auto text-xs text-muted">{c.calls} calls</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <Empty>No calls yet.</Empty>
                )}
              </Card>
              <Card title="AI agents">
                {d.agents.length ? (
                  <ul className="space-y-2 text-[13px]">
                    {d.agents.map((a) => (
                      <li key={a.agentId} className="flex items-center gap-2">
                        <Bot size={14} className="text-accent" />
                        <span className="truncate">{a.name}</span>
                        <span className="ml-auto text-xs text-muted">
                          {a.calls} calls · avg {Math.round(a.averageSeconds / 6) / 10} min
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <Empty>
                    <Link to="/agents" className="text-accent hover:underline">
                      Set up an AI agent
                    </Link>{' '}
                    to answer calls 24/7.
                  </Empty>
                )}
              </Card>
            </div>
            <div className="flex items-center gap-1.5 text-xs text-muted">
              <Clock size={12} /> Times in {d.timezone}. Average call {d.totals.averageCallSeconds}
              s.
              <WorkflowIcon size={12} className="ml-3" />
              <Link to="/templates" className="text-accent hover:underline">
                Start from a template
              </Link>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Kpi({
  icon: Icon,
  label,
  value,
  sub,
  tone,
}: {
  icon: typeof Phone;
  label: string;
  value: number;
  sub: string;
  tone?: 'danger';
}) {
  return (
    <div className="rounded-xl border border-line bg-panel p-4">
      <div className="flex items-center gap-2 text-xs text-muted">
        <Icon size={14} /> {label}
      </div>
      <div
        className={clsx(
          'mt-1 text-2xl font-semibold tabular-nums',
          tone === 'danger' && 'text-danger',
        )}
      >
        {value.toLocaleString()}
      </div>
      <div className="text-xs text-muted">{sub}</div>
    </div>
  );
}

function Card({
  title,
  extra,
  children,
}: {
  title: string;
  extra?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="rounded-xl border border-line bg-panel p-4">
      <div className="mb-3 flex items-center">
        <div className="text-[13px] font-semibold">{title}</div>
        <div className="ml-auto">{extra}</div>
      </div>
      {children}
    </div>
  );
}

const Empty = ({ children }: { children: ReactNode }) => (
  <div className="py-4 text-center text-[13px] text-muted">{children}</div>
);

/** Stacked bar chart from plain divs (no chart library). */
function Bars({
  rows,
  colors,
  legend,
  compact,
}: {
  rows: Array<{ label: string; parts: number[] }>;
  colors: string[];
  legend?: string[];
  compact?: boolean;
}) {
  const max = Math.max(1, ...rows.map((r) => r.parts.reduce((a, b) => a + b, 0)));
  return (
    <div>
      <div className={clsx('flex items-end gap-1', compact ? 'h-24' : 'h-32')}>
        {rows.map((row, i) => {
          const total = row.parts.reduce((a, b) => a + b, 0);
          return (
            <div
              key={i}
              className="flex h-full min-w-0 flex-1 flex-col justify-end"
              title={`${row.label}: ${row.parts.join(' / ')}`}
            >
              {row.parts.map((value, j) =>
                value ? (
                  <div
                    key={j}
                    className={clsx(colors[j], 'w-full first:rounded-t-sm')}
                    style={{ height: `${(value / max) * 100}%` }}
                  />
                ) : null,
              )}
              {!total && <div className="h-px w-full bg-line" />}
            </div>
          );
        })}
      </div>
      <div className="mt-1 flex gap-1">
        {rows.map((row, i) => (
          <div key={i} className="min-w-0 flex-1 truncate text-center text-[10px] text-muted">
            {rows.length > 31 ? '' : row.label}
          </div>
        ))}
      </div>
      {legend && (
        <div className="mt-2 flex flex-wrap gap-3 text-[11px] text-muted">
          {legend.map((name, i) => (
            <span key={name} className="flex items-center gap-1">
              <span className={clsx('inline-block size-2 rounded-sm', colors[i])} /> {name}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
