import {
  NodeOperationError,
  getPath,
  type IDataObject,
  type IExecuteFunctions,
  type INodeType,
} from '@flowforge/workflow';

interface FieldToAggregate {
  fieldToAggregate: string;
  renameField?: boolean;
  outputFieldName?: string;
}

export const Aggregate: INodeType = {
  description: {
    name: 'flowforge.aggregate',
    displayName: 'Aggregate',
    icon: 'layers',
    iconColor: '#e11d48',
    group: ['transform'],
    version: 1,
    description: 'Combine fields from many items into a single item with lists',
    defaults: { name: 'Aggregate' },
    inputs: [{ type: 'main' }],
    outputs: [{ type: 'main' }],
    keywords: ['combine', 'group', 'collect', 'list', 'array', 'concatenate'],
    properties: [
      {
        displayName: 'Aggregate',
        name: 'aggregate',
        type: 'options',
        default: 'aggregateIndividualFields',
        options: [
          { name: 'Individual Fields', value: 'aggregateIndividualFields' },
          { name: 'All Item Data (Into a Single List)', value: 'aggregateAllItemData' },
        ],
      },
      {
        displayName: 'Fields To Aggregate',
        name: 'fieldsToAggregate',
        type: 'fixedCollection',
        typeOptions: { multipleValues: true },
        default: { fieldToAggregate: [{ fieldToAggregate: '', renameField: false }] },
        displayOptions: { show: { aggregate: ['aggregateIndividualFields'] } },
        options: [
          {
            name: 'fieldToAggregate',
            displayName: 'Field',
            values: [
              {
                displayName: 'Input Field Name',
                name: 'fieldToAggregate',
                type: 'string',
                default: '',
                placeholder: 'e.g. email',
                noDataExpression: true,
              },
              { displayName: 'Rename Field', name: 'renameField', type: 'boolean', default: false },
              {
                displayName: 'Output Field Name',
                name: 'outputFieldName',
                type: 'string',
                default: '',
                displayOptions: { show: { renameField: [true] } },
              },
            ],
          },
        ],
      },
      {
        displayName: 'Put Output in Field',
        name: 'destinationFieldName',
        type: 'string',
        default: 'data',
        displayOptions: { show: { aggregate: ['aggregateAllItemData'] } },
      },
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        default: {},
        placeholder: 'Add option',
        options: [
          {
            displayName: 'Merge Lists',
            name: 'mergeLists',
            type: 'boolean',
            default: false,
            description: 'If the field values are lists, merge them into one flat list',
          },
          {
            displayName: 'Keep Missing And Null Values',
            name: 'keepMissing',
            type: 'boolean',
            default: false,
          },
        ],
      },
    ],
  },

  async execute(this: IExecuteFunctions) {
    const items = this.getInputData();
    const mode = this.getNodeParameter<string>('aggregate', 0);
    const mergeLists = this.getNodeParameter<boolean>('options.mergeLists', 0, false);
    const keepMissing = this.getNodeParameter<boolean>('options.keepMissing', 0, false);
    const pairedItem = items.map((_, index) => ({ item: index }));

    if (mode === 'aggregateAllItemData') {
      const field = this.getNodeParameter<string>('destinationFieldName', 0, 'data') || 'data';
      return [[{ json: { [field]: items.map((item) => item.json) }, pairedItem }]];
    }

    const fields = (
      this.getNodeParameter<{ fieldToAggregate?: FieldToAggregate[] }>('fieldsToAggregate', 0, {}).fieldToAggregate ?? []
    ).filter((f) => f.fieldToAggregate);
    if (fields.length === 0) {
      throw new NodeOperationError(this.getNode(), 'No field to aggregate specified', {
        description: 'Add at least one input field name',
      });
    }

    const json: IDataObject = {};
    for (const field of fields) {
      const output = field.renameField && field.outputFieldName ? field.outputFieldName : field.fieldToAggregate;
      const values: unknown[] = [];
      for (const item of items) {
        const value = getPath(item.json, field.fieldToAggregate);
        if ((value === undefined || value === null) && !keepMissing) continue;
        if (mergeLists && Array.isArray(value)) values.push(...value);
        else values.push(value ?? null);
      }
      json[output] = values;
    }
    if (items.length > 0 && Object.values(json).every((v) => (v as unknown[]).length === 0)) {
      this.addHint('None of the fields to aggregate were found in the input items. Check the field names.');
    }
    return [[{ json, pairedItem }]];
  },
};
