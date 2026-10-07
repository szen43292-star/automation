import type { IExecuteFunctions, INodeType } from '@flowforge/workflow';

export const ManualTrigger: INodeType = {
  description: {
    name: 'flowforge.manualTrigger',
    displayName: 'Manual Trigger',
    icon: 'mouse-pointer-click',
    iconColor: '#ff6d5a',
    group: ['trigger'],
    version: 1,
    description: 'Runs the workflow when you click "Execute workflow" in the editor',
    defaults: { name: 'When clicking "Execute workflow"' },
    inputs: [],
    outputs: [{ type: 'main' }],
    maxNodes: 1,
    keywords: ['start', 'manual', 'test', 'click'],
    properties: [
      {
        displayName: 'This node is where the workflow starts when you click "Execute workflow" in the editor.',
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
