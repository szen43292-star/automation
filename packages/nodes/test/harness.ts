import {
  Workflow,
  type IConnection,
  type IDataObject,
  type INode,
  type INodeParameters,
  type IRun,
} from '@flowforge/workflow';
import {
  CodeSandbox,
  WorkflowExecute,
  createAdditionalData,
  type WorkflowExecuteAdditionalData,
  type WorkflowRunOptions,
} from '@flowforge/engine';
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
  additional: Partial<WorkflowExecuteAdditionalData> = {},
): Promise<{ run: IRun; output: (outputIndex?: number) => IDataObject[] | undefined }> {
  const nodes: INode[] = [
    {
      id: 'trigger',
      name: 'Trigger',
      type: 'flowforge.manualTrigger',
      typeVersion: 1,
      position: [0, 0],
      parameters: {},
    },
    { id: 'node', name: 'Node', type, typeVersion: 1, position: [200, 0], parameters, ...extra },
  ];
  const connections: IConnection[] = [
    { source: 'trigger', sourceOutput: 0, target: 'node', targetInput: 0 },
  ];
  const run = await new WorkflowExecute(
    new Workflow({ name: 'test', nodes, connections }),
    createAdditionalData({
      executionId: 'test',
      mode: 'manual',
      nodeTypes,
      codeSandbox,
      ...additional,
    }),
  ).run({ triggerItems: input.map((json) => ({ json })) });
  return {
    run,
    output: (outputIndex = 0) =>
      run.data.resultData.runData.Node?.[0]?.data?.main[outputIndex]?.map((i) => i.json),
  };
}

export function errorOf(run: IRun) {
  return run.data.resultData.error;
}

/** Run an arbitrary graph. Nodes get ids equal to their names. */
export async function runGraph(
  nodes: Array<Omit<INode, 'id' | 'typeVersion' | 'position'> & { position?: [number, number] }>,
  connections: Array<[string, string, number?, number?]>,
  options: WorkflowRunOptions = {},
  additional: Partial<WorkflowExecuteAdditionalData> = {},
) {
  const full: INode[] = nodes.map((n, i) => ({
    id: n.name,
    typeVersion: 1,
    position: n.position ?? [i * 200, 0],
    ...n,
  }));
  const run = await new WorkflowExecute(
    new Workflow({
      name: 'graph',
      nodes: full,
      connections: connections.map(([source, target, sourceOutput = 0, targetInput = 0]) => ({
        source,
        target,
        sourceOutput,
        targetInput,
      })),
    }),
    createAdditionalData({
      executionId: 'graph',
      mode: 'manual',
      nodeTypes,
      codeSandbox,
      ...additional,
    }),
  ).run(options);
  return {
    run,
    output: (node: string, outputIndex = 0, runIndex?: number) => {
      const runs = run.data.resultData.runData[node];
      return runs?.[runIndex ?? runs.length - 1]?.data?.main[outputIndex]?.map((i) => i.json);
    },
  };
}
