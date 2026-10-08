import { useQuery } from '@tanstack/react-query';
import { Server, Workflow } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { ApiError, endpoints, getServerUrl, setServerUrl } from '../lib/api';
import { useAuth } from '../stores/auth';
import { Button, Field, Spinner } from '../components/ui';

export function AuthPage() {
  const [serverInput, setServerInput] = useState(getServerUrl());
  const [showServer, setShowServer] = useState(Boolean(getServerUrl()));
  const status = useQuery({
    queryKey: ['auth-status', getServerUrl()],
    queryFn: endpoints.status,
    retry: false,
  });
  const setupRequired = status.data?.setupRequired;

  return (
    <div className="flex min-h-full items-center justify-center bg-bg p-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center gap-2">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-accent text-white shadow-card">
            <Workflow size={26} />
          </div>
          <h1 className="text-xl font-semibold">FlowForge</h1>
          <p className="text-[13px] text-muted">
            {setupRequired
              ? 'Create the owner account for this instance'
              : 'Sign in to your workspace'}
          </p>
        </div>
        <div className="rounded-xl border border-line bg-panel p-6 shadow-card">
          {status.isLoading ? (
            <div className="flex justify-center py-8">
              <Spinner />
            </div>
          ) : status.isError ? (
            <div className="space-y-3 text-[13px]">
              <div className="rounded-md bg-danger-soft p-3 text-danger">
                {(status.error as Error).message}
              </div>
              <Button className="w-full" onClick={() => status.refetch()}>
                Try again
              </Button>
            </div>
          ) : setupRequired ? (
            <SetupForm />
          ) : (
            <SignInForm />
          )}
        </div>
        <div className="mt-4 text-center text-xs text-muted">
          {showServer ? (
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                setServerUrl(serverInput);
                void status.refetch();
              }}
            >
              <input
                className="ff-input"
                placeholder="https://flowforge.example.com (empty = this site)"
                value={serverInput}
                onChange={(e) => setServerInput(e.target.value)}
              />
              <Button type="submit" size="sm">
                Connect
              </Button>
            </form>
          ) : (
            <button
              className="inline-flex items-center gap-1 hover:text-fg"
              onClick={() => setShowServer(true)}
            >
              <Server size={12} /> Connect to a different server
            </button>
          )}
          {status.data?.version && <div className="mt-2">Server version {status.data.version}</div>}
        </div>
      </div>
    </div>
  );
}

function useSubmit() {
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const run = async (fn: () => Promise<void>) => {
    setLoading(true);
    setError(null);
    setFieldErrors({});
    try {
      await fn();
    } catch (e) {
      if (e instanceof ApiError && e.body?.issues) {
        setFieldErrors(Object.fromEntries(e.body.issues.map((i) => [i.path, i.message])));
      }
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };
  return { error, fieldErrors, loading, run };
}

function SignInForm() {
  const setSession = useAuth((s) => s.setSession);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const { error, loading, run } = useSubmit();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const { token, user } = await endpoints.login({ email, password });
      setSession(token, user);
    });
  };
  return (
    <form onSubmit={submit} className="space-y-4">
      <Field label="Email">
        <input
          className="ff-input"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </Field>
      <Field label="Password">
        <input
          className="ff-input"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </Field>
      {error && (
        <div className="rounded-md bg-danger-soft px-3 py-2 text-[13px] text-danger">{error}</div>
      )}
      <Button type="submit" variant="primary" className="w-full" loading={loading}>
        Sign in
      </Button>
    </form>
  );
}

function SetupForm() {
  const setSession = useAuth((s) => s.setSession);
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const { error, fieldErrors, loading, run } = useSubmit();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const { token, user } = await endpoints.setup(form);
      setSession(token, user);
    });
  };
  return (
    <form onSubmit={submit} className="space-y-4">
      <Field label="Your name" error={fieldErrors.name}>
        <input
          className="ff-input"
          required
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
        />
      </Field>
      <Field label="Email" error={fieldErrors.email}>
        <input
          className="ff-input"
          type="email"
          required
          value={form.email}
          onChange={(e) => setForm({ ...form, email: e.target.value })}
        />
      </Field>
      <Field
        label="Password"
        hint="At least 8 characters, one uppercase letter and one number"
        error={fieldErrors.password}
      >
        <input
          className="ff-input"
          type="password"
          autoComplete="new-password"
          required
          value={form.password}
          onChange={(e) => setForm({ ...form, password: e.target.value })}
        />
      </Field>
      {error && !Object.keys(fieldErrors).length && (
        <div className="rounded-md bg-danger-soft px-3 py-2 text-[13px] text-danger">{error}</div>
      )}
      <Button type="submit" variant="primary" className="w-full" loading={loading}>
        Create owner account
      </Button>
    </form>
  );
}
