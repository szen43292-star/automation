import { useQuery } from '@tanstack/react-query';
import { Bot, PhoneOutgoing, ShieldCheck, User } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { endpoints, type WhatsAppAccount } from '../../lib/api';
import { push } from '../../lib/push';
import { useCalls } from '../../stores/calls';
import { Badge, Button, Field, Modal } from '../ui';

const STATUS: Record<
  string,
  { label: string; tone: 'success' | 'warning' | 'danger' | 'neutral' }
> = {
  granted: { label: 'Allowed calls', tone: 'success' },
  requested: { label: 'Permission asked - waiting', tone: 'warning' },
  denied: { label: 'Declined calls', tone: 'danger' },
  expired: { label: 'Permission expired', tone: 'neutral' },
  none: { label: 'Not asked yet', tone: 'neutral' },
};

/** Call a customer: ask for permission first (WhatsApp rule), then you or the AI agent call. */
export function OutboundCall({
  account,
  contact,
  name,
}: {
  account: WhatsAppAccount;
  contact: string;
  name: string;
}) {
  const [open, setOpen] = useState(false);
  const [purpose, setPurpose] = useState('');
  const [agentId, setAgentId] = useState('');
  const [busy, setBusy] = useState(false);
  const permission = useQuery({
    queryKey: ['whatsapp', 'call-permission', account.id, contact],
    queryFn: () => endpoints.callPermission(account.id, contact),
    enabled: open && contact.length >= 7,
  });
  const agents = useQuery({ queryKey: ['agents'], queryFn: endpoints.agents, enabled: open });
  const onCall = useCalls((s) => s.current);

  useEffect(() => {
    if (!open) return;
    const unsubscribe = push.subscribe('whatsapp');
    const off = push.on((message) => {
      if (message.type === 'callPermission' && message.data.contact === contact)
        void permission.refetch();
    });
    return () => {
      off();
      unsubscribe();
    };
  }, [open, contact, permission]);

  const status = permission.data?.status ?? 'none';
  const granted = status === 'granted';

  const ask = async () => {
    setBusy(true);
    try {
      await endpoints.requestCallPermission(account.id, contact);
      toast.success('Permission request sent on WhatsApp');
      await permission.refetch();
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const agentCall = async () => {
    setBusy(true);
    try {
      await endpoints.outboundCall({
        accountId: account.id,
        to: contact,
        handler: 'agent',
        agentId: agentId || null,
        purpose,
      });
      toast.success(`The AI agent is calling ${name}`);
      setOpen(false);
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button
        size="sm"
        icon={PhoneOutgoing}
        onClick={() => setOpen(true)}
        title="Call this customer"
      >
        Call customer
      </Button>
      <Modal open={open} onClose={() => setOpen(false)} title={`Call ${name}`} width={520}>
        <div className="space-y-4">
          <div className="flex items-center gap-2 text-[13px]">
            <ShieldCheck size={15} className="text-muted" />
            WhatsApp only lets businesses call customers who allowed it.
            <span className="ml-auto" data-testid="call-permission">
              <Badge tone={STATUS[status]!.tone}>{STATUS[status]!.label}</Badge>
            </span>
          </div>
          {!granted ? (
            <div className="rounded-lg border border-line p-3 text-[13px]">
              <p className="mb-2 text-muted">
                {name} gets a WhatsApp message with an <b>Allow calls</b> button. Permission lasts 7
                days.
                {account.mode === 'simulator' && ' On a test number, tap it in this chat.'}
              </p>
              <Button variant="primary" loading={busy} onClick={() => void ask()}>
                {status === 'requested' ? 'Ask again' : 'Ask permission to call'}
              </Button>
            </div>
          ) : (
            <>
              <div className="rounded-lg border border-line p-3">
                <div className="mb-2 flex items-center gap-2 text-[13px] font-medium">
                  <User size={15} /> You talk
                </div>
                <Button
                  disabled={Boolean(onCall)}
                  onClick={() => {
                    setOpen(false);
                    void useCalls.getState().callCustomer(account.id, contact, name);
                  }}
                >
                  Call from this device
                </Button>
              </div>
              <div className="space-y-3 rounded-lg border border-line p-3">
                <div className="flex items-center gap-2 text-[13px] font-medium">
                  <Bot size={15} /> The AI agent calls
                </div>
                <Field label="Agent">
                  <select
                    className="ff-input"
                    value={agentId}
                    onChange={(e) => setAgentId(e.target.value)}
                    aria-label="Agent"
                  >
                    <option value="">The number's agent</option>
                    {agents.data?.data.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Purpose of the call" hint="What should the agent do?">
                  <textarea
                    className="ff-input min-h-16"
                    value={purpose}
                    onChange={(e) => setPurpose(e.target.value)}
                    placeholder={`Remind ${name} of the appointment tomorrow at 5 pm and confirm they are coming.`}
                  />
                </Field>
                <Button
                  variant="primary"
                  icon={Bot}
                  loading={busy}
                  disabled={!purpose.trim()}
                  onClick={() => void agentCall()}
                >
                  Start AI call
                </Button>
              </div>
            </>
          )}
        </div>
      </Modal>
    </>
  );
}
