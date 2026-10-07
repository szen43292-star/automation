import { createContext, useContext } from 'react';
import {
  SimpleExpressionEvaluator,
  evaluateExpression,
  type ExpressionData,
  type INodeExecutionData,
} from '@flowforge/workflow';

export interface NdvContextValue {
  /** Items arriving at input 0 of the open node (from the last run, if any). */
  inputItems: INodeExecutionData[];
  getNodeOutput: ExpressionData['getNodeOutput'];
  workflowName: string;
  timezone: string;
  readOnly: boolean;
}

export const NdvContext = createContext<NdvContextValue>({
  inputItems: [],
  getNodeOutput: () => undefined,
  workflowName: '',
  timezone: 'UTC',
  readOnly: false,
});

export const useNdv = () => useContext(NdvContext);

const evaluator = new SimpleExpressionEvaluator();

export type PreviewResult = { ok: true; value: unknown } | { ok: false; error: string } | null;

/** Evaluate an expression against the first input item for the inline preview. */
export function previewExpression(expression: string, ctx: NdvContextValue): PreviewResult {
  if (!expression.startsWith('=')) return null;
  try {
    const value = evaluateExpression(
      expression,
      {
        item: ctx.inputItems[0],
        itemIndex: 0,
        runIndex: 0,
        inputItems: ctx.inputItems,
        getNodeOutput: ctx.getNodeOutput,
        workflow: { name: ctx.workflowName },
        execution: { id: 'preview', mode: 'manual' },
        parameters: {},
        timezone: ctx.timezone,
        vars: {},
      },
      evaluator,
    );
    return { ok: true, value };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
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
