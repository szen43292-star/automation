import { createContext, useContext, useEffect, useState } from 'react';
import type { IDataObject, INodeExecutionData, IRunData, ISourceData } from '@flowforge/workflow';
import { buildSnapshot, previewExpression, type PreviewResult } from '../../lib/expressionSandbox';

export interface NdvContextValue {
  /** Items arriving at input 0 of the open node (from the last run, if any). */
  inputItems: INodeExecutionData[];
  /** Where those items came from (for $('Node').item pairing). */
  inputSource: ISourceData | null;
  runData: IRunData | null;
  getNodeOutput: (name: string) => INodeExecutionData[] | undefined;
  /** Names of all other nodes (autocomplete). */
  nodeNames: string[];
  workflowId?: string;
  workflowName: string;
  timezone: string;
  vars: IDataObject;
  parameters: IDataObject;
  readOnly: boolean;
}

export const NdvContext = createContext<NdvContextValue>({
  inputItems: [],
  inputSource: null,
  runData: null,
  getNodeOutput: () => undefined,
  nodeNames: [],
  workflowName: '',
  timezone: 'UTC',
  vars: {},
  parameters: {},
  readOnly: false,
});

export const useNdv = () => useContext(NdvContext);

/** Debounced, sandboxed preview of an expression against the current input. */
export function useExpressionPreview(expression: string): PreviewResult | null {
  const ctx = useNdv();
  const [result, setResult] = useState<PreviewResult | null>(null);
  useEffect(() => {
    if (!expression.startsWith('=')) {
      setResult(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      const snapshot = buildSnapshot({
        expression,
        inputItems: ctx.inputItems,
        inputSource: ctx.inputSource,
        runData: ctx.runData,
        getNodeOutput: ctx.getNodeOutput,
        workflow: { id: ctx.workflowId, name: ctx.workflowName },
        timezone: ctx.timezone,
        vars: ctx.vars,
        parameters: ctx.parameters,
      });
      void previewExpression(expression, snapshot).then((r) => {
        if (!cancelled) setResult(r);
      });
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [expression, ctx]);
  return result;
}

export const DRAG_MIME = 'application/x-flowforge-expression';

/** `customer.first name` → `$json.customer["first name"]` */
export function toJsonPath(parts: Array<string | number>, root = '$json'): string {
  return parts.reduce<string>((acc, part) => {
    if (typeof part === 'number') return `${acc}[${part}]`;
    return /^[A-Za-z_$][\w$]*$/.test(part)
      ? `${acc}.${part}`
      : `${acc}["${part.replace(/"/g, '\\"')}"]`;
  }, root);
}
