import { useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import {
  FlaskConical,
  KeyRound,
  MessageCircle,
  MoreHorizontal,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { endpoints, type WhatsAppAccount, type WhatsAppPlatform } from '../../lib/api';
import { runEmbeddedSignup } from '../../lib/embeddedSignup';
import { useAuth } from '../../stores/auth';
import { Badge, Button, Field, IconButton, Menu, Modal } from '../ui';

const LIMITS: Record<string, string> = {
  TIER_50: '50 new customers / day',
  TIER_250: '250 new customers / day',
  TIER_1K: '1,000 new customers / day',
  TIER_10K: '10,000 new customers / day',
  TIER_100K: '100,000 new customers / day',
  TIER_UNLIMITED: 'Unlimited',
};

export function AccountCard({
  account,
  selected,
  onSelect,
}: {
  account: WhatsAppAccount;
  selected: boolean;
  onSelect: () => void;
}) {
  const queryClient = useQueryClient();
  const canManage = useAuth((s) => s.user?.role !== 'member');
  const [busy, setBusy] = useState(false);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['whatsapp'] });
  const test = account.mode === 'simulator';

  return (
    <div
      className={clsx(
        'rounded-xl border bg-panel p-4 transition',
        selected ? 'border-accent ring-2 ring-accent/15' : 'border-line hover:border-muted/40',
      )}
      data-testid="whatsapp-account"
    >
      <div className="flex items-start gap-3">
        <div
          className={clsx(
            'grid size-10 shrink-0 place-items-center rounded-full',
            test ? 'bg-panel-2 text-muted' : 'bg-[#25D366]/15 text-[#1da851]',
          )}
        >
          {test ? <FlaskConical size={18} /> : <MessageCircle size={18} />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold tabular-nums">{account.displayPhoneNumber}</span>
            {test ? (
              <Badge tone="info">Test number</Badge>
            ) : account.status === 'connected' ? (
              <Badge tone="success">Connected</Badge>
            ) : (
              <Badge tone="danger">Needs attention</Badge>
            )}
            {account.qualityRating && !test && (
              <Badge
                tone={
                  account.qualityRating === 'GREEN'
                    ? 'success'
                    : account.qualityRating === 'YELLOW'
                      ? 'warning'
                      : 'danger'
                }
              >
                Quality {account.qualityRating.toLowerCase()}
              </Badge>
            )}
          </div>
          <div className="truncate text-[13px] text-muted">
            {account.verifiedName ?? account.name}
            {account.messagingLimit &&
              ` · ${LIMITS[account.messagingLimit] ?? account.messagingLimit}`}
            {test && ' · messages are simulated, nothing is sent to WhatsApp'}
          </div>
          {account.lastError && (
            <div className="mt-1 text-xs whitespace-pre-line text-danger">{account.lastError}</div>
          )}
        </div>
        <div className="flex items-center gap-1">
          <Button size="sm" variant={selected ? 'primary' : 'secondary'} onClick={onSelect}>
            {test ? 'Open simulator' : 'Messages'}
          </Button>
          {canManage && (
            <Menu
              trigger={<IconButton icon={MoreHorizontal} label="More" />}
              items={[
                ...(test
                  ? []
                  : [
                      {
                        label: 'Refresh',
                        icon: RefreshCw,
                        onClick: async () => {
                          setBusy(true);
                          try {
                            const updated = await endpoints.refreshWhatsappAccount(account.id);
                            toast[updated.status === 'connected' ? 'success' : 'error'](
                              updated.status === 'connected'
                                ? 'Number is ready'
                                : (updated.lastError ?? 'Needs attention'),
                            );
                          } finally {
                            setBusy(false);
                            await refresh();
                          }
                        },
                      },
                    ]),
                {
                  label: test ? 'Delete test number' : 'Disconnect',
                  icon: Trash2,
                  danger: true,
                  onClick: async () => {
                    if (
                      !window.confirm(
                        `${test ? 'Delete' : 'Disconnect'} ${account.displayPhoneNumber}? Workflows using it will stop sending.`,
                      )
                    )
                      return;
                    await endpoints.disconnectWhatsappAccount(account.id);
                    toast.success(test ? 'Test number deleted' : 'Number disconnected');
                    await refresh();
                  },
                },
              ]}
            />
          )}
        </div>
      </div>
      {busy && <div className="mt-2 text-xs text-muted">Checking with Meta…</div>}
    </div>
  );
}

/** The ways to add a number: one click with Facebook, a test number, or (advanced) a token. */
export function ConnectOptions({
  platform,
  onConnected,
}: {
  platform: WhatsAppPlatform;
  onConnected: (account: WhatsAppAccount) => void;
}) {
  const queryClient = useQueryClient();
  const role = useAuth((s) => s.user?.role);
  const canManage = role !== 'member';
  const [connecting, setConnecting] = useState(false);
  const [manual, setManual] = useState(false);

  const done = async (account: WhatsAppAccount) => {
    await queryClient.invalidateQueries({ queryKey: ['whatsapp'] });
    onConnected(account);
  };

  const connect = async () => {
    if (!platform.appId || !platform.configId) return;
    setConnecting(true);
    try {
      const result = await runEmbeddedSignup({
        appId: platform.appId,
        configId: platform.configId,
        graphVersion: platform.graphVersion,
      });
      const account = await endpoints.connectEmbeddedSignup(result);
      toast[account.status === 'connected' ? 'success' : 'warning'](
        account.status === 'connected'
          ? `${account.displayPhoneNumber} is connected`
          : `${account.displayPhoneNumber} needs attention`,
      );
      await done(account);
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setConnecting(false);
    }
  };

  const addTestNumber = async () => {
    try {
      const account = await endpoints.createTestNumber({});
      toast.success('Test number added - try it in the simulator');
      await done(account);
    } catch (error) {
      toast.error((error as Error).message);
    }
  };

  if (!canManage) return null;

  return (
    <div className="grid gap-3 md:grid-cols-2">
      <div className="rounded-xl border border-line bg-panel p-4">
        <div className="flex items-center gap-2 font-semibold">
          <MessageCircle size={17} className="text-[#25D366]" /> Connect WhatsApp
        </div>
        <p className="mt-1 mb-3 text-[13px] text-muted">
          Log in with Facebook, pick your business and number. No API keys - Meta handles the login.
        </p>
        <Button
          variant="primary"
          loading={connecting}
          disabled={!platform.embeddedSignupReady}
          onClick={() => void connect()}
        >
          Connect with Facebook
        </Button>
        {!platform.embeddedSignupReady && (
          <p className="mt-2 text-xs text-warning">
            {role === 'owner'
              ? 'Finish "Your Meta app" above first.'
              : 'The owner needs to set up the Meta app first.'}
          </p>
        )}
        <button
          className="mt-3 flex items-center gap-1.5 text-xs text-muted hover:text-fg"
          onClick={() => setManual(true)}
        >
          <KeyRound size={12} /> Advanced: connect with an access token
        </button>
      </div>
      <div className="rounded-xl border border-line bg-panel p-4">
        <div className="flex items-center gap-2 font-semibold">
          <FlaskConical size={17} className="text-info" /> Add a test number
        </div>
        <p className="mt-1 mb-3 text-[13px] text-muted">
          Try everything right now, without a Meta account: chat as a customer here and watch your
          workflows reply.
        </p>
        <Button onClick={() => void addTestNumber()}>Add test number</Button>
      </div>
      <ManualConnectModal
        open={manual}
        onClose={() => setManual(false)}
        onConnected={(a) => void done(a)}
      />
    </div>
  );
}

function ManualConnectModal({
  open,
  onClose,
  onConnected,
}: {
  open: boolean;
  onClose: () => void;
  onConnected: (account: WhatsAppAccount) => void;
}) {
  const [form, setForm] = useState({ wabaId: '', phoneNumberId: '', accessToken: '' });
  const [saving, setSaving] = useState(false);
  const submit = async () => {
    setSaving(true);
    try {
      const account = await endpoints.connectManual(form);
      toast.success(`${account.displayPhoneNumber} is connected`);
      setForm({ wabaId: '', phoneNumberId: '', accessToken: '' });
      onClose();
      onConnected(account);
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Connect with an access token"
      width={520}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={saving} onClick={() => void submit()}>
            Connect
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-[13px] text-muted">
          For numbers you set up yourself in Meta (WhatsApp → API Setup). Use a permanent System
          User token. The token is encrypted on the server and never shown again.
        </p>
        <Field label="WhatsApp Business Account ID">
          <input
            className="ff-input font-mono"
            value={form.wabaId}
            onChange={(e) => setForm({ ...form, wabaId: e.target.value })}
          />
        </Field>
        <Field label="Phone number ID">
          <input
            className="ff-input font-mono"
            value={form.phoneNumberId}
            onChange={(e) => setForm({ ...form, phoneNumberId: e.target.value })}
          />
        </Field>
        <Field label="Permanent access token">
          <input
            className="ff-input font-mono"
            type="password"
            autoComplete="off"
            value={form.accessToken}
            onChange={(e) => setForm({ ...form, accessToken: e.target.value })}
          />
        </Field>
      </div>
    </Modal>
  );
}
