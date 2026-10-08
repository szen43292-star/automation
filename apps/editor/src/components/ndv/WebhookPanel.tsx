import { clsx } from 'clsx';
import { Copy, Radio, Square } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import type { INode, INodeTypeDescription } from '@flowforge/workflow';
import { endpoints, getServerUrl } from '../../lib/api';
import { push } from '../../lib/push';
import { useEditor } from '../../stores/editor';
import { useServer } from '../../stores/server';
import { useCanvasActions } from '../canvas/actions';
import { Button } from '../ui';

/** Test / production URLs of a webhook node and "Listen for test event". */
export function WebhookPanel({
  node,
  description,
}: {
  node: INode;
  description: INodeTypeDescription;
}) {
  const spec = description.webhook!;
  const settings = useServer((s) => s.settings);
  const workflowId = useEditor((s) => s.workflowId);
  const active = useEditor((s) => s.active);
  const actions = useCanvasActions();
  const [tab, setTab] = useState<'test' | 'production'>('test');
  const [listening, setListening] = useState<{ until: number } | null>(null);
  const [, tick] = useState(0);

  useEffect(
    () =>
      void useServer
        .getState()
        .load()
        .catch(() => undefined),
    [],
  );

  const base = (settings?.publicUrl ?? (getServerUrl() || window.location.origin)).replace(
    /\/+$/,
    '',
  );
  const path = String(node.parameters[spec.pathParameter] ?? '').replace(/^\/+|\/+$/g, '');
  const method = String(
    (spec.methodParameter ? node.parameters[spec.methodParameter] : spec.method) ?? 'POST',
  );
  const url = `${base}/${tab === 'test' ? 'webhook-test' : 'webhook'}/${path}`;

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
        toast.success('Test event received');
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
      setTab('test');
      setListening({ until: Date.now() + expiresInSeconds * 1000 });
    } catch (error) {
      toast.error((error as Error).message);
    }
  };

  const stop = async () => {
    setListening(null);
    if (workflowId) await endpoints.stopListening(workflowId).catch(() => undefined);
  };

  return (
    <div className="space-y-3 rounded-lg border border-line bg-panel-2/50 p-3">
      <div className="flex items-center gap-2">
        <span className="text-[12.5px] font-semibold">Webhook URLs</span>
        <div className="ml-auto flex rounded-md border border-line p-0.5 text-xs">
          {(['test', 'production'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={clsx(
                'rounded px-2 py-0.5 capitalize',
                tab === t ? 'bg-panel font-medium shadow-sm' : 'text-muted',
              )}
            >
              {t} URL
            </button>
          ))}
        </div>
      </div>
      <div className="flex items-center gap-2 rounded-md border border-line bg-panel px-2 py-1.5">
        <span className="rounded bg-accent-soft px-1.5 py-0.5 font-mono text-[10.5px] font-semibold text-accent">
          {method}
        </span>
        <code className="min-w-0 flex-1 truncate text-[12px]" data-testid="webhook-url">
          {path ? url : 'Set a path below'}
        </code>
        <button
          title="Copy URL"
          className="text-muted hover:text-fg"
          onClick={() => {
            void navigator.clipboard.writeText(url);
            toast.success('URL copied');
          }}
        >
          <Copy size={14} />
        </button>
      </div>
      {tab === 'production' ? (
        <p className="text-xs text-muted">
          {active
            ? 'The workflow is active: calls to this URL start production executions (see the Executions tab).'
            : 'Activate the workflow to make this URL live.'}
        </p>
      ) : listening ? (
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-2 text-[12.5px] text-accent">
            <Radio size={15} className="animate-pulse" /> Waiting for a request… (
            {Math.max(0, Math.ceil((listening.until - Date.now()) / 1000))}s)
          </span>
          <Button size="sm" variant="ghost" icon={Square} onClick={() => void stop()}>
            Stop listening
          </Button>
        </div>
      ) : (
        <div className="flex items-center gap-3">
          <Button
            size="sm"
            variant="primary"
            icon={Radio}
            onClick={() => void listen()}
            disabled={!path}
          >
            Listen for test event
          </Button>
          <span className="text-xs text-muted">
            Then call the test URL once (within 2 minutes).
          </span>
        </div>
      )}
    </div>
  );
}
