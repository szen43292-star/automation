import { useReactFlow } from '@xyflow/react';
import { clsx } from 'clsx';
import { Search, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { INodeTypeDescription, NodeGroup } from '@flowforge/workflow';
import { useEditor } from '../../stores/editor';
import { isTrigger, useNodeTypes } from '../../stores/nodeTypes';
import { IconButton, NodeIcon } from '../ui';

const GROUP_LABELS: Array<[NodeGroup, string]> = [
  ['trigger', 'Triggers'],
  ['whatsapp', 'WhatsApp'],
  ['ai', 'AI'],
  ['core', 'Core'],
  ['flow', 'Flow'],
  ['transform', 'Data transformation'],
  ['data', 'Data'],
  ['apps', 'Apps'],
  ['utility', 'Utility'],
  ['annotation', 'Canvas'],
];

/**
 * How well a node matches the search: every word must appear in its name, keywords or
 * description ("send whatsapp", "http req"); matches in the name count most.
 */
export function score(d: INodeTypeDescription, query: string): number {
  const full = query.trim().toLowerCase();
  const words = full.split(/\s+/).filter(Boolean);
  if (!words.length) return 0;
  const name = d.displayName.toLowerCase();
  const nameWords = name.split(/[\s()/-]+/);
  const keywords = (d.keywords ?? []).map((k) => k.toLowerCase());
  const description = d.description.toLowerCase();
  if (name === full) return 1000;
  let total = name.startsWith(full) ? 500 : 0;
  for (const word of words) {
    if (nameWords.some((part) => part.startsWith(word))) total += 60;
    else if (name.includes(word)) total += 40;
    else if (keywords.some((k) => k.includes(word))) total += 30;
    else if (description.includes(word)) total += 10;
    else return 0;
  }
  return total;
}

export function NodeCreator() {
  const creator = useEditor((s) => s.creator);
  const nodes = useEditor((s) => s.nodes);
  const list = useNodeTypes((s) => s.list);
  const flow = useReactFlow();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const hasTrigger = nodes.some((n) => isTrigger(useNodeTypes.getState().byName[n.type]));
  const connecting = Boolean(creator.source || creator.insertInto);

  useEffect(() => {
    if (creator.open) {
      setQuery('');
      setActive(0);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [creator.open]);

  const available = useMemo(
    () =>
      list.filter((d) => {
        if (connecting && d.inputs.length === 0) return false;
        if (d.maxNodes && nodes.filter((n) => n.type === d.name).length >= d.maxNodes) return false;
        return true;
      }),
    [list, nodes, connecting],
  );

  const sections = useMemo(() => {
    if (query.trim()) {
      const results = available
        .map((d) => ({ d, s: score(d, query.trim()) }))
        .filter((r) => r.s > 0)
        .sort((a, b) => b.s - a.s || a.d.displayName.localeCompare(b.d.displayName))
        .map((r) => r.d);
      return [{ label: 'Results', items: results }];
    }
    const seen = new Set<string>();
    const ordered =
      hasTrigger || connecting
        ? GROUP_LABELS.filter(([g]) => g !== 'trigger').concat([GROUP_LABELS[0]!])
        : GROUP_LABELS;
    return ordered
      .map(([group, label]) => ({
        label,
        items: available.filter((d) => {
          const primary = d.group.includes('trigger') ? 'trigger' : d.group[0];
          if (primary !== group || seen.has(d.name)) return false;
          seen.add(d.name);
          return true;
        }),
      }))
      .filter((s) => s.items.length > 0);
  }, [available, query, hasTrigger, connecting]);

  const flat = sections.flatMap((s) => s.items);

  const choose = (description: INodeTypeDescription) => {
    const state = useEditor.getState();
    let position = creator.position;
    if (!position && !creator.source && !creator.insertInto) {
      const rect = document.querySelector('.react-flow')?.getBoundingClientRect();
      position = flow.screenToFlowPosition({
        x: (rect?.left ?? 0) + (rect?.width ?? window.innerWidth) / 2,
        y: (rect?.top ?? 0) + (rect?.height ?? window.innerHeight) / 2,
      });
      position = { x: position.x - 48, y: position.y - 48 };
    }
    state.addNode(description.name, {
      position,
      source: creator.source,
      insertInto: creator.insertInto,
    });
  };

  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  if (!creator.open) return null;

  let index = -1;
  return (
    <div className="absolute top-0 right-0 bottom-0 z-30 flex w-[340px] max-w-full flex-col border-l border-line bg-panel shadow-2xl">
      <div className="flex items-center justify-between px-4 pt-4 pb-2">
        <h3 className="font-semibold">
          {hasTrigger || connecting ? 'What happens next?' : 'What triggers this workflow?'}
        </h3>
        <IconButton icon={X} label="Close" onClick={() => useEditor.getState().closeCreator()} />
      </div>
      <div className="px-4 pb-3">
        <div className="relative">
          <Search size={15} className="absolute top-1/2 left-2.5 -translate-y-1/2 text-muted" />
          <input
            ref={inputRef}
            value={query}
            placeholder="Search nodes…"
            className="ff-input pl-8"
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActive((a) => Math.min(flat.length - 1, a + 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActive((a) => Math.max(0, a - 1));
              } else if (e.key === 'Enter' && flat[active]) {
                e.preventDefault();
                choose(flat[active]!);
              } else if (e.key === 'Escape') {
                useEditor.getState().closeCreator();
              }
            }}
          />
        </div>
      </div>
      <div ref={listRef} className="ff-scroll flex-1 overflow-y-auto pb-4">
        {flat.length === 0 && (
          <div className="px-4 py-8 text-center text-[13px] text-muted">
            No nodes match “{query}”
          </div>
        )}
        {sections.map((section) => (
          <div key={section.label}>
            <div className="px-4 pt-3 pb-1 text-[11px] font-semibold tracking-wide text-muted uppercase">
              {section.label}
            </div>
            {section.items.map((d) => {
              index++;
              const i = index;
              return (
                <button
                  key={d.name}
                  data-index={i}
                  // Only real pointer movement changes the highlight (the panel can open under the cursor).
                  onMouseMove={() => active !== i && setActive(i)}
                  onClick={() => choose(d)}
                  className={clsx(
                    'flex w-full items-start gap-3 px-4 py-2 text-left',
                    i === active ? 'bg-panel-2' : 'hover:bg-panel-2',
                  )}
                >
                  <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-line bg-node">
                    <NodeIcon icon={d.icon} color={d.iconColor} size={17} />
                  </div>
                  <div className="min-w-0">
                    <div className="text-[13px] font-medium">{d.displayName}</div>
                    <div className="line-clamp-2 text-xs text-muted">{d.description}</div>
                  </div>
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
