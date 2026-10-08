import { Suspense, lazy, useEffect, useState } from 'react';
import type { INodeExecutionData } from '@flowforge/workflow';
import { useEditor } from '../../stores/editor';
import { Button, Modal } from '../ui';

const CodeEditor = lazy(() => import('./CodeEditor').then((m) => ({ default: m.CodeEditor })));

/** Edit (or create) the pinned output of a node as a JSON array. */
export function PinDataModal({
  open,
  onClose,
  nodeName,
  initial,
}: {
  open: boolean;
  onClose: () => void;
  nodeName: string;
  initial: INodeExecutionData[] | null;
}) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setError(null);
    setText(
      JSON.stringify(
        initial?.length ? initial.map((i) => i.json) : [{ name: 'First item', code: 1 }],
        null,
        2,
      ),
    );
  }, [open, initial]);

  const save = () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      setError(`Invalid JSON: ${(e as Error).message}`);
      return;
    }
    const list = Array.isArray(parsed) ? parsed : [parsed];
    if (!list.every((v) => v !== null && typeof v === 'object' && !Array.isArray(v))) {
      setError('Each item must be a JSON object, e.g. [{ "name": "Asha" }]');
      return;
    }
    useEditor.getState().setPinData(
      nodeName,
      list.map((json) => ({ json: json as Record<string, unknown> })),
    );
    onClose();
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      width={640}
      title={`Pinned output of "${nodeName}"`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={save}>
            Pin data
          </Button>
        </>
      }
    >
      <p className="mb-3 text-[13px] text-muted">
        While pinned, the node doesn't run: it outputs this data instead. Useful to test later nodes
        without calling real services, or to mock a trigger.
      </p>
      <Suspense fallback={<div className="ff-input h-60 animate-pulse" />}>
        <CodeEditor value={text} onChange={setText} language="json" minRows={14} />
      </Suspense>
      {error && (
        <div className="mt-2 rounded-md bg-danger-soft px-3 py-2 text-[13px] text-danger">
          {error}
        </div>
      )}
    </Modal>
  );
}
