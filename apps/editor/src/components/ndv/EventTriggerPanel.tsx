import { useQuery } from '@tanstack/react-query';
import { MessageCircle, Radio, Send, Square } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import type { INode } from '@flowforge/workflow';
import { endpoints } from '../../lib/api';
import { push } from '../../lib/push';
import { useEditor } from '../../stores/editor';
import { useCanvasActions } from '../canvas/actions';
import { Button } from '../ui';

/** "Listen for test event" for event triggers (WhatsApp), with a built-in test customer. */
export function EventTriggerPanel({ node }: { node: INode }) {
  const workflowId = useEditor((s) => s.workflowId);
  const actions = useCanvasActions();
  const [listening, setListening] = useState<{ until: number } | null>(null);
  const [, tick] = useState(0);
  const [text, setText] = useState('Hi! Are you open today?');
  const accounts = useQuery({
    queryKey: ['whatsapp', 'accounts'],
    queryFn: endpoints.whatsappAccounts,
  });

  const chosen = String(node.parameters.account ?? '*');
  const list = accounts.data?.data ?? [];
  // The simulator can only send to a test number; use the trigger's number when it is one.
  const testNumber =
    list.find((a) => a.id === chosen && a.mode === 'simulator') ??
    (chosen === '*' ? list.find((a) => a.mode === 'simulator') : undefined);

  useEffect(() => {
    if (!listening) return;
    const timer = setInterval(() => {
      if (Date.now() > listening.until) setListening(null);
      tick((t) => t + 1);
    }, 1000);
    const off = push.on((message) => {
      if (
        message.type === 'testWebhookReceived' &&
        message.data.workflowId === workflowId &&
        message.data.nodeId === node.id
      ) {
        setListening(null);
        actions.attachExecution(message.data.executionId);
        toast.success('Test message received');
      }
    });
    return () => {
      clearInterval(timer);
      off();
    };
  }, [listening, workflowId, node.id, actions]);

  const listen = async () => {
    let id = useEditor.getState().workflowId;
    if (!id || useEditor.getState().dirty) {
      if (!(await actions.save())) return;
      id = useEditor.getState().workflowId;
    }
    if (!id) return;
    try {
      const s = useEditor.getState();
      const { expiresInSeconds } = await endpoints.listenWebhook(id, {
        nodeId: node.id,
        workflowData: {
          name: s.name,
          nodes: s.nodes,
          connections: s.connections,
          settings: s.settings,
          pinData: s.pinData,
        },
      });
      setListening({ until: Date.now() + expiresInSeconds * 1000 });
    } catch (error) {
      toast.error((error as Error).message);
    }
  };

  const stop = async () => {
    setListening(null);
    if (workflowId) await endpoints.stopListening(workflowId).catch(() => undefined);
  };

  const sendAsCustomer = async () => {
    if (!testNumber || !text.trim()) return;
    try {
      await endpoints.simulateWhatsapp(testNumber.id, {
        from: '+91 98765 43210',
        name: 'Test customer',
        text,
      });
    } catch (error) {
      toast.error((error as Error).message);
    }
  };

  if (accounts.isSuccess && list.length === 0) {
    return (
      <div className="flex items-start gap-2.5 rounded-lg border border-line bg-panel-2/50 p-3 text-[12.5px]">
        <MessageCircle size={16} className="mt-0.5 shrink-0 text-[#25D366]" />
        <div>
          No WhatsApp number yet.{' '}
          <Link to="/whatsapp" className="font-medium text-accent hover:underline">
            Connect one or add a test number
          </Link>{' '}
          - a test number needs no Meta account or keys.
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3 rounded-lg border border-line bg-panel-2/50 p-3">
      {listening ? (
        <>
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-2 text-[12.5px] text-accent">
              <Radio size={15} className="animate-pulse" /> Waiting for a WhatsApp message… (
              {Math.max(0, Math.ceil((listening.until - Date.now()) / 1000))}s)
            </span>
            <Button size="sm" variant="ghost" icon={Square} onClick={() => void stop()}>
              Stop listening
            </Button>
          </div>
          {testNumber ? (
            <div className="space-y-1.5">
              <div className="text-xs text-muted">
                Send as a customer to the test number {testNumber.displayPhoneNumber}:
              </div>
              <div className="flex gap-2">
                <input
                  className="ff-input"
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && void sendAsCustomer()}
                  aria-label="Test message"
                />
                <Button
                  size="sm"
                  variant="primary"
                  icon={Send}
                  onClick={() => void sendAsCustomer()}
                >
                  Send
                </Button>
              </div>
            </div>
          ) : (
            <p className="text-xs text-muted">
              Send a WhatsApp message to your number from your phone.
            </p>
          )}
        </>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <Button size="sm" variant="primary" icon={Radio} onClick={() => void listen()}>
            Listen for test event
          </Button>
          <span className="text-xs text-muted">
            {testNumber
              ? 'Then send a message as a test customer.'
              : 'Then message your WhatsApp number.'}
          </span>
        </div>
      )}
    </div>
  );
}
