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

export const Filter: INodeType = {
  description: {
    name: 'flowforge.filter',
    displayName: 'Filter',
    icon: 'filter',
    iconColor: '#229eff',
    group: ['flow', 'transform'],
    version: 1,
    description: 'Keep only the items that match the conditions',
    defaults: { name: 'Filter' },
    inputs: [{ type: 'main' }],
    outputs: [{ type: 'main', displayName: 'Kept' }],
    keywords: ['where', 'remove', 'exclude', 'condition'],
    properties: [conditionsProperty, ...conditionOptionsProperties],
  },

  async execute(this: IExecuteFunctions) {
    const items = this.getInputData();
    const kept: INodeExecutionData[] = [];
    items.forEach((item, i) => {
      try {
        const { filter, options } = getFilterParameters(this, i);
        if (evaluateFilter(filter, options)) kept.push({ ...item, pairedItem: { item: i } });
      } catch (error) {
        if (this.continueOnFail()) {
          kept.push(errorItem(this, error, i, item));
          return;
        }
        throw wrapItemError(this, error, i);
      }
    });
    if (items.length > 0 && kept.length === 0) {
      this.addHint('No items matched the conditions, so nothing was passed on to the next node.');
    }
    return [kept];
  },
};
