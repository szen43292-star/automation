import { NodeResizer, type Node, type NodeProps } from '@xyflow/react';
import { clsx } from 'clsx';
import { memo, useEffect, useRef, useState } from 'react';
import type { INode } from '@flowforge/workflow';
import { useEditor } from '../../stores/editor';

export type StickyNodeType = Node<{ node: INode }, 'sticky'>;

const COLORS: Record<string, string> = {
  yellow: '#fff5c2',
  blue: '#dbeafe',
  green: '#dcfce7',
  pink: '#fce7f3',
  purple: '#ede9fe',
  gray: '#e5e7eb',
};

/** Tiny, safe markdown renderer (headings, bold, italics, code, lists, links). */
function renderMarkdown(text: string): string {
  const escape = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const inline = (s: string) =>
    escape(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*]+)\*/g, '<em>$1</em>')
      .replace(
        /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
        '<a href="$2" target="_blank" rel="noreferrer noopener" class="underline">$1</a>',
      );
  return text
    .split('\n')
    .map((line) => {
      const h = /^(#{1,3})\s+(.*)$/.exec(line);
      if (h) return `<h${h[1]!.length}>${inline(h[2]!)}</h${h[1]!.length}>`;
      const li = /^[-*]\s+(.*)$/.exec(line);
      if (li) return `<p>• ${inline(li[1]!)}</p>`;
      return line.trim() ? `<p>${inline(line)}</p>` : '<p>&nbsp;</p>';
    })
    .join('');
}

function StickyNodeComponent({ data, selected }: NodeProps<StickyNodeType>) {
  const { node } = data;
  const [editing, setEditing] = useState(false);
  const readOnly = useEditor((s) => s.readOnly);
  const content = String(node.parameters.content ?? '');
  const color = COLORS[String(node.parameters.color ?? 'yellow')] ?? COLORS.yellow;
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editing) ref.current?.focus();
  }, [editing]);

  return (
    <>
      <NodeResizer
        isVisible={selected && !readOnly}
        minWidth={150}
        minHeight={80}
        lineStyle={{ borderColor: 'var(--ff-accent)' }}
        handleStyle={{ width: 8, height: 8, borderRadius: 2, background: 'var(--ff-accent)' }}
        onResizeEnd={(_e, p) =>
          useEditor.getState().updateNode(node.id, {
            width: Math.round(p.width),
            height: Math.round(p.height),
            position: [Math.round(p.x), Math.round(p.y)],
          })
        }
      />
      <div
        className={clsx(
          'ff-node-box h-full w-full overflow-hidden rounded-lg p-3 text-[13px] text-neutral-800 shadow-card',
        )}
        style={{ background: color, width: node.width ?? 260, height: node.height ?? 180 }}
        onDoubleClick={(e) => {
          if (readOnly) return;
          e.stopPropagation();
          setEditing(true);
        }}
      >
        {editing ? (
          <textarea
            ref={ref}
            className="nodrag nowheel h-full w-full resize-none bg-transparent font-mono text-[12px] outline-none"
            defaultValue={content}
            onBlur={(e) => {
              setEditing(false);
              if (e.target.value !== content) {
                useEditor
                  .getState()
                  .setParameters(node.id, { ...node.parameters, content: e.target.value });
              }
            }}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Escape') (e.target as HTMLTextAreaElement).blur();
            }}
          />
        ) : (
          <div
            className="ff-markdown nowheel h-full overflow-auto"
            dangerouslySetInnerHTML={{ __html: renderMarkdown(content) }}
          />
        )}
      </div>
    </>
  );
}

export const StickyNode = memo(StickyNodeComponent);
