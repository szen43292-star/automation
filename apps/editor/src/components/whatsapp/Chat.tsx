import { useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import {
  AlertCircle,
  Check,
  CheckCheck,
  FileText,
  List,
  MapPin,
  MessageCircle,
  Plus,
  Send,
  UserRound,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { IDataObject } from '@flowforge/workflow';
import { endpoints, type WhatsAppAccount, type WhatsAppMessage } from '../../lib/api';
import { formatDateTime } from '../../lib/format';
import { Button, EmptyState, Spinner } from '../ui';

const DEFAULT_CUSTOMER = { number: '+91 98765 43210', name: 'Test customer' };
const digits = (value: string) => value.replace(/[^\d]/g, '');
const time = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

function Ticks({ status }: { status: WhatsAppMessage['status'] }) {
  if (status === 'failed')
    return <AlertCircle size={13} className="text-danger" aria-label="failed" />;
  if (status === 'sent') return <Check size={13} className="text-muted" aria-label="sent" />;
  if (status === 'delivered')
    return <CheckCheck size={13} className="text-muted" aria-label="delivered" />;
  if (status === 'read') return <CheckCheck size={13} className="text-sky-500" aria-label="read" />;
  return null;
}

/** Chat view of one number. On a test number you type as the customer and tap buttons like they would. */
export function ChatPanel({ account }: { account: WhatsAppAccount }) {
  const queryClient = useQueryClient();
  const simulator = account.mode === 'simulator';
  const conversations = useQuery({
    queryKey: ['whatsapp', 'conversations', account.id],
    queryFn: () => endpoints.whatsappConversations(account.id),
  });
  const [contact, setContact] = useState<string | null>(null);
  const [customer, setCustomer] = useState(DEFAULT_CUSTOMER);
  const [newChat, setNewChat] = useState(false);
  const list = conversations.data?.data ?? [];

  // Pick the newest conversation once loaded; the simulator starts with the test customer.
  useEffect(() => {
    if (contact || newChat) return;
    if (list[0]) setContact(list[0].contact);
    else if (simulator && conversations.isSuccess) setContact(digits(DEFAULT_CUSTOMER.number));
  }, [list, contact, newChat, simulator, conversations.isSuccess]);

  useEffect(() => {
    setContact(null);
    setNewChat(false);
  }, [account.id]);

  const active = list.find((c) => c.contact === contact);
  const customerNumber = contact ?? digits(customer.number);
  const customerName = active?.contactName ?? customer.name;

  return (
    <section
      className="flex h-[560px] overflow-hidden rounded-xl border border-line bg-panel"
      aria-label="Messages"
    >
      <aside className="flex w-64 shrink-0 flex-col border-r border-line">
        <div className="flex items-center gap-2 border-b border-line px-3 py-2.5">
          <span className="text-[13px] font-semibold">
            {simulator ? 'Test chats' : 'Conversations'}
          </span>
          {simulator && (
            <button
              className="ml-auto flex items-center gap-1 text-xs text-accent hover:underline"
              onClick={() => {
                setNewChat(true);
                setContact(null);
              }}
            >
              <Plus size={12} /> New customer
            </button>
          )}
        </div>
        <div className="ff-scroll min-h-0 flex-1 overflow-y-auto">
          {conversations.isLoading ? (
            <div className="flex justify-center py-8">
              <Spinner />
            </div>
          ) : list.length === 0 ? (
            <p className="p-3 text-xs text-muted">
              {simulator ? 'Send a message as a customer to start.' : 'No messages yet.'}
            </p>
          ) : (
            list.map((c) => (
              <button
                key={c.contact}
                onClick={() => {
                  setNewChat(false);
                  setContact(c.contact);
                }}
                className={clsx(
                  'flex w-full items-start gap-2.5 border-b border-line/60 px-3 py-2.5 text-left hover:bg-panel-2',
                  c.contact === contact && 'bg-panel-2',
                )}
              >
                <div className="grid size-8 shrink-0 place-items-center rounded-full bg-panel-3 text-muted">
                  <UserRound size={15} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-[13px] font-medium">
                      {c.contactName ?? `+${c.contact}`}
                    </span>
                    <span className="ml-auto shrink-0 text-[10.5px] text-muted">
                      {time(c.timestamp)}
                    </span>
                  </div>
                  <div className="truncate text-xs text-muted">{c.text ?? '…'}</div>
                </div>
              </button>
            ))
          )}
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        {newChat && simulator ? (
          <div className="flex items-end gap-2 border-b border-line bg-panel-2/40 px-4 py-3">
            <label className="block flex-1">
              <span className="mb-1 block text-xs font-medium">Customer number</span>
              <input
                className="ff-input"
                value={customer.number}
                onChange={(e) => setCustomer({ ...customer, number: e.target.value })}
              />
            </label>
            <label className="block flex-1">
              <span className="mb-1 block text-xs font-medium">Name</span>
              <input
                className="ff-input"
                value={customer.name}
                onChange={(e) => setCustomer({ ...customer, name: e.target.value })}
              />
            </label>
          </div>
        ) : (
          <div className="flex items-center gap-2.5 border-b border-line px-4 py-2.5">
            <div className="grid size-8 place-items-center rounded-full bg-panel-3 text-muted">
              <UserRound size={15} />
            </div>
            <div>
              <div className="text-[13px] font-medium">{customerName}</div>
              <div className="text-[11.5px] text-muted">+{customerNumber}</div>
            </div>
            {simulator && (
              <span className="ml-auto text-[11.5px] text-muted">
                You are chatting as this customer
              </span>
            )}
          </div>
        )}
        <Thread
          account={account}
          contact={newChat ? digits(customer.number) : customerNumber}
          customerName={newChat ? customer.name : customerName}
          onSent={() => {
            if (newChat) {
              setNewChat(false);
              setContact(digits(customer.number));
            }
            void queryClient.invalidateQueries({
              queryKey: ['whatsapp', 'conversations', account.id],
            });
          }}
        />
      </div>
    </section>
  );
}

function Thread({
  account,
  contact,
  customerName,
  onSent,
}: {
  account: WhatsAppAccount;
  contact: string;
  customerName: string;
  onSent: () => void;
}) {
  const simulator = account.mode === 'simulator';
  const messages = useQuery({
    queryKey: ['whatsapp', 'messages', account.id, contact],
    queryFn: () => endpoints.whatsappMessages(account.id, contact),
    enabled: contact.length >= 7,
  });
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const rows = useMemo(() => messages.data?.data ?? [], [messages.data]);

  useEffect(() => bottom.current?.scrollIntoView({ block: 'end' }), [rows.length]);

  const asCustomer = async (body: Parameters<typeof endpoints.simulateWhatsapp>[1]) => {
    try {
      await endpoints.simulateWhatsapp(account.id, body);
      onSent();
    } catch (error) {
      toast.error((error as Error).message);
    }
  };

  const send = async () => {
    const value = text.trim();
    if (!value) return;
    setSending(true);
    try {
      if (simulator) await asCustomer({ from: contact, name: customerName, text: value });
      else {
        await endpoints.sendWhatsapp(account.id, { to: contact, text: value });
        onSent();
      }
      setText('');
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setSending(false);
    }
  };

  return (
    <>
      <div
        className="ff-scroll min-h-0 flex-1 space-y-2 overflow-y-auto bg-[url('data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%2224%22 height=%2224%22><circle cx=%222%22 cy=%222%22 r=%221%22 fill=%22%2380808018%22/></svg>')] px-4 py-3"
        data-testid="chat-thread"
      >
        {rows.length === 0 && !messages.isLoading && (
          <EmptyState
            icon={MessageCircle}
            title={simulator ? 'Say hi as a customer' : 'No messages with this contact yet'}
            description={
              simulator
                ? 'Type below and press Enter. Active workflows with a WhatsApp Trigger on this number will answer here.'
                : 'Messages appear here as they are sent and received.'
            }
          />
        )}
        {rows.map((m) => (
          <Bubble
            key={m.id}
            message={m}
            simulator={simulator}
            onReply={(reply) => void asCustomer({ from: contact, name: customerName, reply })}
          />
        ))}
        <div ref={bottom} />
      </div>
      <div className="flex items-center gap-2 border-t border-line p-3">
        <input
          className="ff-input"
          placeholder={
            simulator
              ? `Message as ${customerName}…`
              : 'Reply (within 24 hours of their last message)…'
          }
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && void send()}
          aria-label={simulator ? 'Message as customer' : 'Reply'}
        />
        {simulator && (
          <Button
            variant="ghost"
            icon={MapPin}
            title="Send a location as the customer"
            onClick={() =>
              void asCustomer({
                from: contact,
                name: customerName,
                location: { latitude: 18.5204, longitude: 73.8567, name: 'Pune, India' },
              })
            }
          >
            <span className="sr-only">Send location</span>
          </Button>
        )}
        <Button variant="primary" icon={Send} loading={sending} onClick={() => void send()}>
          Send
        </Button>
      </div>
    </>
  );
}

type Reply = { id: string; title: string; type: 'button' | 'list' };

function Bubble({
  message,
  simulator,
  onReply,
}: {
  message: WhatsAppMessage;
  simulator: boolean;
  onReply: (reply: Reply) => void;
}) {
  const outbound = message.direction === 'outbound';
  const payload = message.payload ?? {};
  const interactive = (payload.interactive ?? null) as IDataObject | null;
  const [listOpen, setListOpen] = useState(false);
  const buttons =
    interactive?.type === 'button'
      ? (
          ((interactive.action as IDataObject).buttons as Array<{
            reply: { id: string; title: string };
          }>) ?? []
        ).map((b) => b.reply)
      : [];
  const sections =
    interactive?.type === 'list'
      ? (((interactive.action as IDataObject).sections as Array<{
          title?: string;
          rows: Array<{ id: string; title: string; description?: string }>;
        }>) ?? [])
      : [];
  const header = (interactive?.header as { text?: string } | undefined)?.text;
  const footer = (interactive?.footer as { text?: string } | undefined)?.text;
  const media = ['image', 'video', 'audio', 'document', 'sticker'].includes(message.type);

  return (
    <div className={clsx('flex', outbound ? 'justify-end' : 'justify-start')}>
      <div className="max-w-[75%]">
        <div
          className={clsx(
            'rounded-xl px-3 py-2 text-[13px] shadow-sm',
            outbound
              ? 'rounded-tr-sm bg-[#d9fdd3] text-[#111b21] dark:bg-[#005c4b] dark:text-[#e9edef]'
              : 'rounded-tl-sm bg-panel',
          )}
          data-testid={outbound ? 'bubble-out' : 'bubble-in'}
        >
          {header && <div className="mb-0.5 font-semibold">{header}</div>}
          {media && (
            <div className="mb-1 flex items-center gap-1.5 text-xs opacity-80">
              <FileText size={13} /> {message.type}
            </div>
          )}
          {message.type === 'location' && <MapPin size={13} className="mb-1 inline opacity-80" />}
          {message.type === 'template' ? (
            <span>
              <span className="text-xs opacity-70">Template </span>
              <b>{String((payload.template as IDataObject | undefined)?.name ?? '')}</b>
            </span>
          ) : (
            <span className="whitespace-pre-wrap">{message.text ?? `(${message.type})`}</span>
          )}
          {footer && <div className="mt-1 text-[11px] opacity-60">{footer}</div>}
          <div
            className="mt-0.5 flex items-center justify-end gap-1 text-[10.5px] opacity-60"
            title={formatDateTime(message.timestamp)}
          >
            {time(message.timestamp)}
            {outbound && <Ticks status={message.status} />}
          </div>
          {message.status === 'failed' && (
            <div className="mt-1 text-[11.5px] text-danger">
              {String((message.error as { message?: string } | null)?.message ?? 'Not delivered')}
            </div>
          )}
        </div>
        {buttons.length > 0 && (
          <div className="mt-1 grid gap-1">
            {buttons.map((b) => (
              <button
                key={b.id}
                disabled={!simulator}
                onClick={() => onReply({ id: b.id, title: b.title, type: 'button' })}
                className="rounded-lg bg-panel py-1.5 text-[13px] font-medium text-sky-600 shadow-sm enabled:hover:bg-panel-2 disabled:cursor-default dark:text-sky-400"
              >
                {b.title}
              </button>
            ))}
          </div>
        )}
        {sections.length > 0 && (
          <div className="mt-1">
            <button
              onClick={() => setListOpen(!listOpen)}
              className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-panel py-1.5 text-[13px] font-medium text-sky-600 shadow-sm hover:bg-panel-2 dark:text-sky-400"
            >
              <List size={14} /> {String((interactive!.action as IDataObject).button ?? 'Choose')}
            </button>
            {listOpen && (
              <div className="mt-1 overflow-hidden rounded-lg bg-panel shadow-sm">
                {sections.map((section, i) => (
                  <div key={i}>
                    {section.title && (
                      <div className="bg-panel-2 px-3 py-1 text-[11px] font-semibold text-muted uppercase">
                        {section.title}
                      </div>
                    )}
                    {section.rows.map((row) => (
                      <button
                        key={row.id}
                        disabled={!simulator}
                        onClick={() => {
                          setListOpen(false);
                          onReply({ id: row.id, title: row.title, type: 'list' });
                        }}
                        className="block w-full border-b border-line/60 px-3 py-1.5 text-left enabled:hover:bg-panel-2"
                      >
                        <div className="text-[13px]">{row.title}</div>
                        {row.description && (
                          <div className="text-[11.5px] text-muted">{row.description}</div>
                        )}
                      </button>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
