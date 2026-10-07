import { SimpleExpressionEvaluator, type INodeTypes } from '@flowforge/workflow';
import { httpRequest } from './http';
import { CodeSandbox } from './sandbox/CodeSandbox';
import type { WorkflowExecuteAdditionalData } from './types';

export { WorkflowExecute } from './WorkflowExecute';
export { ExecuteContext } from './ExecuteContext';
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
    expressionEvaluator: new SimpleExpressionEvaluator(),
    httpRequest,
    codeSandbox: sharedSandbox,
    ...base,
  };
}

export type { INodeTypes };
