import { clsx } from 'clsx';
import { RotateCcw, Send, Wrench } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { endpoints, type AgentChatMessage } from '../../lib/api';
import { Spinner } from '../ui';

interface Line extends AgentChatMessage {
  actions?: Array<{ tool: string; input: unknown; output: string }>;
  error?: boolean;
}

/** Chat with the agent in text, as if you were calling it. */
export function TestChat({
  agentId,
  greeting,
  dirty,
}: {
  agentId: string;
  greeting: string;
  dirty: boolean;
}) {
  const [lines, setLines] = useState<Line[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [model, setModel] = useState('');
  const bottom = useRef<HTMLDivElement>(null);

  // No implicit return: newer browsers return a Promise from scrollIntoView, which React would
  // treat as the effect's cleanup.
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [lines, busy]);

  const send = async () => {
    const message = text.trim();
    if (!message || busy) return;
    const history: Line[] = [...lines, { role: 'caller', text: message }];
    setLines(history);
    setText('');
    setBusy(true);
    try {
      const result = await endpoints.agentChat(
        agentId,
        history.filter((l) => !l.error).map(({ role, text }) => ({ role, text })),
      );
      setModel(result.model);
      setLines([...history, { role: 'agent', text: result.reply || '…', actions: result.actions }]);
    } catch (error) {
      setLines([...history, { role: 'agent', text: (error as Error).message, error: true }]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full min-h-[420px] flex-col rounded-xl border border-line bg-panel">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <div className="text-[13px] font-medium">Test chat</div>
        {model && <span className="truncate text-[11px] text-muted">{model}</span>}
        <button
          className="ml-auto text-muted hover:text-fg"
          title="Start over"
          onClick={() => setLines([])}
        >
          <RotateCcw size={14} />
        </button>
      </div>
      <div className="ff-scroll flex-1 space-y-2 overflow-y-auto p-3" data-testid="test-chat">
        <div className="max-w-[85%] rounded-xl rounded-tl-sm bg-panel-2 px-3 py-2 text-[13px]">
          {greeting}
        </div>
        {lines.map((line, i) => (
          <div
            key={i}
            className={clsx('flex flex-col', line.role === 'caller' ? 'items-end' : 'items-start')}
          >
            {line.actions?.map((a, j) => (
              <div
                key={j}
                className="mb-1 flex max-w-[85%] items-start gap-1.5 rounded-md border border-dashed border-line px-2 py-1 text-[11px] text-muted"
                title={a.output}
              >
                <Wrench size={11} className="mt-0.5 shrink-0" />
                <span className="truncate">
                  {a.tool}({JSON.stringify(a.input)}) → {a.output}
                </span>
              </div>
            ))}
            <div
              className={clsx(
                'max-w-[85%] rounded-xl px-3 py-2 text-[13px] whitespace-pre-wrap',
                line.role === 'caller'
                  ? 'rounded-tr-sm bg-accent text-white'
                  : line.error
                    ? 'rounded-tl-sm bg-danger-soft text-danger'
                    : 'rounded-tl-sm bg-panel-2',
              )}
              data-testid={line.role === 'agent' ? 'agent-reply' : undefined}
            >
              {line.text}
            </div>
          </div>
        ))}
        {busy && (
          <div className="flex items-center gap-2 text-xs text-muted">
            <Spinner size={12} /> thinking…
          </div>
        )}
        <div ref={bottom} />
      </div>
      {dirty && (
        <div className="border-t border-line px-3 py-1.5 text-[11px] text-warning">
          Save your changes - the chat uses the saved agent.
        </div>
      )}
      <form
        className="flex gap-2 border-t border-line p-2"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <input
          className="ff-input"
          placeholder="Say something as a caller…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          aria-label="Message"
        />
        <button
          className="grid size-8.5 shrink-0 place-items-center rounded-md bg-accent text-white disabled:opacity-50"
          disabled={!text.trim() || busy}
          aria-label="Send"
        >
          <Send size={15} />
        </button>
      </form>
    </div>
  );
}
