import { clsx } from 'clsx';
import { Braces, FileBox, GripVertical, Table2, TreePine } from 'lucide-react';
import { useMemo, useState, type DragEvent, type ReactNode } from 'react';
import type { INodeExecutionData } from '@flowforge/workflow';
import { DRAG_MIME, toJsonPath } from './context';

type View = 'table' | 'json' | 'schema';
const MAX_ROWS = 200;

function startDrag(e: DragEvent, path: string) {
  e.dataTransfer.setData(DRAG_MIME, path);
  e.dataTransfer.setData('text/plain', `{{ ${path} }}`);
  e.dataTransfer.effectAllowed = 'copy';
}

function typeLabel(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function Primitive({ value }: { value: unknown }) {
  if (value === null || value === undefined)
    return <span className="text-muted italic">{String(value)}</span>;
  if (typeof value === 'string')
    return (
      <span className="text-[var(--ff-success)]">
        {value === '' ? <i className="text-muted">empty</i> : value}
      </span>
    );
  if (typeof value === 'number') return <span className="text-info">{value}</span>;
  if (typeof value === 'boolean') return <span className="text-warning">{String(value)}</span>;
  return <span className="font-mono text-[11.5px] text-muted">{JSON.stringify(value)}</span>;
}

function TableView({ items, draggable }: { items: INodeExecutionData[]; draggable: boolean }) {
  const columns = useMemo(() => {
    const set = new Set<string>();
    items.slice(0, 50).forEach((i) => Object.keys(i.json).forEach((k) => set.add(k)));
    return [...set];
  }, [items]);
  if (columns.length === 0) {
    return <div className="p-4 text-[13px] text-muted">{items.length} item(s) without fields</div>;
  }
  return (
    <table className="w-full border-collapse text-[12.5px]">
      <thead className="sticky top-0 z-[1] bg-panel-2">
        <tr>
          <th className="w-8 border-b border-line px-2 py-1.5 text-left text-[11px] font-medium text-muted">
            #
          </th>
          {columns.map((col) => (
            <th
              key={col}
              draggable={draggable}
              onDragStart={(e) => startDrag(e, toJsonPath([col]))}
              className={clsx(
                'border-b border-l border-line px-2 py-1.5 text-left font-semibold whitespace-nowrap',
                draggable && 'cursor-grab hover:text-accent',
              )}
              title={draggable ? 'Drag into a parameter to use this field' : undefined}
            >
              {col}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {items.slice(0, MAX_ROWS).map((item, i) => (
          <tr key={i} className="align-top hover:bg-panel-2/60">
            <td className="border-b border-line px-2 py-1.5 text-[11px] text-muted">{i}</td>
            {columns.map((col) => (
              <td
                key={col}
                className="max-w-[260px] border-b border-l border-line px-2 py-1.5 break-words"
              >
                <Primitive value={item.json[col]} />
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function JsonView({ items }: { items: INodeExecutionData[] }) {
  const text = useMemo(
    () =>
      JSON.stringify(
        items.slice(0, MAX_ROWS).map((i) => i.json),
        null,
        2,
      ),
    [items],
  );
  return (
    <pre className="p-3 font-mono text-[12px] leading-relaxed whitespace-pre-wrap break-all">
      {text}
    </pre>
  );
}

function SchemaNode({
  name,
  value,
  path,
  draggable,
  depth,
}: {
  name: string | number;
  value: unknown;
  path: Array<string | number>;
  draggable: boolean;
  depth: number;
}) {
  const [open, setOpen] = useState(depth < 2);
  const isObject = value !== null && typeof value === 'object';
  const children: Array<[string | number, unknown]> = isObject
    ? Array.isArray(value)
      ? value.slice(0, 1).map((v, i) => [i, v])
      : Object.entries(value as Record<string, unknown>)
    : [];
  return (
    <div style={{ paddingLeft: depth ? 14 : 0 }}>
      <div
        draggable={draggable}
        onDragStart={(e) => startDrag(e, toJsonPath(path))}
        onClick={() => isObject && setOpen((o) => !o)}
        className={clsx(
          'group my-0.5 flex items-center gap-1.5 rounded px-1.5 py-1 text-[12.5px]',
          draggable && 'cursor-grab hover:bg-accent-soft',
        )}
      >
        {draggable && (
          <GripVertical size={12} className="text-muted opacity-0 group-hover:opacity-100" />
        )}
        <span className="rounded bg-panel-2 px-1.5 py-px font-mono text-[10.5px] text-muted">
          {typeLabel(value)}
        </span>
        <span className="font-medium">{name}</span>
        {!isObject && (
          <span className="truncate text-muted">
            <Primitive value={value} />
          </span>
        )}
      </div>
      {isObject &&
        open &&
        children.map(([k, v]) => (
          <SchemaNode
            key={String(k)}
            name={k}
            value={v}
            path={[...path, k]}
            draggable={draggable}
            depth={depth + 1}
          />
        ))}
    </div>
  );
}

function SchemaView({ items, draggable }: { items: INodeExecutionData[]; draggable: boolean }) {
  // Merge keys of the first items so optional fields show up too.
  const merged = useMemo(() => {
    const out: Record<string, unknown> = {};
    for (const item of items.slice(0, 20)) {
      for (const [k, v] of Object.entries(item.json)) if (!(k in out)) out[k] = v;
    }
    return out;
  }, [items]);
  return (
    <div className="p-2">
      {Object.entries(merged).map(([k, v]) => (
        <SchemaNode key={k} name={k} value={v} path={[k]} draggable={draggable} depth={0} />
      ))}
    </div>
  );
}

function BinaryList({ items }: { items: INodeExecutionData[] }) {
  const withBinary = items.map((item, i) => ({ i, binary: item.binary })).filter((x) => x.binary);
  if (!withBinary.length) return null;
  return (
    <div className="space-y-2 border-t border-line p-3">
      {withBinary.slice(0, 20).map(({ i, binary }) =>
        Object.entries(binary!).map(([key, file]) => (
          <div
            key={`${i}-${key}`}
            className="flex items-center gap-3 rounded-md border border-line p-2 text-[12.5px]"
          >
            <FileBox size={18} className="text-muted" />
            <div className="min-w-0 flex-1">
              <div className="font-medium">
                {file.fileName ?? key}{' '}
                <span className="text-muted">
                  (item {i}, {key})
                </span>
              </div>
              <div className="text-muted">
                {file.mimeType} ·{' '}
                {file.fileSize ? `${(file.fileSize / 1024).toFixed(1)} KB` : 'unknown size'}
              </div>
            </div>
            {file.data && (
              <a
                className="text-accent hover:underline"
                href={`data:${file.mimeType};base64,${file.data}`}
                download={file.fileName ?? key}
              >
                Download
              </a>
            )}
          </div>
        )),
      )}
    </div>
  );
}

export function DataPanel({
  items,
  draggable = false,
  empty,
  header,
  defaultView = 'table',
}: {
  items: INodeExecutionData[] | null;
  draggable?: boolean;
  empty: ReactNode;
  header?: ReactNode;
  defaultView?: View;
}) {
  const [view, setView] = useState<View>(defaultView);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <div className="min-w-0 flex-1">{header}</div>
        {items && (
          <span className="text-xs whitespace-nowrap text-muted">
            {items.length} item{items.length === 1 ? '' : 's'}
          </span>
        )}
        <div className="flex rounded-md border border-line p-0.5">
          {(
            [
              ['schema', TreePine, 'Schema'],
              ['table', Table2, 'Table'],
              ['json', Braces, 'JSON'],
            ] as const
          ).map(([key, Icon, label]) => (
            <button
              key={key}
              title={label}
              onClick={() => setView(key)}
              className={clsx(
                'rounded px-1.5 py-0.5',
                view === key ? 'bg-panel-2 text-fg' : 'text-muted hover:text-fg',
              )}
            >
              <Icon size={14} />
            </button>
          ))}
        </div>
      </div>
      <div className="ff-scroll min-h-0 flex-1 overflow-auto">
        {!items ? (
          empty
        ) : items.length === 0 ? (
          <div className="p-6 text-center text-[13px] text-muted">No items</div>
        ) : (
          <>
            {view === 'table' && <TableView items={items} draggable={draggable} />}
            {view === 'json' && <JsonView items={items} />}
            {view === 'schema' && <SchemaView items={items} draggable={draggable} />}
            {items.length > MAX_ROWS && view !== 'schema' && (
              <div className="p-3 text-center text-xs text-muted">
                Showing the first {MAX_ROWS} of {items.length} items
              </div>
            )}
            <BinaryList items={items} />
          </>
        )}
      </div>
    </div>
  );
}
