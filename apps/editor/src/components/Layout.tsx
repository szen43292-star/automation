import { clsx } from 'clsx';
import {
  Bot,
  Braces,
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
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { CallBar } from './calls/CallBar';
import { push } from '../lib/push';
import { useTheme, type ThemeMode } from '../lib/theme';
import { useAuth } from '../stores/auth';
import { Menu } from './ui';

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
          <span className="font-semibold">FlowForge</span>
          <span className="ml-auto">
            <ConnectionDot />
          </span>
        </div>
        <nav className="flex-1 space-y-0.5 px-2">
          <NavLink to="/workflows" className={link}>
            <WorkflowIcon size={16} /> Workflows
          </NavLink>
          <NavLink to="/executions" className={link}>
            <History size={16} /> Executions
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
      <main className="min-w-0 flex-1">
        <Outlet />
        <CallBar />
      </main>
    </div>
  );
}
