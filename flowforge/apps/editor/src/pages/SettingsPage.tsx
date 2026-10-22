import { useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import {
  Copy,
  KeyRound,
  Link2,
  Plus,
  RefreshCw,
  Smartphone,
  Trash2,
  UserRound,
  Users,
} from 'lucide-react';
import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Badge, Button, Field, Modal, Spinner } from '../components/ui';
import { endpoints, getServerUrl, type TeamMember, type User } from '../lib/api';
import { formatDateTime, timeAgo } from '../lib/format';
import { useAuth } from '../stores/auth';

type Tab = 'team' | 'phone' | 'api' | 'account';

const ROLES: Array<{ value: User['role']; label: string; text: string }> = [
  { value: 'owner', label: 'Owner', text: 'Everything, incl. AI keys and the Meta app' },
  { value: 'admin', label: 'Admin', text: 'Numbers, agents, all workflows, the team' },
  { value: 'member', label: 'Member', text: 'Own workflows; answers calls and chats' },
];

const copy = async (text: string) => {
  await navigator.clipboard.writeText(text).catch(() => undefined);
  toast.success('Copied');
};

export function SettingsPage() {
  const [tab, setTab] = useState<Tab>('team');
  return (
    <div className="ff-scroll h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl px-4 py-8 sm:px-8">
        <h1 className="mb-4 text-xl font-semibold">Settings</h1>
        <div className="mb-6 flex gap-1 border-b border-line" role="tablist">
          {(
            [
              ['team', 'Team', Users],
              ['phone', 'Phone', Smartphone],
              ['api', 'API keys', KeyRound],
              ['account', 'Your account', UserRound],
            ] as const
          ).map(([id, label, Icon]) => (
            <button
              key={id}
              role="tab"
              aria-selected={tab === id}
              onClick={() => setTab(id)}
              className={clsx(
                '-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-[13px] font-medium',
                tab === id
                  ? 'border-accent text-fg'
                  : 'border-transparent text-muted hover:text-fg',
              )}
            >
              <Icon size={14} /> {label}
            </button>
          ))}
        </div>
        {tab === 'team' && <Team />}
        {tab === 'phone' && <Phone />}
        {tab === 'api' && <ApiKeys />}
        {tab === 'account' && <Account />}
      </div>
    </div>
  );
}

// ---- Phone ----------------------------------------------------------------------------------------

/** One secret link (QR code) that runs the chosen workflows from any phone browser. */
function Phone() {
  const queryClient = useQueryClient();
  const me = useAuth((s) => s.user);
  const canManage = me?.role !== 'member';
  const phone = useQuery({ queryKey: ['phone'], queryFn: endpoints.phone, enabled: canManage });
  const workflows = useQuery({
    queryKey: ['workflows', 'phone-picker'],
    queryFn: () => endpoints.workflows({ limit: 200 }),
    enabled: canManage,
  });
  const [qr, setQr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const info = phone.data;
  // Ticks show right away; the server's answer replaces them.
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  useEffect(() => setChosen(new Set(info?.workflowIds ?? [])), [info?.workflowIds]);

  useEffect(() => {
    if (!info?.url) return setQr(null);
    let current = true;
    QRCode.toDataURL(info.url, { margin: 1, width: 240 })
      .then((url) => current && setQr(url))
      .catch(() => current && setQr(null));
    return () => {
      current = false;
    };
  }, [info?.url]);

  const save = async (action: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await action();
      await queryClient.invalidateQueries({ queryKey: ['phone'] });
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const toggle = (id: string) => {
    const next = new Set(chosen);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setChosen(next);
    return save(() => endpoints.updatePhone([...next]));
  };

  if (!canManage)
    return (
      <p className="text-[13px] text-muted">Ask an owner or admin to set up the phone link.</p>
    );
  if (phone.isLoading || workflows.isLoading)
    return (
      <div className="flex justify-center py-12">
        <Spinner />
      </div>
    );
  const local = info?.url && info.url === info.localUrl;

  return (
    <>
      <p className="mb-4 text-[13px] text-muted">
        Run workflows from your phone: scan the QR code, then add the page to your home screen. It
        works from anywhere while this PC is on, and also shows videos waiting for your approval.
        Anyone with the link can run the workflows you tick, so keep it to yourself.
      </p>
      <div className="mb-6 flex flex-wrap items-start gap-6">
        <div className="flex h-[240px] w-[240px] items-center justify-center rounded-xl border border-line bg-white">
          {qr ? (
            <img src={qr} alt="QR code for the phone page" width={240} height={240} />
          ) : (
            <span className="px-6 text-center text-[13px] text-muted">
              Tick a workflow below to create your phone link
            </span>
          )}
        </div>
        {info?.enabled && info.url && (
          <div className="min-w-0 flex-1 space-y-3">
            <div className="flex items-center gap-2">
              <code
                className="min-w-0 flex-1 truncate rounded bg-panel-2 px-2 py-1.5 text-[12px]"
                data-testid="phone-link"
              >
                {info.url}
              </code>
              <Button size="sm" icon={Copy} onClick={() => copy(info.url!)}>
                Copy
              </Button>
            </div>
            {local && (
              <p className="text-[12px] text-muted">
                This link only works on the same Wi-Fi as this PC (remote access is off here).
              </p>
            )}
            <p className="text-[12px] text-muted">
              The address changes when the PC restarts - scan the code again then.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                icon={RefreshCw}
                disabled={busy}
                onClick={() => save(endpoints.resetPhone)}
              >
                New link
              </Button>
              <Button
                size="sm"
                variant="danger"
                icon={Trash2}
                disabled={busy}
                onClick={() => {
                  if (window.confirm('Switch the phone link off? It stops working right away.'))
                    void save(endpoints.disablePhone);
                }}
              >
                Switch off
              </Button>
            </div>
          </div>
        )}
      </div>
      <AppAccess />
      <h2 className="mb-2 text-[13px] font-semibold">Workflows on your phone</h2>
      <div className="divide-y divide-line rounded-lg border border-line">
        {(workflows.data?.data ?? []).map((w) => (
          <label
            key={w.id}
            className="flex cursor-pointer items-center gap-3 px-3 py-2.5 text-[13px] hover:bg-panel-2"
          >
            <input
              type="checkbox"
              checked={chosen.has(w.id)}
              disabled={busy}
              onChange={() => void toggle(w.id)}
            />
            <span className="min-w-0 flex-1 truncate">{w.name}</span>
            {w.active && <Badge tone="success">Active</Badge>}
          </label>
        ))}
        {!workflows.data?.data.length && (
          <p className="px-3 py-4 text-[13px] text-muted">No workflows yet.</p>
        )}
      </div>
    </>
  );
}

/** The full AutoForge app (phone app or any browser) through the https address. */
function AppAccess() {
  const queryClient = useQueryClient();
  const access = useQuery({ queryKey: ['app-access'], queryFn: endpoints.appAccess });
  const [busy, setBusy] = useState(false);
  const [qr, setQr] = useState<string | null>(null);
  // The tick shows right away; the server's answer replaces it.
  const [enabled, setEnabled] = useState(false);
  useEffect(() => setEnabled(access.data?.enabled ?? false), [access.data?.enabled]);
  const url = access.data?.url ?? null;

  useEffect(() => {
    if (!url) return setQr(null);
    let current = true;
    QRCode.toDataURL(url, { margin: 1, width: 180 })
      .then((data) => current && setQr(data))
      .catch(() => current && setQr(null));
    return () => {
      current = false;
    };
  }, [url]);

  const toggle = async (next: boolean) => {
    setEnabled(next);
    setBusy(true);
    try {
      queryClient.setQueryData(['app-access'], await endpoints.setAppAccess(next));
    } catch (error) {
      setEnabled(!next);
      toast.error((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mb-6 rounded-lg border border-line p-4" data-testid="app-access">
      <label className="flex cursor-pointer items-start gap-3">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={enabled}
          disabled={busy || access.isLoading}
          onChange={(e) => void toggle(e.target.checked)}
        />
        <span>
          <span className="block text-[13px] font-semibold">
            Use the full AutoForge app from anywhere
          </span>
          <span className="block text-[12px] text-muted">
            Build and run workflows in the phone app (or any browser) through a secure https
            address. You sign in with your AutoForge email and password.
          </span>
        </span>
      </label>
      {enabled && access.data?.enabled && (
        <div className="mt-3 flex flex-wrap items-start gap-4">
          {qr && (
            <img
              src={qr}
              alt="QR code for the https address"
              width={180}
              height={180}
              className="rounded-lg border border-line bg-white"
            />
          )}
          <div className="min-w-0 flex-1 space-y-2 text-[12px] text-muted">
            {url ? (
              <div className="flex items-center gap-2">
                <code
                  className="min-w-0 flex-1 truncate rounded bg-panel-2 px-2 py-1.5 text-fg"
                  data-testid="app-address"
                >
                  {url}
                </code>
                <Button size="sm" icon={Copy} onClick={() => copy(url)}>
                  Copy
                </Button>
              </div>
            ) : (
              <p>No https address here - remote access is off on this server.</p>
            )}
            <p>
              In the AutoForge app tap <b>Connect to a different server</b>, enter this address and
              sign in. The address changes when the PC restarts - copy it again then.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

// ---- Team -----------------------------------------------------------------------------------------

function Team() {
  const queryClient = useQueryClient();
  const me = useAuth((s) => s.user);
  const canManage = me?.role !== 'member';
  const users = useQuery({ queryKey: ['users'], queryFn: endpoints.users });
  const [inviting, setInviting] = useState(false);
  const [form, setForm] = useState({ email: '', name: '', role: 'member' as User['role'] });
  const [link, setLink] = useState<string | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['users'] });

  const invite = async () => {
    try {
      const result = await endpoints.inviteUser(form);
      setLink(result.inviteUrl);
      setForm({ email: '', name: '', role: 'member' });
      await refresh();
    } catch (error) {
      toast.error((error as Error).message);
    }
  };

  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      await refresh();
    } catch (error) {
      toast.error((error as Error).message);
    }
  };

  return (
    <>
      <div className="mb-3 flex items-center">
        <p className="text-[13px] text-muted">Everyone who can sign in to this AutoForge.</p>
        {canManage && (
          <Button
            className="ml-auto"
            variant="primary"
            icon={Plus}
            onClick={() => {
              setLink(null);
              setInviting(true);
            }}
          >
            Invite
          </Button>
        )}
      </div>
      {!users.data ? (
        <Spinner />
      ) : (
        <div
          className="divide-y divide-line rounded-xl border border-line bg-panel"
          data-testid="team"
        >
          {users.data.data.map((u: TeamMember) => (
            <div
              key={u.id}
              className="flex flex-wrap items-center gap-3 px-4 py-3"
              data-testid="team-member"
            >
              <span className="grid size-8 place-items-center rounded-full bg-accent-soft text-xs font-semibold text-accent">
                {u.name.slice(0, 1).toUpperCase()}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-[13px] font-medium">
                  {u.name} {u.id === me?.id && <span className="text-xs text-muted">(you)</span>}
                  {u.status === 'invited' && <Badge tone="warning">Invited</Badge>}
                </div>
                <div className="truncate text-xs text-muted">
                  {u.email}
                  {u.lastLoginAt && ` · active ${timeAgo(u.lastLoginAt)}`}
                </div>
              </div>
              {canManage && u.id !== me?.id && (me?.role === 'owner' || u.role !== 'owner') ? (
                <>
                  <select
                    className="ff-input w-28"
                    value={u.role}
                    aria-label={`Role of ${u.name}`}
                    onChange={(e) =>
                      void act(() =>
                        endpoints.updateUser(u.id, { role: e.target.value as User['role'] }),
                      )
                    }
                  >
                    {ROLES.filter((r) => me?.role === 'owner' || r.value !== 'owner').map((r) => (
                      <option key={r.value} value={r.value}>
                        {r.label}
                      </option>
                    ))}
                  </select>
                  {u.status === 'invited' && (
                    <Button
                      size="sm"
                      icon={Link2}
                      onClick={() =>
                        void act(async () => {
                          const { inviteUrl } = await endpoints.reinviteUser(u.id);
                          setLink(inviteUrl);
                          setInviting(true);
                        })
                      }
                    >
                      New link
                    </Button>
                  )}
                  <button
                    className="text-muted hover:text-danger"
                    title="Remove"
                    onClick={() => {
                      if (window.confirm(`Remove ${u.name}? Their workflows move to you.`))
                        void act(() => endpoints.removeUser(u.id));
                    }}
                  >
                    <Trash2 size={15} />
                  </button>
                </>
              ) : (
                <Badge>{ROLES.find((r) => r.value === u.role)?.label}</Badge>
              )}
            </div>
          ))}
        </div>
      )}
      <div className="mt-4 grid gap-2 text-xs text-muted sm:grid-cols-3">
        {ROLES.map((r) => (
          <div key={r.value}>
            <b className="text-fg">{r.label}</b> - {r.text}
          </div>
        ))}
      </div>

      <Modal
        open={inviting}
        onClose={() => setInviting(false)}
        title={link ? 'Send this link' : 'Invite someone'}
        footer={
          link ? (
            <Button variant="primary" onClick={() => setInviting(false)}>
              Done
            </Button>
          ) : (
            <>
              <Button variant="ghost" onClick={() => setInviting(false)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                disabled={!form.email || !form.name}
                onClick={() => void invite()}
              >
                Create invitation
              </Button>
            </>
          )
        }
      >
        {link ? (
          <div className="space-y-2">
            <p className="text-[13px] text-muted">
              Send it on WhatsApp or email. It works once, for 7 days; they choose their own
              password.
            </p>
            <div className="flex gap-2">
              <input
                className="ff-input font-mono text-xs"
                readOnly
                value={link}
                aria-label="Invitation link"
              />
              <Button icon={Copy} onClick={() => void copy(link)}>
                Copy
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <Field label="Name">
              <input
                className="ff-input"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </Field>
            <Field label="Email">
              <input
                className="ff-input"
                type="email"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
              />
            </Field>
            <Field label="Role">
              <select
                className="ff-input"
                value={form.role}
                onChange={(e) => setForm({ ...form, role: e.target.value as User['role'] })}
              >
                {ROLES.filter((r) => me?.role === 'owner' || r.value !== 'owner').map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label} - {r.text}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        )}
      </Modal>
    </>
  );
}

// ---- API keys -------------------------------------------------------------------------------------

function ApiKeys() {
  const queryClient = useQueryClient();
  const keys = useQuery({ queryKey: ['api-keys'], queryFn: endpoints.apiKeys });
  const [name, setName] = useState('');
  const [expires, setExpires] = useState('');
  const [created, setCreated] = useState<string | null>(null);
  const base = getServerUrl() || window.location.origin;

  const create = async () => {
    try {
      const key = await endpoints.createApiKey({
        name,
        expiresInDays: expires ? Number(expires) : null,
      });
      setCreated(key.key);
      setName('');
      await queryClient.invalidateQueries({ queryKey: ['api-keys'] });
    } catch (error) {
      toast.error((error as Error).message);
    }
  };

  return (
    <>
      <p className="mb-4 text-[13px] text-muted">
        Use the AutoForge API from your website, CRM or Zapier. A key acts as you (same role and
        access). Send it as <code className="rounded bg-panel-2 px-1">X-API-Key</code>.
      </p>
      <div className="mb-4 flex flex-wrap items-end gap-2">
        <Field label="Key name">
          <input
            className="ff-input w-56"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Website"
          />
        </Field>
        <Field label="Expires">
          <select
            className="ff-input w-36"
            value={expires}
            onChange={(e) => setExpires(e.target.value)}
          >
            <option value="">Never</option>
            <option value="30">In 30 days</option>
            <option value="90">In 90 days</option>
            <option value="365">In a year</option>
          </select>
        </Field>
        <Button variant="primary" icon={Plus} disabled={!name.trim()} onClick={() => void create()}>
          Create key
        </Button>
      </div>
      {created && (
        <div className="mb-4 rounded-lg border border-success/40 bg-success-soft p-3">
          <div className="mb-1 text-[13px] font-medium">
            Copy your key now - it won't be shown again.
          </div>
          <div className="flex gap-2">
            <input
              className="ff-input font-mono text-xs"
              readOnly
              value={created}
              aria-label="New API key"
            />
            <Button icon={Copy} onClick={() => void copy(created)}>
              Copy
            </Button>
          </div>
        </div>
      )}
      <div
        className="divide-y divide-line rounded-xl border border-line bg-panel"
        data-testid="api-keys"
      >
        {keys.data?.data.length === 0 && (
          <div className="p-4 text-[13px] text-muted">No keys yet.</div>
        )}
        {keys.data?.data.map((k) => (
          <div key={k.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
            <KeyRound size={15} className="text-muted" />
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-medium">{k.name}</div>
              <div className="text-xs text-muted">
                <code>{k.prefix}…</code>
                {k.userName && ` · ${k.userName}`} · created {formatDateTime(k.createdAt)}
                {k.lastUsedAt ? ` · used ${timeAgo(k.lastUsedAt)}` : ' · never used'}
                {k.expiresAt && ` · expires ${formatDateTime(k.expiresAt)}`}
              </div>
            </div>
            <Button
              size="sm"
              variant="ghost"
              icon={Trash2}
              onClick={async () => {
                if (!window.confirm(`Revoke "${k.name}"? Apps using it stop working.`)) return;
                await endpoints.deleteApiKey(k.id);
                await queryClient.invalidateQueries({ queryKey: ['api-keys'] });
              }}
            >
              Revoke
            </Button>
          </div>
        ))}
      </div>
      <div className="mt-6">
        <div className="mb-2 text-[13px] font-semibold">Examples</div>
        <pre className="ff-scroll overflow-x-auto rounded-lg bg-panel-2 p-3 text-[11.5px] leading-relaxed">
          {`# List workflows
curl ${base}/api/workflows -H "X-API-Key: ff_…"

# Run a workflow with your data (starts at its trigger)
curl -X POST ${base}/api/workflows/<id>/run -H "X-API-Key: ff_…" \\
  -H "content-type: application/json" -d '{"triggerItems":[{"json":{"name":"Asha"}}]}'

# Send a WhatsApp message (within 24 hours of the customer's last message)
curl -X POST ${base}/api/whatsapp/accounts/<numberId>/send -H "X-API-Key: ff_…" \\
  -H "content-type: application/json" -d '{"to":"+919876543210","text":"Hello!"}'

# Have the AI agent call a customer (who allowed calls)
curl -X POST ${base}/api/calls/outbound -H "X-API-Key: ff_…" -H "content-type: application/json" \\
  -d '{"accountId":"<numberId>","to":"+919876543210","purpose":"Confirm tomorrow 5 pm"}'

# Calls, with transcripts and summaries
curl "${base}/api/calls?limit=20" -H "X-API-Key: ff_…"`}
        </pre>
      </div>
    </>
  );
}

// ---- Account --------------------------------------------------------------------------------------

function Account() {
  const user = useAuth((s) => s.user);
  const [name, setName] = useState(user?.name ?? '');
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const save = async (body: Parameters<typeof endpoints.updateMe>[0]) => {
    try {
      const { user: updated } = await endpoints.updateMe(body);
      useAuth.setState({ user: updated });
      setCurrent('');
      setNext('');
      toast.success('Saved');
    } catch (error) {
      toast.error((error as Error).message);
    }
  };
  return (
    <div className="max-w-sm space-y-6">
      <div className="space-y-2">
        <Field label="Name">
          <input className="ff-input" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Email">
          <input className="ff-input" value={user?.email ?? ''} disabled />
        </Field>
        <Button onClick={() => void save({ name })} disabled={!name.trim()}>
          Save name
        </Button>
      </div>
      <div className="space-y-2">
        <div className="text-[13px] font-semibold">Change password</div>
        <Field label="Current password">
          <input
            className="ff-input"
            type="password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            autoComplete="current-password"
          />
        </Field>
        <Field label="New password" hint="8+ characters with an uppercase letter and a number.">
          <input
            className="ff-input"
            type="password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            autoComplete="new-password"
          />
        </Field>
        <Button
          onClick={() => void save({ currentPassword: current, newPassword: next })}
          disabled={!current || !next}
        >
          Change password
        </Button>
      </div>
    </div>
  );
}
