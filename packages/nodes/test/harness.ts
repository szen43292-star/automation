import { Workflow, type IConnection, type IDataObject, type INode, type INodeParameters, type IRun } from '@flowforge/workflow';
import { CodeSandbox, WorkflowExecute, createAdditionalData } from '@flowforge/engine';
import { createNodeTypes } from '../src';

export const nodeTypes = createNodeTypes();
/** Short timeout so the infinite-loop test is fast. */
const codeSandbox = new CodeSandbox({ timeoutMs: 2_000 });

/**
 * Run `Manual Trigger → node` with the given input items and return the run.
 */
export async function runNode(
  type: string,
  parameters: INodeParameters,
  input: IDataObject[] = [{}],
  extra: Partial<INode> = {},
): Promise<{ run: IRun; output: (outputIndex?: number) => IDataObject[] | undefined }> {
  const nodes: INode[] = [
    { id: 'trigger', name: 'Trigger', type: 'flowforge.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
    { id: 'node', name: 'Node', type, typeVersion: 1, position: [200, 0], parameters, ...extra },
  ];
  const connections: IConnection[] = [{ source: 'trigger', sourceOutput: 0, target: 'node', targetInput: 0 }];
  const run = await new WorkflowExecute(
    new Workflow({ name: 'test', nodes, connections }),
    createAdditionalData({ executionId: 'test', mode: 'manual', nodeTypes, codeSandbox }),
  ).run({ triggerItems: input.map((json) => ({ json })) });
  return {
    run,
    output: (outputIndex = 0) => run.data.resultData.runData.Node?.[0]?.data?.main[outputIndex]?.map((i) => i.json),
  };
}

export function errorOf(run: IRun) {
  return run.data.resultData.error;
}
