import {
  evaluateFilter,
  type IExecuteFunctions,
  type INodeExecutionData,
  type INodeType,
} from '@flowforge/workflow';
import {
  conditionOptionsProperties,
  conditionsProperty,
  errorItem,
  getFilterParameters,
  wrapItemError,
} from '../shared/helpers';

export const If: INodeType = {
  description: {
    name: 'flowforge.if',
    displayName: 'If',
    icon: 'split',
    iconColor: '#408000',
    group: ['flow'],
    version: 1,
    description: 'Route items to "true" or "false" based on conditions',
    defaults: { name: 'If' },
    inputs: [{ type: 'main' }],
    outputs: [
      { type: 'main', displayName: 'true' },
      { type: 'main', displayName: 'false' },
    ],
    keywords: ['condition', 'branch', 'compare', 'boolean', 'router'],
    properties: [conditionsProperty, ...conditionOptionsProperties],
  },

  async execute(this: IExecuteFunctions) {
    const items = this.getInputData();
    const trueItems: INodeExecutionData[] = [];
    const falseItems: INodeExecutionData[] = [];

    items.forEach((item, i) => {
      try {
        const { filter, options } = getFilterParameters(this, i);
        const target = evaluateFilter(filter, options) ? trueItems : falseItems;
        target.push({ ...item, pairedItem: { item: i } });
      } catch (error) {
        if (this.continueOnFail()) {
          falseItems.push(errorItem(this, error, i, item));
          return;
        }
        throw wrapItemError(this, error, i);
      }
    });
    return [trueItems, falseItems];
  },
};
