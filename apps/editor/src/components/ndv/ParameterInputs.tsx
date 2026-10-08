import { clsx } from 'clsx';
import { Info, Plus, Trash2, X } from 'lucide-react';
import { Suspense, lazy, useState, type DragEvent, type ReactNode } from 'react';
import {
  FILTER_OPERATORS,
  isPropertyVisible,
  isSingleValueOperator,
  randomId,
  type FilterCondition,
  type FilterOperatorType,
  type FilterValue,
  type INodeParameters,
  type INodeProperties,
  type INodePropertyCollection,
  type INodePropertyOption,
  type NodeParameterValueType,
} from '@flowforge/workflow';
import { useQuery } from '@tanstack/react-query';
import { endpoints } from '../../lib/api';
import { Toggle } from '../ui';
// CodeMirror is large - load it only when a code/JSON parameter is shown.
const CodeEditor = lazy(() => import('./CodeEditor').then((m) => ({ default: m.CodeEditor })));
import { DRAG_MIME, useExpressionPreview, useNdv } from './context';
const ExpressionEditor = lazy(() =>
  import('./ExpressionEditor').then((m) => ({ default: m.ExpressionEditor })),
);

type Value = NodeParameterValueType;

const isExpr = (v: unknown): v is string => typeof v === 'string' && v.startsWith('=');

// ---------------------------------------------------------------------------
// Form
// ---------------------------------------------------------------------------

export function ParameterForm({
  properties,
  values,
  onChange,
}: {
  properties: INodeProperties[];
  values: INodeParameters;
  onChange: (values: INodeParameters) => void;
}) {
  return (
    <div className="space-y-4">
      {properties.map((property) => {
        if (!isPropertyVisible(property.displayOptions, values)) return null;
        return (
          <ParameterField
            key={property.name}
            property={property}
            value={values[property.name] as Value}
            onChange={(value) => onChange({ ...values, [property.name]: value })}
          />
        );
      })}
    </div>
  );
}

export function ParameterField({
  property,
  value,
  onChange,
  compact,
}: {
  property: INodeProperties;
  value: Value;
  onChange: (value: Value) => void;
  compact?: boolean;
}) {
  const { readOnly } = useNdv();
  if (property.type === 'notice') {
    return (
      <div className="flex gap-2 rounded-md border border-line bg-panel-2 px-3 py-2 text-[12.5px] text-muted">
        <Info size={15} className="mt-px shrink-0" />
        <span>{property.displayName}</span>
      </div>
    );
  }
  const supportsExpression =
    !property.noDataExpression &&
    ['string', 'number', 'boolean', 'options', 'json', 'dateTime', 'color'].includes(property.type);
  const expression = isExpr(value);

  return (
    <div className={clsx(readOnly && 'pointer-events-none opacity-80')}>
      {!compact && (
        <div className="mb-1 flex items-center gap-1.5">
          <label className="text-[12.5px] font-medium">
            {property.displayName}
            {property.required && <span className="text-danger"> *</span>}
          </label>
          {property.description && (
            <span title={property.description} className="text-muted">
              <Info size={12} />
            </span>
          )}
          {supportsExpression && (
            <div className="ml-auto flex rounded border border-line text-[10.5px]">
              <button
                className={clsx('px-1.5 py-px', !expression ? 'bg-panel-2 text-fg' : 'text-muted')}
                onClick={() => expression && onChange(fromExpression(value, property))}
              >
                Fixed
              </button>
              <button
                className={clsx(
                  'px-1.5 py-px',
                  expression ? 'bg-success-soft text-success' : 'text-muted',
                )}
                onClick={() => !expression && onChange(toExpression(value))}
              >
                Expression
              </button>
            </div>
          )}
        </div>
      )}
      {expression ? (
        <ExpressionInput value={value} onChange={onChange} />
      ) : (
        <ValueInput property={property} value={value} onChange={onChange} />
      )}
      {property.hint && <div className="mt-1 text-[11.5px] text-muted">{property.hint}</div>}
    </div>
  );
}

function toExpression(value: Value): string {
  if (value === undefined || value === null || value === '') return '=';
  if (typeof value === 'object') return `={{ ${JSON.stringify(value)} }}`;
  return `=${String(value)}`;
}

function fromExpression(value: Value, property: INodeProperties): Value {
  const raw = String(value).slice(1);
  if (/\{\{/.test(raw)) return property.default;
  if (property.type === 'number') return Number(raw) || 0;
  if (property.type === 'boolean') return raw === 'true';
  return raw;
}

/** Make an input accept fields dragged from the INPUT panel. */
function useDrop(value: Value, onChange: (v: Value) => void) {
  const [over, setOver] = useState(false);
  return {
    over,
    props: {
      onDragOver: (e: DragEvent) => {
        if (e.dataTransfer.types.includes(DRAG_MIME)) {
          e.preventDefault();
          setOver(true);
        }
      },
      onDragLeave: () => setOver(false),
      onDrop: (e: DragEvent) => {
        const path = e.dataTransfer.getData(DRAG_MIME);
        setOver(false);
        if (!path) return;
        e.preventDefault();
        const mapping = `{{ ${path} }}`;
        if (isExpr(value)) onChange(`${value}${value.length > 1 ? ' ' : ''}${mapping}`);
        else onChange(`=${value ? String(value) : ''}${mapping}`);
      },
    },
  };
}

function ExpressionInput({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: Value) => void;
  placeholder?: string;
}) {
  const ctx = useNdv();
  const preview = useExpressionPreview(value);
  const needsData = ctx.inputItems.length === 0 && /\$(json|input|binary)\b/.test(value);
  return (
    <div className="rounded-md border border-[color-mix(in_srgb,var(--ff-success)_45%,var(--ff-border))]">
      <Suspense fallback={<div className="ff-input is-expression h-8" />}>
        <ExpressionEditor
          value={value.slice(1)}
          onChange={(v) => onChange(`=${v}`)}
          placeholder={placeholder ?? '{{ $json.field }}'}
        />
      </Suspense>
      {preview && (
        <div
          data-testid="expression-preview"
          className={clsx(
            'border-t px-2 py-1 font-mono text-[11.5px] break-all',
            preview.ok && !needsData ? 'border-line bg-panel-2 text-muted' : '',
            needsData && 'border-line bg-panel-2 text-muted',
            !preview.ok && !needsData && 'border-danger/40 bg-danger-soft text-danger',
          )}
        >
          <span className="text-[10px] uppercase opacity-70">Result: </span>
          {needsData
            ? '[execute previous nodes to preview]'
            : preview.ok
              ? formatPreview(preview.value)
              : preview.error}
        </div>
      )}
    </div>
  );
}

function formatPreview(value: unknown): string {
  if (value === undefined) return '[undefined]';
  if (value === null) return '[null]';
  if (value === '') return '[empty]';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

// ---------------------------------------------------------------------------
// Fixed value inputs
// ---------------------------------------------------------------------------

function ValueInput({
  property,
  value,
  onChange,
}: {
  property: INodeProperties;
  value: Value;
  onChange: (v: Value) => void;
}) {
  const drop = useDrop(value, onChange);
  const canDrop = !property.noDataExpression;
  switch (property.type) {
    case 'string':
    case 'dateTime': {
      const rows = property.typeOptions?.rows ?? 1;
      const common = {
        value: value === undefined || value === null ? '' : String(value),
        placeholder: property.placeholder,
        className: clsx('ff-input', drop.over && 'drop-target'),
        ...(canDrop ? drop.props : {}),
      };
      if (property.typeOptions?.editor === 'markdown' || rows > 1) {
        return <textarea {...common} rows={rows} onChange={(e) => onChange(e.target.value)} />;
      }
      return (
        <input
          {...common}
          type={
            property.typeOptions?.password
              ? 'password'
              : property.type === 'dateTime'
                ? 'datetime-local'
                : 'text'
          }
          onChange={(e) => onChange(e.target.value)}
        />
      );
    }
    case 'number':
      return (
        <input
          type="number"
          className={clsx('ff-input', drop.over && 'drop-target')}
          value={
            typeof value === 'number'
              ? value
              : value === undefined || value === null
                ? ''
                : Number(value)
          }
          min={property.typeOptions?.minValue}
          max={property.typeOptions?.maxValue}
          step={
            property.typeOptions?.numberPrecision
              ? 10 ** -property.typeOptions.numberPrecision
              : 'any'
          }
          onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
          {...(canDrop ? drop.props : {})}
        />
      );
    case 'boolean':
      return <Toggle checked={Boolean(value)} onChange={onChange} label={property.displayName} />;
    case 'color':
      return (
        <input
          type="color"
          value={String(value ?? '#000000')}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case 'options': {
      if (property.typeOptions?.loadOptionsMethod) {
        return (
          <RemoteOptionsInput
            method={property.typeOptions.loadOptionsMethod}
            value={value}
            onChange={onChange}
          />
        );
      }
      const options = (property.options ?? []) as INodePropertyOption[];
      const selected = options.find((o) => o.value === value);
      return (
        <div>
          <select
            className="ff-input"
            value={String(value ?? '')}
            onChange={(e) =>
              onChange(
                options.find((o) => String(o.value) === e.target.value)?.value ?? e.target.value,
              )
            }
          >
            {options.map((o) => (
              <option key={String(o.value)} value={String(o.value)}>
                {o.name}
              </option>
            ))}
          </select>
          {selected?.description && (
            <div className="mt-1 text-[11.5px] text-muted">{selected.description}</div>
          )}
        </div>
      );
    }
    case 'multiOptions': {
      const options = (property.options ?? []) as INodePropertyOption[];
      const current = Array.isArray(value) ? (value as Array<string | number | boolean>) : [];
      return (
        <div className="flex flex-wrap gap-1.5">
          {options.map((o) => {
            const on = current.includes(o.value);
            return (
              <button
                key={String(o.value)}
                onClick={() =>
                  onChange(on ? current.filter((v) => v !== o.value) : [...current, o.value])
                }
                className={clsx(
                  'rounded-full border px-2.5 py-0.5 text-xs',
                  on
                    ? 'border-accent bg-accent-soft text-accent'
                    : 'border-line text-muted hover:text-fg',
                )}
              >
                {o.name}
              </button>
            );
          })}
        </div>
      );
    }
    case 'json':
    case 'code':
      return (
        <Suspense fallback={<div className="ff-input h-24 animate-pulse" />}>
          <CodeEditor
            value={typeof value === 'string' ? value : JSON.stringify(value ?? '', null, 2)}
            onChange={onChange}
            language={property.typeOptions?.editor === 'js' ? 'js' : 'json'}
            minRows={property.typeOptions?.rows ?? 5}
          />
        </Suspense>
      );
    case 'collection':
      return (
        <CollectionInput
          property={property}
          value={(value ?? {}) as INodeParameters}
          onChange={onChange}
        />
      );
    case 'fixedCollection':
      return (
        <FixedCollectionInput
          property={property}
          value={(value ?? {}) as INodeParameters}
          onChange={onChange}
        />
      );
    case 'filter':
      return (
        <FilterInput
          value={(value ?? { combinator: 'and', conditions: [] }) as unknown as FilterValue}
          onChange={(v) => onChange(v as unknown as Value)}
        />
      );
    case 'assignmentCollection':
      return (
        <AssignmentInput
          value={(value ?? { assignments: [] }) as unknown as AssignmentValue}
          onChange={(v) => onChange(v as unknown as Value)}
        />
      );
    default:
      return (
        <div className="text-xs text-danger">Unsupported parameter type “{property.type}”</div>
      );
  }
}

/** Options fetched from the server (e.g. the list of workflows). */
function RemoteOptionsInput({
  method,
  value,
  onChange,
}: {
  method: string;
  value: Value;
  onChange: (v: Value) => void;
}) {
  const query = useQuery({
    queryKey: ['node-options', method],
    queryFn: () => endpoints.nodeOptions(method),
  });
  const options = query.data?.data ?? [];
  return (
    <select
      className="ff-input"
      value={String(value ?? '')}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">{query.isLoading ? 'Loading…' : 'Choose…'}</option>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.name}
        </option>
      ))}
      {value && !options.some((o) => o.value === value) && !query.isLoading && (
        <option value={String(value)}>{String(value)} (not found)</option>
      )}
    </select>
  );
}

// ---------------------------------------------------------------------------
// Collections
// ---------------------------------------------------------------------------

function CollectionInput({
  property,
  value,
  onChange,
}: {
  property: INodeProperties;
  value: INodeParameters;
  onChange: (v: Value) => void;
}) {
  const options = (property.options ?? []) as INodeProperties[];
  const present = options.filter((o) => value[o.name] !== undefined);
  const missing = options.filter(
    (o) => value[o.name] === undefined && isPropertyVisible(o.displayOptions, value),
  );
  return (
    <div className="space-y-3 rounded-md border border-line p-3">
      {present.length === 0 && <div className="text-xs text-muted">No options set</div>}
      {present.map((option) => (
        <div key={option.name} className="relative pr-7">
          <ParameterField
            property={option}
            value={value[option.name] as Value}
            onChange={(v) => onChange({ ...value, [option.name]: v })}
          />
          <button
            title="Remove option"
            className="absolute top-0 right-0 text-muted hover:text-danger"
            onClick={() => {
              const { [option.name]: _removed, ...rest } = value;
              onChange(rest);
            }}
          >
            <X size={14} />
          </button>
        </div>
      ))}
      {missing.length > 0 && (
        <select
          className="ff-input text-muted"
          value=""
          onChange={(e) => {
            const option = options.find((o) => o.name === e.target.value);
            if (option)
              onChange({ ...value, [option.name]: structuredClone(option.default) as Value });
          }}
        >
          <option value="">{property.placeholder ?? 'Add option'}</option>
          {missing.map((o) => (
            <option key={o.name} value={o.name}>
              {o.displayName}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

function FixedCollectionInput({
  property,
  value,
  onChange,
}: {
  property: INodeProperties;
  value: INodeParameters;
  onChange: (v: Value) => void;
}) {
  const groups = (property.options ?? []) as INodePropertyCollection[];
  const multiple = property.typeOptions?.multipleValues;
  const defaults = (group: INodePropertyCollection) =>
    Object.fromEntries(
      group.values.map((v) => [v.name, structuredClone(v.default)]),
    ) as INodeParameters;

  return (
    <div className="space-y-3">
      {groups.map((group) => {
        const raw = value[group.name];
        const entries = (
          multiple ? (Array.isArray(raw) ? raw : []) : raw ? [raw] : []
        ) as INodeParameters[];
        const update = (next: INodeParameters[]) =>
          onChange({
            ...value,
            [group.name]: multiple ? next : (next[0] ?? undefined),
          } as INodeParameters);
        return (
          <div key={group.name} className="space-y-2">
            {entries.map((entry, index) => (
              <div
                key={index}
                className="relative rounded-md border border-line bg-panel-2/40 p-3 pr-9"
              >
                <div className={clsx('grid gap-2', group.values.length === 2 && 'sm:grid-cols-2')}>
                  {group.values.map((field) =>
                    isPropertyVisible(field.displayOptions, entry) ? (
                      <ParameterField
                        key={field.name}
                        property={field}
                        value={entry[field.name] as Value}
                        onChange={(v) =>
                          update(
                            entries.map((e, i) => (i === index ? { ...e, [field.name]: v } : e)),
                          )
                        }
                      />
                    ) : null,
                  )}
                </div>
                <button
                  title="Remove"
                  className="absolute top-2.5 right-2.5 text-muted hover:text-danger"
                  onClick={() => update(entries.filter((_, i) => i !== index))}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
            {(multiple || entries.length === 0) && (
              <button
                onClick={() => update([...entries, defaults(group)])}
                className="flex items-center gap-1.5 text-[12.5px] font-medium text-accent hover:underline"
              >
                <Plus size={14} /> Add {group.displayName.toLowerCase()}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Filter conditions (IF / Filter)
// ---------------------------------------------------------------------------

const TYPE_LABELS: Record<FilterOperatorType, string> = {
  string: 'String',
  number: 'Number',
  dateTime: 'Date & Time',
  boolean: 'Boolean',
  array: 'Array',
  object: 'Object',
};

function SmallValueInput({
  value,
  onChange,
  placeholder,
}: {
  value: unknown;
  onChange: (v: unknown) => void;
  placeholder: string;
}) {
  const drop = useDrop(value as Value, onChange as (v: Value) => void);
  if (isExpr(value))
    return (
      <ExpressionInput
        value={value}
        onChange={onChange as (v: Value) => void}
        placeholder={placeholder}
      />
    );
  return (
    <input
      {...drop.props}
      className={clsx('ff-input', drop.over && 'drop-target')}
      placeholder={placeholder}
      value={
        value === undefined || value === null
          ? ''
          : typeof value === 'object'
            ? JSON.stringify(value)
            : String(value)
      }
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

function FilterInput({
  value,
  onChange,
}: {
  value: FilterValue;
  onChange: (v: FilterValue) => void;
}) {
  const conditions = value.conditions ?? [];
  const update = (index: number, patch: Partial<FilterCondition>) =>
    onChange({
      ...value,
      conditions: conditions.map((c, i) => (i === index ? { ...c, ...patch } : c)),
    });
  return (
    <div className="space-y-2">
      {conditions.map((condition, index) => (
        <div key={condition.id}>
          {index > 0 && (
            <div className="my-1.5 flex justify-center">
              <select
                className="ff-input w-auto py-0.5 text-xs"
                value={value.combinator}
                onChange={(e) => onChange({ ...value, combinator: e.target.value as 'and' | 'or' })}
              >
                <option value="and">AND</option>
                <option value="or">OR</option>
              </select>
            </div>
          )}
          <div className="relative grid gap-2 rounded-md border border-line p-2.5 pr-8">
            <SmallValueInput
              value={condition.leftValue}
              placeholder="value1, e.g. {{ $json.status }}"
              onChange={(v) => update(index, { leftValue: v })}
            />
            <select
              className="ff-input"
              value={`${condition.operator.type}:${condition.operator.operation}`}
              onChange={(e) => {
                const [type, operation] = e.target.value.split(':') as [FilterOperatorType, string];
                update(index, { operator: { type, operation } });
              }}
            >
              {(Object.keys(FILTER_OPERATORS) as FilterOperatorType[]).map((type) => (
                <optgroup key={type} label={TYPE_LABELS[type]}>
                  {FILTER_OPERATORS[type].map((op) => (
                    <option key={op.operation} value={`${type}:${op.operation}`}>
                      {TYPE_LABELS[type]}: {op.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
            {!isSingleValueOperator(condition.operator) && (
              <SmallValueInput
                value={condition.rightValue}
                placeholder="value2"
                onChange={(v) => update(index, { rightValue: v })}
              />
            )}
            <button
              title="Remove condition"
              className="absolute top-2.5 right-2 text-muted hover:text-danger"
              onClick={() =>
                onChange({ ...value, conditions: conditions.filter((_, i) => i !== index) })
              }
            >
              <Trash2 size={14} />
            </button>
          </div>
        </div>
      ))}
      <button
        onClick={() =>
          onChange({
            ...value,
            combinator: value.combinator ?? 'and',
            conditions: [
              ...conditions,
              {
                id: randomId(),
                leftValue: '',
                rightValue: '',
                operator: { type: 'string', operation: 'equals' },
              },
            ],
          })
        }
        className="flex items-center gap-1.5 text-[12.5px] font-medium text-accent hover:underline"
      >
        <Plus size={14} /> Add condition
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Edit Fields assignments
// ---------------------------------------------------------------------------

interface Assignment {
  id: string;
  name: string;
  value: unknown;
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
}
interface AssignmentValue {
  assignments: Assignment[];
}

function AssignmentInput({
  value,
  onChange,
}: {
  value: AssignmentValue;
  onChange: (v: AssignmentValue) => void;
}) {
  const assignments = value.assignments ?? [];
  const [over, setOver] = useState(false);
  const update = (index: number, patch: Partial<Assignment>) =>
    onChange({ assignments: assignments.map((a, i) => (i === index ? { ...a, ...patch } : a)) });

  const onDrop = (e: DragEvent) => {
    const path = e.dataTransfer.getData(DRAG_MIME);
    setOver(false);
    if (!path) return;
    e.preventDefault();
    const name =
      path
        .replace(/^\$json\.?/, '')
        .replace(/\["([^"]+)"\]/g, '.$1')
        .replace(/^\./, '') || 'field';
    onChange({
      assignments: [
        ...assignments,
        { id: randomId(), name, value: `={{ ${path} }}`, type: 'string' },
      ],
    });
  };

  return (
    <div
      className={clsx('space-y-2 rounded-md', over && 'outline-2 outline-dashed outline-accent')}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(DRAG_MIME)) {
          e.preventDefault();
          setOver(true);
        }
      }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
    >
      {assignments.length === 0 && (
        <div className="rounded-md border border-dashed border-line px-3 py-5 text-center text-[12.5px] text-muted">
          Drag input fields here, or add a field
        </div>
      )}
      {assignments.map((assignment, index) => (
        <div
          key={assignment.id}
          className="relative grid gap-2 rounded-md border border-line p-2.5 pr-8"
        >
          <div className="flex gap-2">
            <input
              className="ff-input"
              placeholder="name"
              value={assignment.name}
              onChange={(e) => update(index, { name: e.target.value })}
            />
            <select
              className="ff-input w-28"
              value={assignment.type}
              onChange={(e) => update(index, { type: e.target.value as Assignment['type'] })}
            >
              <option value="string">String</option>
              <option value="number">Number</option>
              <option value="boolean">Boolean</option>
              <option value="array">Array</option>
              <option value="object">Object</option>
            </select>
          </div>
          <SmallValueInput
            value={assignment.value}
            placeholder="value"
            onChange={(v) => update(index, { value: v })}
          />
          <button
            title="Remove field"
            className="absolute top-3 right-2 text-muted hover:text-danger"
            onClick={() => onChange({ assignments: assignments.filter((_, i) => i !== index) })}
          >
            <Trash2 size={14} />
          </button>
        </div>
      ))}
      <button
        onClick={() =>
          onChange({
            assignments: [...assignments, { id: randomId(), name: '', value: '', type: 'string' }],
          })
        }
        className="flex items-center gap-1.5 text-[12.5px] font-medium text-accent hover:underline"
      >
        <Plus size={14} /> Add field
      </button>
    </div>
  );
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <div className="mb-2 text-[11px] font-semibold tracking-wide text-muted uppercase">
        {title}
      </div>
      {children}
    </div>
  );
}
