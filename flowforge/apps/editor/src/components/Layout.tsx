import { clsx } from 'clsx';
import {
  Bot,
  Braces,
  CircleCheck,
  LayoutDashboard,
  LayoutTemplate,
  Settings,
  History,
  KeyRound,
  LogOut,
  MessageCircle,
  Monitor,
  Moon,
  Phone,
  Sun,
  Workflow as WorkflowIcon,
  Zap,
  Menu as Menu2,
} from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { startNative } from '../lib/native';
import { CallBar } from './calls/CallBar';
import { push } from '../lib/push';
import { useTheme, type ThemeMode } from '../lib/theme';
import { useAuth } from '../stores/auth';
import { endpoints } from '../lib/api';
import { Menu } from './ui';

/** How many approvals wait for an answer (checked every 30 s). */
function PendingCount({ dot }: { dot?: boolean }) {
  const approvals = useQuery({
    queryKey: ['approvals'],
    queryFn: endpoints.approvals,
    refetchInterval: 30_000,
  });
  const count = approvals.data?.data?.length ?? 0;
  if (!count) return null;
  return dot ? (
    <span className="absolute -right-2 -top-1 min-w-4 rounded-full bg-danger px-1 text-center text-[10px] leading-4 text-white">
      {count}
    </span>
  ) : (
    <span className="ml-auto rounded-full bg-danger px-1.5 text-[11px] font-semibold leading-5 text-white">
      {count}
    </span>
  );
}

export function ConnectionDot() {
  const [connected, setConnected] = useState(push.connected);
  useEffect(() => push.onStatus(setConnected), []);
  return (
    <span
      title={connected ? 'Live updates connected' : 'Live updates disconnected - reconnecting…'}
      className={clsx('inline-block h-2 w-2 rounded-full', connected ? 'bg-success' : 'bg-warning')}
    />
  );
}

export function ThemeSwitch() {
  const { mode, setMode } = useTheme();
  const options: Array<[ThemeMode, typeof Sun, string]> = [
    ['light', Sun, 'Light'],
    ['dark', Moon, 'Dark'],
    ['system', Monitor, 'System'],
  ];
  return (
    <div className="flex rounded-md border border-line p-0.5">
      {options.map(([value, Icon, label]) => (
        <button
          key={value}
          title={`${label} theme`}
          onClick={() => setMode(value)}
          className={clsx(
            'flex-1 rounded px-1.5 py-1',
            mode === value ? 'bg-panel-2 text-fg' : 'text-muted hover:text-fg',
          )}
        >
          <Icon size={14} className="mx-auto" />
        </button>
      ))}
    </div>
  );
}

export function Layout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  // In the phone app: notifications, back button.
  useEffect(() => void startNative((path) => navigate(path)), [navigate]);
  const link = ({ isActive }: { isActive: boolean }) =>
    clsx(
      'flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13px] font-medium',
      isActive ? 'bg-panel-2 text-fg' : 'text-muted hover:bg-panel-2 hover:text-fg',
    );
  return (
    <div className="flex h-full">
      <aside className="hidden w-56 shrink-0 flex-col border-r border-line bg-panel md:flex">
        <div className="flex items-center gap-2 px-4 py-4">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent text-white">
            <Zap size={16} fill="currentColor" />
          </div>
          <span className="font-semibold">AutoForge</span>
          <span className="ml-auto">
            <ConnectionDot />
          </span>
        </div>
        <nav className="flex-1 space-y-0.5 px-2">
          <NavLink to="/dashboard" className={link}>
            <LayoutDashboard size={16} /> Dashboard
          </NavLink>
          <NavLink to="/workflows" className={link}>
            <WorkflowIcon size={16} /> Workflows
          </NavLink>
          <NavLink to="/executions" className={link}>
            <History size={16} /> Executions
          </NavLink>
          <NavLink to="/approvals" className={link}>
            <CircleCheck size={16} /> Approvals
            <PendingCount />
          </NavLink>
          <NavLink to="/credentials" className={link}>
            <KeyRound size={16} /> Credentials
          </NavLink>
          <NavLink to="/variables" className={link}>
            <Braces size={16} /> Variables
          </NavLink>
          <NavLink to="/whatsapp" className={link}>
            <MessageCircle size={16} /> WhatsApp
          </NavLink>
          <NavLink to="/calls" className={link}>
            <Phone size={16} /> Calls
          </NavLink>
          <NavLink to="/agents" className={link}>
            <Bot size={16} /> AI agents
          </NavLink>
          <NavLink to="/templates" className={link}>
            <LayoutTemplate size={16} /> Templates
          </NavLink>
          <NavLink to="/settings" className={link}>
            <Settings size={16} /> Settings
          </NavLink>
        </nav>
        <div className="space-y-3 border-t border-line p-3">
          <ThemeSwitch />
          <Menu
            align="left"
            trigger={
              <button className="flex w-full items-center gap-2 rounded-md p-1.5 text-left hover:bg-panel-2">
                <span className="flex h-7 w-7 items-center justify-center rounded-full bg-accent-soft text-xs font-semibold text-accent">
                  {user?.name.slice(0, 1).toUpperCase()}
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-[13px] font-medium">{user?.name}</span>
                  <span className="block truncate text-[11px] text-muted capitalize">
                    {user?.role}
                  </span>
                </span>
              </button>
            }
            items={[{ label: 'Sign out', icon: LogOut, onClick: logout }]}
          />
        </div>
      </aside>
      <main className="min-w-0 flex-1 pb-[calc(3.5rem+env(safe-area-inset-bottom))] md:pb-0">
        <Outlet />
        <CallBar />
      </main>
      <MobileNav onLogout={logout} />
    </div>
  );
}

/** Phones (and the mobile app): a bottom tab bar instead of the sidebar. */
function MobileNav({ onLogout }: { onLogout: () => void }) {
  const [more, setMore] = useState(false);
  const tab = ({ isActive }: { isActive: boolean }) =>
    clsx(
      'flex flex-1 flex-col items-center gap-0.5 pt-1.5 text-[10.5px] font-medium',
      isActive ? 'text-accent' : 'text-muted',
    );
  const extra: Array<[string, string, typeof Bot]> = [
    ['/agents', 'AI agents', Bot],
    ['/workflows', 'Workflows', WorkflowIcon],
    ['/executions', 'Executions', History],
    ['/templates', 'Templates', LayoutTemplate],
    ['/credentials', 'Credentials', KeyRound],
    ['/variables', 'Variables', Braces],
    ['/settings', 'Settings', Settings],
  ];
  return (
    <>
      {more && (
        <div className="fixed inset-0 z-40 bg-black/30 md:hidden" onClick={() => setMore(false)}>
          <div
            className="absolute inset-x-0 bottom-[calc(3.5rem+env(safe-area-inset-bottom))] rounded-t-2xl border-t border-line bg-panel p-3 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="grid grid-cols-3 gap-2">
              {extra.map(([to, label, Icon]) => (
                <NavLink
                  key={to}
                  to={to}
                  onClick={() => setMore(false)}
                  className="flex flex-col items-center gap-1 rounded-lg p-3 text-xs text-muted hover:bg-panel-2"
                >
                  <Icon size={20} /> {label}
                </NavLink>
              ))}
            </div>
            <div className="mt-3 flex items-center gap-2 border-t border-line pt-3">
              <ThemeSwitch />
              <button
                className="ml-auto flex items-center gap-1.5 text-xs text-muted"
                onClick={onLogout}
              >
                <LogOut size={14} /> Sign out
              </button>
            </div>
          </div>
        </div>
      )}
      <nav
        className="fixed inset-x-0 bottom-0 z-40 flex h-[calc(3.5rem+env(safe-area-inset-bottom))] border-t border-line bg-panel pb-[env(safe-area-inset-bottom)] md:hidden"
        aria-label="Main"
      >
        <NavLink to="/dashboard" className={tab}>
          <LayoutDashboard size={20} /> Home
        </NavLink>
        <NavLink to="/calls" className={tab}>
          <Phone size={20} /> Calls
        </NavLink>
        <NavLink to="/whatsapp" className={tab}>
          <MessageCircle size={20} /> Chats
        </NavLink>
        <NavLink to="/approvals" className={tab}>
          <span className="relative">
            <CircleCheck size={20} />
            <PendingCount dot />
          </span>
          Approvals
        </NavLink>
        <button
          className={tab({ isActive: more })}
          onClick={() => setMore(!more)}
          aria-expanded={more}
        >
          <Menu2 size={20} /> More
        </button>
      </nav>
    </>
  );
}
