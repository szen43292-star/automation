import {
  NodeOperationError,
  evaluateFilter,
  type FilterValue,
  type IExecuteFunctions,
  type INodeExecutionData,
  type INodeType,
} from '@flowforge/workflow';
import { conditionsProperty, errorItem, wrapItemError } from '../shared/helpers';

interface Rule {
  conditions: FilterValue;
  renameOutput?: boolean;
  outputKey?: string;
}

export const Switch: INodeType = {
  description: {
    name: 'flowforge.switch',
    displayName: 'Switch',
    icon: 'git-branch',
    iconColor: '#506000',
    group: ['flow'],
    version: 1,
    description: 'Route items to different outputs based on rules',
    subtitle: '={{ $parameter.mode }}',
    defaults: { name: 'Switch' },
    inputs: [{ type: 'main' }],
    outputs: [{ type: 'main', displayName: '0' }],
    dynamicOutputs: {
      modeParameter: 'mode',
      modes: {
        rules: { fromArray: 'rules.values', labelField: 'outputKey', labelToggle: 'renameOutput' },
        expression: { fromCount: 'numberOutputs' },
      },
      extra: { parameter: 'options.fallbackOutput', equals: 'extra', label: 'Fallback' },
    },
    keywords: ['router', 'case', 'route', 'branch', 'if else'],
    properties: [
      {
        displayName: 'Mode',
        name: 'mode',
        type: 'options',
        default: 'rules',
        noDataExpression: true,
        options: [
          { name: 'Rules', value: 'rules', description: 'Build a matching rule for each output' },
          {
            name: 'Expression',
            value: 'expression',
            description: 'Return the output index with an expression',
          },
        ],
      },
      {
        displayName: 'Routing Rules',
        name: 'rules',
        type: 'fixedCollection',
        typeOptions: { multipleValues: true, sortable: true },
        default: {
          values: [
            {
              conditions: conditionsProperty.default,
              renameOutput: false,
              outputKey: '',
            },
          ],
        },
        displayOptions: { show: { mode: ['rules'] } },
        options: [
          {
            name: 'values',
            displayName: 'Routing Rule',
            values: [
              { ...conditionsProperty },
              {
                displayName: 'Rename Output',
                name: 'renameOutput',
                type: 'boolean',
                default: false,
              },
              {
                displayName: 'Output Name',
                name: 'outputKey',
                type: 'string',
                default: '',
                displayOptions: { show: { renameOutput: [true] } },
              },
            ],
          },
        ],
      },
      {
        displayName: 'Number of Outputs',
        name: 'numberOutputs',
        type: 'number',
        default: 4,
        typeOptions: { minValue: 1, maxValue: 64 },
        displayOptions: { show: { mode: ['expression'] } },
      },
      {
        displayName: 'Output Index',
        name: 'output',
        type: 'number',
        default: '={{ 0 }}',
        description: 'Expression returning the output (0-based) each item goes to',
        displayOptions: { show: { mode: ['expression'] } },
      },
      {
        displayName: 'Convert Types Where Required',
        name: 'looseTypeValidation',
        type: 'boolean',
        default: false,
        displayOptions: { show: { mode: ['rules'] } },
      },
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        default: {},
        placeholder: 'Add option',
        displayOptions: { show: { mode: ['rules'] } },
        options: [
          {
            displayName: 'Fallback Output',
            name: 'fallbackOutput',
            type: 'options',
            default: 'none',
            options: [
              { name: 'None (drop the item)', value: 'none' },
              { name: 'Extra "Fallback" Output', value: 'extra' },
            ],
            description: 'Where items that match no rule go',
          },
          {
            displayName: 'Send to All Matching Outputs',
            name: 'allMatchingOutputs',
            type: 'boolean',
            default: false,
            description: 'By default an item goes to the first matching rule only',
          },
          { displayName: 'Ignore Case', name: 'ignoreCase', type: 'boolean', default: true },
        ],
      },
    ],
  },

  async execute(this: IExecuteFunctions) {
    const items = this.getInputData();
    const mode = this.getNodeParameter<string>('mode', 0, 'rules');

    if (mode === 'expression') {
      const count = Math.max(1, Math.min(64, Number(this.getNodeParameter('numberOutputs', 0, 4))));
      const outputs: INodeExecutionData[][] = Array.from({ length: count }, () => []);
      items.forEach((item, i) => {
        const index = Number(this.getNodeParameter('output', i));
        if (!Number.isInteger(index) || index < 0 || index >= count) {
          throw new NodeOperationError(
            this.getNode(),
            `Output index ${String(index)} is not between 0 and ${count - 1}`,
            {
              itemIndex: i,
            },
          );
        }
        outputs[index]!.push({ ...item, pairedItem: { item: i } });
      });
      return outputs;
    }

    const ruleCount = (
      this.getNodeParameter<{ values?: unknown[] }>('rules', 0, {}, { rawExpressions: true })
        .values ?? []
    ).length;
    const fallback = this.getNodeParameter<string>('options.fallbackOutput', 0, 'none');
    const all = this.getNodeParameter<boolean>('options.allMatchingOutputs', 0, false);
    const outputs: INodeExecutionData[][] = Array.from(
      { length: ruleCount + (fallback === 'extra' ? 1 : 0) },
      () => [],
    );
    const loose = this.getNodeParameter<boolean>('looseTypeValidation', 0, false);
    const ignoreCase = this.getNodeParameter<boolean>('options.ignoreCase', 0, true);

    items.forEach((item, i) => {
      try {
        const rules = this.getNodeParameter<{ values?: Rule[] }>('rules', i, {}).values ?? [];
        let matched = false;
        for (let r = 0; r < rules.length; r++) {
          const ok = evaluateFilter(rules[r]!.conditions, {
            caseSensitive: !ignoreCase,
            typeValidation: loose ? 'loose' : 'strict',
          });
          if (!ok) continue;
          matched = true;
          outputs[r]!.push({ ...item, pairedItem: { item: i } });
          if (!all) break;
        }
        if (!matched && fallback === 'extra')
          outputs[ruleCount]!.push({ ...item, pairedItem: { item: i } });
      } catch (error) {
        if (this.continueOnFail()) {
          outputs[0]!.push(errorItem(this, error, i, item));
          return;
        }
        throw wrapItemError(this, error, i);
      }
    });
    return outputs;
  },
};
