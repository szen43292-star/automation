import {
  NodeOperationError,
  type IExecuteFunctions,
  type INodeExecutionData,
  type INodeType,
  type IWorkflowBase,
} from '@flowforge/workflow';

export const ExecuteWorkflow: INodeType = {
  description: {
    name: 'flowforge.executeWorkflow',
    displayName: 'Execute Sub-workflow',
    icon: 'workflow',
    iconColor: '#ff6d5a',
    group: ['flow'],
    version: 1,
    description: 'Run another workflow and use its result',
    defaults: { name: 'Execute Sub-workflow' },
    inputs: [{ type: 'main' }],
    outputs: [{ type: 'main' }],
    keywords: ['call', 'subworkflow', 'reuse', 'function'],
    properties: [
      {
        displayName: 'Source',
        name: 'source',
        type: 'options',
        default: 'database',
        options: [
          { name: 'Saved Workflow', value: 'database' },
          { name: 'Workflow JSON', value: 'parameter' },
        ],
      },
      {
        displayName: 'Workflow',
        name: 'workflowId',
        type: 'options',
        default: '',
        typeOptions: { loadOptionsMethod: 'workflows' },
        description: 'The sub-workflow must start with an "Execute Workflow Trigger" node',
        displayOptions: { show: { source: ['database'] } },
      },
      {
        displayName: 'Workflow JSON',
        name: 'workflowJson',
        type: 'json',
        default: '',
        typeOptions: { editor: 'json', rows: 8 },
        displayOptions: { show: { source: ['parameter'] } },
      },
      {
        displayName: 'Mode',
        name: 'mode',
        type: 'options',
        default: 'once',
        options: [
          { name: 'Run Once with All Items', value: 'once' },
          { name: 'Run Once for Each Item', value: 'each' },
        ],
      },
      {
        displayName: 'Wait for Sub-workflow Completion',
        name: 'waitForSubWorkflow',
        type: 'boolean',
        default: true,
        description:
          'When off, the sub-workflow runs in the background and this node outputs its input',
      },
    ],
  },

  async execute(this: IExecuteFunctions) {
    const items = this.getInputData();
    const mode = this.getNodeParameter<string>('mode', 0, 'once');
    const wait = this.getNodeParameter<boolean>('waitForSubWorkflow', 0, true);

    const sourceFor = (i: number) => {
      const source = this.getNodeParameter<string>('source', i, 'database');
      if (source === 'parameter') {
        const raw = this.getNodeParameter<unknown>('workflowJson', i, '');
        try {
          return {
            workflowData: (typeof raw === 'string' ? JSON.parse(raw) : raw) as IWorkflowBase,
          };
        } catch (error) {
          throw new NodeOperationError(this.getNode(), 'Workflow JSON is not valid JSON', {
            description: (error as Error).message,
            itemIndex: i,
          });
        }
      }
      const workflowId = String(this.getNodeParameter('workflowId', i, '') ?? '');
      if (!workflowId)
        throw new NodeOperationError(this.getNode(), 'No workflow selected', { itemIndex: i });
      return { workflowId };
    };

    const batches =
      mode === 'each'
        ? items.map((item, i) => ({ items: [item], index: i }))
        : [{ items, index: 0 }];
    const output: INodeExecutionData[] = [];
    for (const batch of batches) {
      const result = await this.helpers.executeWorkflow(
        sourceFor(batch.index),
        batch.items.map(({ json, binary }) => ({ json, ...(binary ? { binary } : {}) })),
        { waitForCompletion: wait },
      );
      if (!wait) {
        output.push(
          ...batch.items.map((item, k) => ({ ...item, pairedItem: { item: batch.index + k } })),
        );
        continue;
      }
      for (const item of result.data?.[0] ?? []) {
        output.push({
          json: item.json,
          ...(item.binary ? { binary: item.binary } : {}),
          pairedItem: { item: batch.index },
        });
      }
    }
    return [output];
  },
};

export const ExecuteWorkflowTrigger: INodeType = {
  description: {
    name: 'flowforge.executeWorkflowTrigger',
    displayName: 'Execute Workflow Trigger',
    icon: 'play',
    iconColor: '#ff6d5a',
    group: ['trigger'],
    triggerKind: 'subworkflow',
    maxNodes: 1,
    version: 1,
    description: 'Start this workflow when another workflow calls it ("Execute Sub-workflow" node)',
    defaults: { name: 'When called by another workflow' },
    inputs: [],
    outputs: [{ type: 'main' }],
    keywords: ['sub-workflow', 'called', 'function'],
    properties: [
      {
        displayName:
          'Receives the items sent by the calling workflow. The output of the last node is returned to the caller.',
        name: 'notice',
        type: 'notice',
        default: '',
      },
    ],
  },
  async execute(this: IExecuteFunctions) {
    return [this.getInputData()];
  },
};

export const ErrorTrigger: INodeType = {
  description: {
    name: 'flowforge.errorTrigger',
    displayName: 'Error Trigger',
    icon: 'octagon',
    iconColor: '#dc2626',
    group: ['trigger'],
    triggerKind: 'error',
    maxNodes: 1,
    version: 1,
    description: 'Start this workflow when another workflow fails (set it as their error workflow)',
    defaults: { name: 'Error Trigger' },
    inputs: [],
    outputs: [{ type: 'main' }],
    keywords: ['failure', 'alert', 'monitoring', 'exception'],
    properties: [
      {
        displayName:
          'In another workflow, open Settings → Error Workflow and pick this workflow. Manual runs output sample data.',
        name: 'notice',
        type: 'notice',
        default: '',
      },
    ],
  },
  async execute(this: IExecuteFunctions) {
    const items = this.getInputData();
    if (this.getMode() === 'manual' && !items.some((i) => 'execution' in i.json)) {
      return [
        [
          {
            json: {
              execution: {
                id: 'sample-id',
                url: `${this.getPublicUrl()}/workflow/sample/executions/sample-id`,
                error: { message: 'Example error message', node: 'HTTP Request' },
                lastNodeExecuted: 'HTTP Request',
                mode: 'trigger',
              },
              workflow: { id: 'sample', name: 'Example workflow' },
            },
          },
        ],
      ];
    }
    return [items];
  },
};
