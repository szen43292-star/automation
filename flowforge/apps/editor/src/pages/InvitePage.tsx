import { useQuery } from '@tanstack/react-query';
import { Zap } from 'lucide-react';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Button, Field, Spinner } from '../components/ui';
import { endpoints } from '../lib/api';
import { useAuth } from '../stores/auth';

/** Accept a team invitation: choose a password, then you're signed in. */
export function InvitePage() {
  const { token = '' } = useParams();
  const navigate = useNavigate();
  const invitation = useQuery({
    queryKey: ['invitation', token],
    queryFn: () => endpoints.invitation(token),
    retry: false,
  });
  const [name, setName] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const accept = async () => {
    setBusy(true);
    setError(null);
    try {
      const session = await endpoints.acceptInvitation(token, {
        password,
        ...(name ? { name } : {}),
      });
      useAuth.getState().setSession(session.token, session.user);
      navigate('/', { replace: true });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <div className="w-full max-w-sm rounded-xl border border-line bg-panel p-6 shadow-sm">
        <div className="mb-5 flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent text-white">
            <Zap size={17} fill="currentColor" />
          </div>
          <span className="text-lg font-semibold">Join AutoForge</span>
        </div>
        {invitation.isLoading ? (
          <Spinner />
        ) : invitation.isError ? (
          <p className="text-[13px] text-danger">{(invitation.error as Error).message}</p>
        ) : (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              void accept();
            }}
          >
            <p className="text-[13px] text-muted">
              You were invited as <b>{invitation.data!.role}</b> ({invitation.data!.email}).
            </p>
            <Field label="Your name">
              <input
                className="ff-input"
                value={name ?? invitation.data!.name}
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
            <Field
              label="Choose a password"
              hint="8+ characters with an uppercase letter and a number."
              error={error ?? undefined}
            >
              <input
                className="ff-input"
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                aria-label="Password"
              />
            </Field>
            <Button
              type="submit"
              variant="primary"
              loading={busy}
              disabled={!password}
              className="w-full justify-center"
            >
              Join
            </Button>
          </form>
        )}
      </div>
    </div>
  );
}
