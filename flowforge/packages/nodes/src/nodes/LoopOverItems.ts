import type {
  IDataObject,
  IExecuteFunctions,
  INodeExecutionData,
  INodeType,
} from '@flowforge/workflow';

interface LoopState extends IDataObject {
  remaining: INodeExecutionData[];
  processed: INodeExecutionData[];
  batch: number;
}

export const LoopOverItems: INodeType = {
  description: {
    name: 'flowforge.splitInBatches',
    displayName: 'Loop Over Items',
    icon: 'repeat',
    iconColor: '#007755',
    group: ['flow'],
    version: 1,
    description: 'Process items in batches: connect the "loop" output back to this node',
    defaults: { name: 'Loop Over Items' },
    inputs: [{ type: 'main' }],
    outputs: [
      { type: 'main', displayName: 'done' },
      { type: 'main', displayName: 'loop' },
    ],
    keywords: ['batch', 'split in batches', 'iterate', 'for each', 'chunk', 'paginate'],
    properties: [
      {
        displayName:
          'Connect the "loop" output to the nodes that process each batch, and connect the last of them back to this node. When all batches are done, everything processed comes out of "done".',
        name: 'notice',
        type: 'notice',
        default: '',
      },
      {
        displayName: 'Batch Size',
        name: 'batchSize',
        type: 'number',
        default: 1,
        typeOptions: { minValue: 1 },
      },
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        default: {},
        placeholder: 'Add option',
        options: [
          {
            displayName: 'Reset',
            name: 'reset',
            type: 'boolean',
            default: false,
            description:
              'Treat incoming items as a new list instead of results of the previous batch',
          },
        ],
      },
    ],
  },

  async execute(this: IExecuteFunctions) {
    const items = this.getInputData();
    const batchSize = Math.max(1, Math.floor(Number(this.getNodeParameter('batchSize', 0, 1))));
    const reset = this.getNodeParameter<boolean>('options.reset', 0, false);
    const context = this.getContext() as Partial<LoopState>;

    if (!context.remaining || reset) {
      // First run: remember the full list and emit the first batch.
      const all = items.map((item, i) => ({
        json: item.json,
        ...(item.binary ? { binary: item.binary } : {}),
        pairedItem: { item: i },
      }));
      context.remaining = all.slice(batchSize);
      context.processed = [];
      context.batch = 1;
      return [[], all.slice(0, batchSize)];
    }

    // Results of the previous batch came back through the loop connection.
    context.processed = [
      ...(context.processed ?? []),
      ...items.map((item) => ({
        json: item.json,
        ...(item.binary ? { binary: item.binary } : {}),
      })),
    ];
    if (context.remaining.length > 0) {
      const batch = context.remaining.slice(0, batchSize);
      context.remaining = context.remaining.slice(batchSize);
      context.batch = (context.batch ?? 1) + 1;
      return [[], batch];
    }

    const done = context.processed;
    for (const key of Object.keys(context)) delete context[key];
    return [done, []];
  },
};
