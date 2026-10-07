import type { INodeTypes } from '@flowforge/workflow';
import { httpRequest } from './http';
import { CodeSandbox } from './sandbox/CodeSandbox';
import { IsolatedExpressionEvaluator } from './sandbox/ExpressionSandbox';
import type { WorkflowExecuteAdditionalData } from './types';

export { WorkflowExecute, WAIT_FOREVER } from './WorkflowExecute';
export { IsolatedExpressionEvaluator } from './sandbox/ExpressionSandbox';
export type { ExpressionSandboxOptions } from './sandbox/ExpressionSandbox';
export { ExecuteContext, prepareBinaryData } from './ExecuteContext';
export { httpRequest, HttpRequestError, buildUrl } from './http';
export { CodeSandbox, CodeExecutionError } from './sandbox/CodeSandbox';
export type { CodeSandboxOptions, SandboxRunInput, SandboxRunOutput } from './sandbox/CodeSandbox';
export type * from './types';

let sharedSandbox: CodeSandbox | undefined;

/** Build additional data with production defaults; override anything for tests. */
export function createAdditionalData(
  base: Pick<WorkflowExecuteAdditionalData, 'executionId' | 'mode' | 'nodeTypes'> &
    Partial<WorkflowExecuteAdditionalData>,
): WorkflowExecuteAdditionalData {
  sharedSandbox ??= new CodeSandbox();
  return {
    // One isolate per execution (disposed when the run ends).
    expressionEvaluator: new IsolatedExpressionEvaluator(),
    httpRequest,
    codeSandbox: sharedSandbox,
    ...base,
  };
}

export type { INodeTypes };
