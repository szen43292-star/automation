'use client';

import { Check, Copy } from 'lucide-react';
import { useState } from 'react';

export function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          // clipboard blocked - the value is visible to copy by hand
        }
      }}
      className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-line bg-panel px-2.5 text-xs font-medium text-muted transition hover:text-fg"
      aria-label={label}
    >
      {copied ? <Check size={14} className="text-success" /> : <Copy size={14} />}
      {copied ? 'Copied' : label}
    </button>
  );
}
