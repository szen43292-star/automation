import { clsx } from 'clsx';
import { type LucideIcon, Box, X } from 'lucide-react';
import { NODE_ICONS } from '../../lib/icons';
import {
  forwardRef,
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

// ---------------------------------------------------------------------------

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md';

export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: Variant;
    size?: Size;
    icon?: LucideIcon;
    loading?: boolean;
  }
>(function Button(
  {
    variant = 'secondary',
    size = 'md',
    icon: Icon,
    loading,
    className,
    children,
    disabled,
    ...rest
  },
  ref,
) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={clsx(
        'inline-flex items-center justify-center gap-1.5 rounded-md font-medium whitespace-nowrap transition-colors select-none',
        'disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-2 focus-visible:outline-accent',
        size === 'sm' ? 'h-7 px-2.5 text-xs' : 'h-8.5 px-3.5 text-[13px]',
        variant === 'primary' && 'bg-accent text-white hover:bg-accent-hover',
        variant === 'secondary' && 'border border-line bg-panel text-fg hover:bg-panel-2',
        variant === 'ghost' && 'text-fg hover:bg-panel-2',
        variant === 'danger' && 'bg-danger text-white hover:opacity-90',
        className,
      )}
      {...rest}
    >
      {loading ? (
        <Spinner size={14} />
      ) : Icon ? (
        <Icon size={size === 'sm' ? 13 : 15} strokeWidth={2} />
      ) : null}
      {children}
    </button>
  );
});

export function IconButton({
  icon: Icon,
  label,
  className,
  active,
  size = 16,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  icon: LucideIcon;
  label: string;
  active?: boolean;
  size?: number;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      className={clsx(
        'inline-flex h-8 w-8 items-center justify-center rounded-md text-muted transition-colors hover:bg-panel-2 hover:text-fg',
        'disabled:opacity-40 disabled:cursor-not-allowed',
        active && 'bg-panel-2 text-fg',
        className,
      )}
      {...rest}
    >
      <Icon size={size} />
    </button>
  );
}

export function Spinner({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg
      className={clsx('ff-spin', className)}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export function Toggle({
  checked,
  onChange,
  disabled,
  label,
  size = 'md',
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
  label?: string;
  size?: 'sm' | 'md';
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={clsx(
        'relative inline-flex shrink-0 items-center rounded-full transition-colors disabled:opacity-50',
        size === 'sm' ? 'h-4.5 w-8' : 'h-5.5 w-10',
        checked ? 'bg-success' : 'bg-panel-3',
      )}
    >
      <span
        className={clsx(
          'inline-block rounded-full bg-white shadow transition-transform',
          size === 'sm' ? 'h-3.5 w-3.5' : 'h-4.5 w-4.5',
          checked ? (size === 'sm' ? 'translate-x-4' : 'translate-x-5') : 'translate-x-0.5',
        )}
      />
    </button>
  );
}

export function Badge({
  tone = 'neutral',
  children,
  className,
}: {
  tone?: 'neutral' | 'success' | 'danger' | 'warning' | 'accent' | 'info';
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium',
        tone === 'neutral' && 'bg-panel-2 text-muted',
        tone === 'success' && 'bg-success-soft text-success',
        tone === 'danger' && 'bg-danger-soft text-danger',
        tone === 'warning' && 'bg-warning-soft text-warning',
        tone === 'accent' && 'bg-accent-soft text-accent',
        tone === 'info' && 'bg-panel-2 text-info',
        className,
      )}
    >
      {children}
    </span>
  );
}

// ---------------------------------------------------------------------------

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  width = 480,
  className,
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  width?: number | string;
  className?: string;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, onClose]);
  if (!open) return null;
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4"
      onMouseDown={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        className={clsx(
          'flex max-h-full flex-col rounded-xl border border-line bg-panel shadow-2xl',
          className,
        )}
        style={{ width, maxWidth: '100%' }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {title !== undefined && (
          <div className="flex items-center justify-between border-b border-line px-5 py-3.5">
            <h2 className="text-[15px] font-semibold">{title}</h2>
            <IconButton icon={X} label="Close" onClick={onClose} />
          </div>
        )}
        <div className="ff-scroll min-h-0 flex-1 overflow-auto px-5 py-4">{children}</div>
        {footer && (
          <div className="flex justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>
        )}
      </div>
    </div>,
    document.body,
  );
}

export interface MenuItem {
  label: string;
  icon?: LucideIcon;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
  shortcut?: string;
}

export function Menu({
  trigger,
  items,
  align = 'right',
}: {
  trigger: ReactNode;
  items: Array<MenuItem | 'divider'>;
  align?: 'left' | 'right';
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <div ref={ref} className="relative inline-block">
      <div
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
      >
        {trigger}
      </div>
      {open && (
        <div
          className={clsx(
            'absolute z-40 mt-1 min-w-48 rounded-lg border border-line bg-panel py-1 shadow-card',
            align === 'right' ? 'right-0' : 'left-0',
          )}
        >
          {items.map((item, i) =>
            item === 'divider' ? (
              <div key={i} className="my-1 border-t border-line" />
            ) : (
              <button
                key={item.label}
                disabled={item.disabled}
                onClick={(e) => {
                  e.stopPropagation();
                  setOpen(false);
                  item.onClick();
                }}
                className={clsx(
                  'flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[13px] hover:bg-panel-2 disabled:opacity-40',
                  item.danger ? 'text-danger' : 'text-fg',
                )}
              >
                {item.icon && <item.icon size={14} className="shrink-0 opacity-80" />}
                <span className="flex-1">{item.label}</span>
                {item.shortcut && <kbd className="text-[11px] text-muted">{item.shortcut}</kbd>}
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

export function iconFor(name: string | undefined): LucideIcon {
  return (name && NODE_ICONS[name]) || Box;
}

export function NodeIcon({
  icon,
  color,
  size = 22,
}: {
  icon?: string;
  color?: string;
  size?: number;
}) {
  const Icon = iconFor(icon);
  return <Icon size={size} color={color} strokeWidth={1.8} />;
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon: LucideIcon;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-panel-2 text-muted">
        <Icon size={22} />
      </div>
      <div>
        <div className="font-semibold">{title}</div>
        {description && <div className="mt-1 max-w-sm text-[13px] text-muted">{description}</div>}
      </div>
      {action}
    </div>
  );
}

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[12.5px] font-medium">{label}</span>
      {children}
      {error ? (
        <span className="mt-1 block text-xs text-danger">{error}</span>
      ) : hint ? (
        <span className="mt-1 block text-xs text-muted">{hint}</span>
      ) : null}
    </label>
  );
}
