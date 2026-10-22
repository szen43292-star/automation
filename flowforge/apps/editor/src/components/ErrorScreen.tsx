import { AlertTriangle, LogOut, RefreshCw } from 'lucide-react';
import { useRouteError } from 'react-router-dom';
import { useAuth } from '../stores/auth';
import { Button } from './ui';

/** Shown instead of a blank crash page when a screen fails to load. */
export function ErrorScreen() {
  const error = useRouteError() as Error | undefined;
  return (
    <div className="flex min-h-full items-center justify-center bg-bg p-6">
      <div className="w-full max-w-sm space-y-4 rounded-xl border border-line bg-panel p-6 text-center shadow-card">
        <AlertTriangle className="mx-auto text-danger" size={28} />
        <div>
          <h1 className="text-base font-semibold">Something went wrong</h1>
          <p className="mt-1 break-words text-[13px] text-muted">
            {error?.message || 'This screen could not be shown.'}
          </p>
        </div>
        <div className="flex flex-col gap-2">
          <Button icon={RefreshCw} onClick={() => window.location.reload()}>
            Reload
          </Button>
          <Button
            variant="ghost"
            icon={LogOut}
            onClick={() => {
              useAuth.getState().logout();
              window.location.hash = '';
              window.location.reload();
            }}
          >
            Sign out / change server
          </Button>
        </div>
      </div>
    </div>
  );
}
