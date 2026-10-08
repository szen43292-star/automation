import {
  autocompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from '@codemirror/autocomplete';
import {
  EditorView,
  Decoration,
  MatchDecorator,
  ViewPlugin,
  placeholder as cmPlaceholder,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';
import CodeMirror from '@uiw/react-codemirror';
import { memo, useMemo, useRef } from 'react';
import { getPath, isObject } from '@flowforge/workflow';
import { useTheme } from '../../lib/theme';
import { useNdv, type NdvContextValue } from './context';

const LUXON_METHODS: Array<[string, string]> = [
  ["toFormat('yyyy-MM-dd')", 'Format with Luxon tokens'],
  ['toISO()', 'ISO 8601 string'],
  ['toISODate()', 'Date only, e.g. 2025-01-31'],
  ['toMillis()', 'Unix time in ms'],
  ['toSeconds()', 'Unix time in seconds'],
  ['plus({ days: 1 })', 'Add a duration'],
  ['minus({ hours: 2 })', 'Subtract a duration'],
  ["startOf('day')", 'Start of day/week/month…'],
  ["endOf('day')", 'End of day/week/month…'],
  ["setZone('Asia/Kolkata')", 'Change timezone'],
  ["diff(DateTime.now(), 'days').days", 'Difference'],
  ['weekday', '1 = Monday … 7 = Sunday'],
  ['hour', 'Hour 0-23'],
  ['day', 'Day of month'],
  ['month', 'Month 1-12'],
  ['year', 'Year'],
  ['weekdayLong', 'e.g. Monday'],
];

const GLOBALS: Array<[string, string]> = [
  ['$json', 'Current item data'],
  ['$binary', 'Current item binary data'],
  ['$input', 'Input items: .item, .first(), .last(), .all()'],
  ["$('", 'Data of another node'],
  ['$now', 'Current date and time (Luxon)'],
  ['$today', 'Today at midnight (Luxon)'],
  ['$vars', 'Instance variables'],
  ['$workflow', 'Workflow id, name, active'],
  ['$execution', 'Execution id, mode, resumeUrl'],
  ['$itemIndex', 'Index of the current item'],
  ['$runIndex', 'How often this node has run'],
  ['$if(', '$if(condition, valueIfTrue, valueIfFalse)'],
  ['$ifEmpty(', '$ifEmpty(value, fallback)'],
  ['DateTime', 'Luxon DateTime'],
];

function typeLabel(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `array[${value.length}]`;
  return typeof value;
}

function keyCompletions(value: unknown): Completion[] {
  if (Array.isArray(value)) {
    return value
      .slice(0, 5)
      .map((v, i) => ({
        label: `[${i}]`,
        detail: typeLabel(v),
        type: 'property',
        apply: undefined,
      }));
  }
  if (!isObject(value)) return [];
  return Object.entries(value).map(([key, v]) => ({
    label: /^[A-Za-z_$][\w$]*$/.test(key) ? key : `["${key}"]`,
    detail: typeLabel(v),
    info: typeof v === 'object' ? undefined : String(v).slice(0, 80),
    type: 'property',
  }));
}

/** Autocomplete inside {{ … }} blocks. */
function expressionCompletions(getCtx: () => NdvContextValue) {
  return (context: CompletionContext): CompletionResult | null => {
    const before = context.state.sliceDoc(0, context.pos);
    if (before.lastIndexOf('{{') <= before.lastIndexOf('}}')) return null;
    const ctx = getCtx();
    const firstItem = ctx.inputItems[0]?.json ?? {};

    // $('Name  /  $node["Name
    const nodeName = context.matchBefore(/(\$\(\s*|\$node\[\s*)(['"])([^'"]*)$/);
    if (nodeName) {
      const quote = /(['"])[^'"]*$/.exec(nodeName.text)![1]!;
      const close = nodeName.text.startsWith('$(') ? `${quote})` : `${quote}]`;
      const from = nodeName.to - /[^'"]*$/.exec(nodeName.text)![0].length;
      return {
        from,
        options: ctx.nodeNames.map((name) => ({
          label: name,
          apply: `${name}${close}`,
          type: 'variable',
        })),
      };
    }

    // Property access: <base>.<path>.<partial>
    const access = context.matchBefore(
      /(\$json|\$binary|\$vars|\$workflow|\$execution|\$now|\$today|\$input|\$input\.(?:item|first\(\)|last\(\))(?:\.json)?|\$\(\s*['"][^'"]+['"]\s*\)(?:\.(?:item|first\(\)|last\(\))(?:\.json)?)?)((?:\.[\w$]+|\[\d+\])*)\.([\w$]*)$/,
    );
    if (access) {
      const match = /^(.*?)((?:\.[\w$]+|\[\d+\])*)\.([\w$]*)$/.exec(access.text)!;
      const [, base, path, partial] = match as unknown as [string, string, string, string];
      const from = context.pos - partial.length;
      const nodeRef = /^\$\(\s*['"]([^'"]+)['"]\s*\)(.*)$/.exec(base);
      let target: unknown;
      if (base === '$json') target = firstItem;
      else if (base === '$vars') target = ctx.vars;
      else if (base === '$workflow')
        target = { id: ctx.workflowId ?? '', name: ctx.workflowName, active: false };
      else if (base === '$execution') target = { id: '', mode: 'manual', resumeUrl: '' };
      else if (base === '$now' || base === '$today') {
        if (path) return null;
        return {
          from,
          options: LUXON_METHODS.map(([label, info]) => ({ label, info, type: 'method' })),
        };
      } else if (base === '$input') {
        return {
          from,
          options: [
            { label: 'item', info: 'The current item', type: 'property' },
            { label: 'first()', info: 'First input item', type: 'method' },
            { label: 'last()', info: 'Last input item', type: 'method' },
            { label: 'all()', info: 'All input items', type: 'method' },
          ],
        };
      } else if (base.startsWith('$input.')) {
        target = base.endsWith('.json') ? firstItem : { json: firstItem };
      } else if (nodeRef) {
        const items = ctx.getNodeOutput(nodeRef[1]!) ?? [];
        const rest = nodeRef[2]!;
        if (!rest) {
          return {
            from,
            options: [
              { label: 'item', info: 'The item linked to the current item', type: 'property' },
              { label: 'first()', type: 'method' },
              { label: 'last()', type: 'method' },
              { label: 'all()', type: 'method' },
              { label: 'itemMatching(0)', type: 'method' },
              { label: 'isExecuted', type: 'property' },
            ],
          };
        }
        target = rest.endsWith('.json') ? (items[0]?.json ?? {}) : { json: items[0]?.json ?? {} };
      }
      if (target === undefined) return null;
      const value = path ? getPath(target, path.replace(/^\./, '')) : target;
      const options = keyCompletions(value);
      return options.length ? { from, options } : null;
    }

    // Globals
    const word = context.matchBefore(/\$?[\w$]*$/);
    if (!word || (word.from === word.to && !context.explicit)) return null;
    return {
      from: word.from,
      options: GLOBALS.map(([label, info]) => ({
        label,
        info,
        type: label.startsWith('$') ? 'variable' : 'class',
      })),
    };
  };
}

const braceMatcher = new MatchDecorator({
  regexp: /\{\{[\s\S]*?\}\}/g,
  decoration: Decoration.mark({ class: 'ff-expr-block' }),
});
const highlightBlocks = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = braceMatcher.createDeco(view);
    }
    update(update: ViewUpdate) {
      this.decorations = braceMatcher.updateDeco(update, this.decorations);
    }
  },
  { decorations: (v) => v.decorations },
);

function ExpressionEditorComponent({
  value,
  onChange,
  placeholder,
}: {
  /** Expression body without the leading "=". */
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  const ctx = useNdv();
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;
  const dark = useTheme((s) => s.dark);
  const extensions = useMemo(
    () => [
      EditorView.lineWrapping,
      highlightBlocks,
      autocompletion({
        override: [expressionCompletions(() => ctxRef.current)],
        activateOnTyping: true,
        icons: false,
      }),
      ...(placeholder ? [cmPlaceholder(placeholder)] : []),
      EditorView.theme({
        '&': { fontSize: '12.5px' },
        '.cm-content': { fontFamily: 'var(--font-mono)', padding: '5px 0' },
        '.ff-expr-block': {
          color: 'var(--ff-success)',
          backgroundColor: 'color-mix(in srgb, var(--ff-success) 10%, transparent)',
          borderRadius: '3px',
        },
      }),
    ],
    [placeholder],
  );
  return (
    <div className="ff-expression-editor" onKeyDown={(e) => e.stopPropagation()}>
      <CodeMirror
        value={value}
        onChange={onChange}
        extensions={extensions}
        theme={dark ? 'dark' : 'light'}
        basicSetup={{
          lineNumbers: false,
          foldGutter: false,
          highlightActiveLine: false,
          autocompletion: false,
          bracketMatching: true,
          closeBrackets: true,
        }}
        minHeight="30px"
        maxHeight="240px"
      />
    </div>
  );
}

export const ExpressionEditor = memo(ExpressionEditorComponent);
