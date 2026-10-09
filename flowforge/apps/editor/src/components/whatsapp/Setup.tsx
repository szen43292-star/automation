import { useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import {
  AlertTriangle,
  Check,
  ChevronDown,
  CircleDashed,
  Clock,
  Copy,
  ExternalLink,
  X,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { endpoints, type ChecklistStep, type WhatsAppPlatform } from '../../lib/api';
import { Badge, Button, Field } from '../ui';

const stepIcon = {
  done: <Check size={14} strokeWidth={3} />,
  todo: <CircleDashed size={14} />,
  error: <X size={14} strokeWidth={3} />,
  soon: <Clock size={14} />,
};

export function SetupChecklist({ steps }: { steps: ChecklistStep[] }) {
  const done = steps.filter((s) => s.status === 'done').length;
  const total = steps.filter((s) => s.status !== 'soon').length;
  return (
    <section
      className="rounded-xl border border-line bg-panel p-5"
      aria-labelledby="checklist-title"
    >
      <div className="mb-4 flex items-center gap-3">
        <h2 id="checklist-title" className="font-semibold">
          Setup checklist
        </h2>
        <span className="text-xs text-muted">
          {done} of {total} done
        </span>
        <div className="ml-auto h-1.5 w-40 overflow-hidden rounded-full bg-panel-2">
          <div
            className="h-full rounded-full bg-success transition-all"
            style={{ width: `${(done / Math.max(total, 1)) * 100}%` }}
          />
        </div>
      </div>
      <ol className="grid gap-x-6 gap-y-3 md:grid-cols-2">
        {steps.map((step, index) => (
          <li
            key={step.id}
            className="flex gap-3"
            data-testid={`step-${step.id}`}
            data-status={step.status}
          >
            <span
              className={clsx(
                'mt-0.5 grid size-6 shrink-0 place-items-center rounded-full text-[11px] font-semibold',
                step.status === 'done' && 'bg-success text-white',
                step.status === 'error' && 'bg-danger text-white',
                step.status === 'todo' && 'border border-line text-muted',
                step.status === 'soon' && 'bg-panel-2 text-muted',
              )}
              aria-label={step.status}
            >
              {step.status === 'todo' ? index + 1 : stepIcon[step.status]}
            </span>
            <div className="min-w-0">
              <div className="text-[13px] font-medium">
                {step.title}
                {step.status === 'soon' && (
                  <Badge tone="accent" className="ml-2">
                    Next update
                  </Badge>
                )}
              </div>
              <div
                className={clsx('text-xs', step.status === 'error' ? 'text-danger' : 'text-muted')}
              >
                {step.detail}
              </div>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

function CopyField({ label, value, testId }: { label: string; value: string; testId?: string }) {
  return (
    <div>
      <div className="mb-1 text-[12.5px] font-medium">{label}</div>
      <div className="flex items-center gap-2 rounded-md border border-line bg-panel-2/60 px-2.5 py-1.5">
        <code className="min-w-0 flex-1 truncate text-[12.5px]" data-testid={testId}>
          {value}
        </code>
        <button
          className="text-muted hover:text-fg"
          title={`Copy ${label.toLowerCase()}`}
          onClick={() => {
            void navigator.clipboard.writeText(value);
            toast.success(`${label} copied`);
          }}
        >
          <Copy size={14} />
        </button>
      </div>
    </div>
  );
}

function GuideStep({ n, children }: { n: number; children: ReactNode }) {
  return (
    <li className="flex gap-3 text-[13px] leading-relaxed">
      <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-accent-soft text-[11px] font-semibold text-accent">
        {n}
      </span>
      <div className="min-w-0">{children}</div>
    </li>
  );
}

/**
 * Owner only: the instance's Meta app, entered once. Customers then connect their numbers with
 * "Connect WhatsApp" without ever seeing these values.
 */
export function PlatformSetup({ platform }: { platform: WhatsAppPlatform }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(!platform.embeddedSignupReady);
  const [form, setForm] = useState({
    appId: platform.appId ?? '',
    appSecret: '',
    configId: platform.configId ?? '',
  });
  const [saving, setSaving] = useState(false);
  const fromEnv = (key: keyof WhatsAppPlatform['sources']) => platform.sources[key] === 'env';
  const local = /^http:\/\/(localhost|127\.|192\.168\.|10\.)/.test(platform.webhookUrl);

  const save = async () => {
    setSaving(true);
    try {
      await endpoints.saveWhatsappPlatform({
        ...(fromEnv('appId') ? {} : { appId: form.appId }),
        ...(fromEnv('configId') ? {} : { configId: form.configId }),
        ...(form.appSecret && !fromEnv('appSecret') ? { appSecret: form.appSecret } : {}),
      });
      setForm((f) => ({ ...f, appSecret: '' }));
      toast.success('Meta app saved');
      await queryClient.invalidateQueries({ queryKey: ['whatsapp'] });
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="rounded-xl border border-line bg-panel" aria-labelledby="platform-title">
      <button
        className="flex w-full items-center gap-3 p-5 text-left"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        <div>
          <h2 id="platform-title" className="font-semibold">
            Your Meta app{' '}
            <span className="font-normal text-muted">· one-time setup by the owner</span>
          </h2>
          <p className="text-xs text-muted">
            Lets you connect WhatsApp numbers with one click. Set here, or as server variables - or
            bake them into your private builds (see README). The secret is stored encrypted.
          </p>
        </div>
        <span className="ml-auto flex items-center gap-2">
          {platform.embeddedSignupReady ? (
            <Badge tone="success">Ready</Badge>
          ) : (
            <Badge tone="warning">Not set up</Badge>
          )}
          <ChevronDown size={16} className={clsx('text-muted transition', open && 'rotate-180')} />
        </span>
      </button>
      {open && (
        <div className="grid gap-6 border-t border-line p-5 lg:grid-cols-[1fr_1fr]">
          <ol className="space-y-3">
            <GuideStep n={1}>
              At{' '}
              <a
                href="https://developers.facebook.com/apps"
                target="_blank"
                rel="noreferrer"
                className="font-medium text-accent hover:underline"
              >
                developers.facebook.com <ExternalLink size={11} className="inline" />
              </a>{' '}
              create an app of type <b>Business</b> and add the <b>WhatsApp</b> product.
            </GuideStep>
            <GuideStep n={2}>
              In <b>App settings → Basic</b>, copy the <b>App ID</b> and <b>App secret</b> into the
              form.
            </GuideStep>
            <GuideStep n={3}>
              In <b>Facebook Login for Business → Configurations</b>, create a configuration from
              the <b>WhatsApp Embedded Signup</b> template and copy its <b>Configuration ID</b>.
            </GuideStep>
            <GuideStep n={4}>
              In <b>WhatsApp → Configuration</b>, paste the callback URL and verify token below,
              click <b>Verify and save</b>, then subscribe to the <b>messages</b> field.
            </GuideStep>
            <GuideStep n={5}>
              To let other businesses connect, finish <b>business verification</b> and request the{' '}
              <code className="text-[12px]">whatsapp_business_messaging</code> and{' '}
              <code className="text-[12px]">whatsapp_business_management</code> permissions in App
              Review.
            </GuideStep>
          </ol>
          <div className="space-y-4">
            <Field
              label="App ID"
              hint={fromEnv('appId') ? 'Set on the server (META_APP_ID)' : undefined}
            >
              <input
                className="ff-input font-mono"
                value={form.appId}
                disabled={fromEnv('appId')}
                onChange={(e) => setForm({ ...form, appId: e.target.value.trim() })}
                placeholder="e.g. 1234567890123456"
              />
            </Field>
            <Field
              label="App secret"
              hint={
                fromEnv('appSecret')
                  ? 'Set on the server (META_APP_SECRET)'
                  : platform.appSecretSet
                    ? 'Saved and encrypted. Type a new one to replace it.'
                    : 'Stored encrypted on the server.'
              }
            >
              <input
                className="ff-input font-mono"
                type="password"
                autoComplete="off"
                value={form.appSecret}
                disabled={fromEnv('appSecret')}
                onChange={(e) => setForm({ ...form, appSecret: e.target.value.trim() })}
                placeholder={platform.appSecretSet ? '••••••••••••••••' : 'App secret'}
              />
            </Field>
            <Field
              label="Embedded Signup configuration ID"
              hint={
                fromEnv('configId')
                  ? 'Set on the server (META_EMBEDDED_SIGNUP_CONFIG_ID)'
                  : undefined
              }
            >
              <input
                className="ff-input font-mono"
                value={form.configId}
                disabled={fromEnv('configId')}
                onChange={(e) => setForm({ ...form, configId: e.target.value.trim() })}
                placeholder="e.g. 987654321098765"
              />
            </Field>
            <Button variant="primary" loading={saving} onClick={() => void save()}>
              Save
            </Button>
            <div className="space-y-3 border-t border-line pt-4">
              <CopyField
                label="Callback URL"
                value={platform.webhookUrl}
                testId="webhook-callback-url"
              />
              {platform.verifyToken && (
                <CopyField
                  label="Verify token"
                  value={platform.verifyToken}
                  testId="webhook-verify-token"
                />
              )}
              {local && (
                <div className="flex gap-2 rounded-md bg-warning-soft p-2.5 text-xs text-warning">
                  <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                  Meta can only reach a public HTTPS address. Deploy the server (or set PUBLIC_URL
                  to a tunnel) before verifying the webhook. Test numbers work without it.
                </div>
              )}
              {platform.webhookVerifiedAt && (
                <div className="text-xs text-success">
                  Webhook verified {new Date(platform.webhookVerifiedAt).toLocaleString()}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
