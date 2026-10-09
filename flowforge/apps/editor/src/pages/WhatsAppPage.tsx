import { useQuery, useQueryClient } from '@tanstack/react-query';
import { MessageCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { endpoints } from '../lib/api';
import { push } from '../lib/push';
import { useAuth } from '../stores/auth';
import { ChatPanel } from '../components/whatsapp/Chat';
import { AccountCard, ConnectOptions } from '../components/whatsapp/Numbers';
import { PlatformSetup, SetupChecklist } from '../components/whatsapp/Setup';
import { Spinner } from '../components/ui';

export function WhatsAppPage() {
  const queryClient = useQueryClient();
  const isOwner = useAuth((s) => s.user?.role === 'owner');
  const platform = useQuery({
    queryKey: ['whatsapp', 'platform'],
    queryFn: endpoints.whatsappPlatform,
  });
  const checklist = useQuery({
    queryKey: ['whatsapp', 'checklist'],
    queryFn: endpoints.whatsappChecklist,
  });
  const accounts = useQuery({
    queryKey: ['whatsapp', 'accounts'],
    queryFn: endpoints.whatsappAccounts,
  });
  const [selected, setSelected] = useState<string | null>(null);
  const list = accounts.data?.data ?? [];
  const account = list.find((a) => a.id === selected) ?? list[0];

  // Live updates: new messages, receipts and connected numbers.
  useEffect(() => {
    const unsubscribe = push.subscribe('whatsapp');
    const off = push.on((message) => {
      if (message.type === 'whatsappMessage') {
        void queryClient.invalidateQueries({
          queryKey: ['whatsapp', 'messages', message.data.accountId],
        });
        void queryClient.invalidateQueries({
          queryKey: ['whatsapp', 'conversations', message.data.accountId],
        });
        void queryClient.invalidateQueries({ queryKey: ['whatsapp', 'checklist'] });
      } else if (message.type === 'whatsappAccountUpdated') {
        void queryClient.invalidateQueries({ queryKey: ['whatsapp'] });
      }
    });
    return () => {
      off();
      unsubscribe();
    };
  }, [queryClient]);

  if (platform.isLoading || accounts.isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }

  return (
    <div className="ff-scroll h-full overflow-y-auto">
      <div className="mx-auto max-w-6xl space-y-5 px-4 py-8 sm:px-8">
        <div className="flex items-center gap-3">
          <div className="grid size-10 place-items-center rounded-xl bg-[#25D366]/15 text-[#1da851]">
            <MessageCircle size={20} />
          </div>
          <div>
            <h1 className="text-xl font-semibold">WhatsApp</h1>
            <p className="text-[13px] text-muted">
              Connect your WhatsApp Business number and let workflows answer customers - no API keys
              to paste.
            </p>
          </div>
        </div>

        {checklist.data && <SetupChecklist steps={checklist.data.steps} />}
        {isOwner && platform.data && <PlatformSetup platform={platform.data} />}

        <section className="space-y-3" aria-labelledby="numbers-title">
          <h2 id="numbers-title" className="font-semibold">
            Numbers
          </h2>
          {list.map((a) => (
            <AccountCard
              key={a.id}
              account={a}
              selected={a.id === account?.id}
              onSelect={() => setSelected(a.id)}
            />
          ))}
          {platform.data && (
            <ConnectOptions platform={platform.data} onConnected={(a) => setSelected(a.id)} />
          )}
        </section>

        {account && <ChatPanel account={account} />}
      </div>
    </div>
  );
}
