import {
  NodeOperationError,
  deepClone,
  getPath,
  isObject,
  setPath,
  type IDataObject,
  type IExecuteFunctions,
  type INodeExecutionData,
  type INodeType,
} from '@flowforge/workflow';

export const NoOp: INodeType = {
  description: {
    name: 'flowforge.noOp',
    displayName: 'No Operation, do nothing',
    icon: 'arrow-right',
    iconColor: '#b0b0b0',
    group: ['utility'],
    version: 1,
    description: 'Pass items through unchanged - useful as a placeholder or junction',
    defaults: { name: 'No Operation' },
    inputs: [{ type: 'main' }],
    outputs: [{ type: 'main' }],
    keywords: ['noop', 'nothing', 'pass', 'placeholder'],
    properties: [],
  },
  async execute(this: IExecuteFunctions) {
    return [this.getInputData()];
  },
};

export const Limit: INodeType = {
  description: {
    name: 'flowforge.limit',
    displayName: 'Limit',
    icon: 'list-end',
    iconColor: '#0891b2',
    group: ['transform'],
    version: 1,
    description: 'Keep only the first or last N items',
    defaults: { name: 'Limit' },
    inputs: [{ type: 'main' }],
    outputs: [{ type: 'main' }],
    keywords: ['top', 'first', 'last', 'take', 'slice'],
    properties: [
      { displayName: 'Max Items', name: 'maxItems', type: 'number', default: 1, typeOptions: { minValue: 1 } },
      {
        displayName: 'Keep',
        name: 'keep',
        type: 'options',
        default: 'firstItems',
        options: [
          { name: 'First Items', value: 'firstItems' },
          { name: 'Last Items', value: 'lastItems' },
        ],
      },
    ],
  },
  async execute(this: IExecuteFunctions) {
    const items = this.getInputData().map((item, index) => ({ ...item, pairedItem: { item: index } }));
    const max = Math.max(0, Math.floor(Number(this.getNodeParameter('maxItems', 0, 1))));
    const keep = this.getNodeParameter<string>('keep', 0, 'firstItems');
    return [keep === 'lastItems' ? items.slice(Math.max(0, items.length - max)) : items.slice(0, max)];
  },
};

export const SplitOut: INodeType = {
  description: {
    name: 'flowforge.splitOut',
    displayName: 'Split Out',
    icon: 'ungroup',
    iconColor: '#059669',
    group: ['transform'],
    version: 1,
    description: 'Turn a list inside an item into separate items',
    defaults: { name: 'Split Out' },
    inputs: [{ type: 'main' }],
    outputs: [{ type: 'main' }],
    keywords: ['explode', 'unwind', 'flatten', 'array', 'list', 'items'],
    properties: [
      {
        displayName: 'Field To Split Out',
        name: 'fieldToSplitOut',
        type: 'string',
        default: '',
        required: true,
        placeholder: 'e.g. orders',
        noDataExpression: true,
      },
      {
        displayName: 'Include',
        name: 'include',
        type: 'options',
        default: 'noOtherFields',
        options: [
          { name: 'No Other Fields', value: 'noOtherFields' },
          { name: 'All Other Fields', value: 'allOtherFields' },
        ],
      },
      {
        displayName: 'Destination Field Name',
        name: 'destinationFieldName',
        type: 'string',
        default: '',
        description: 'Defaults to the name of the field being split out',
      },
    ],
  },
  async execute(this: IExecuteFunctions) {
    const items = this.getInputData();
    const out: INodeExecutionData[] = [];
    items.forEach((item, i) => {
      const field = this.getNodeParameter<string>('fieldToSplitOut', i, '').trim();
      if (!field) throw new NodeOperationError(this.getNode(), '"Field To Split Out" is empty', { itemIndex: i });
      const include = this.getNodeParameter<string>('include', i, 'noOtherFields');
      const destination = this.getNodeParameter<string>('destinationFieldName', i, '') || field;
      const value = getPath(item.json, field);
      if (value === undefined) {
        throw new NodeOperationError(this.getNode(), `The field "${field}" wasn't found in item ${i}`, {
          itemIndex: i,
          description: 'Check the field name, or that the previous node outputs this field',
        });
      }
      const list = Array.isArray(value) ? value : isObject(value) ? Object.values(value) : [value];
      for (const entry of list) {
        let json: IDataObject = {};
        if (include === 'allOtherFields') json = deepClone(item.json);
        if (isObject(entry) && destination === field && include === 'noOtherFields') json = { ...entry };
        else setPath(json, destination, entry);
        out.push({ json, pairedItem: { item: i } });
      }
    });
    return [out];
  },
};

export const StopAndError: INodeType = {
  description: {
    name: 'flowforge.stopAndError',
    displayName: 'Stop and Error',
    icon: 'octagon-x',
    iconColor: '#dc2626',
    group: ['flow'],
    version: 1,
    description: 'Stop the workflow with an error (triggers the error workflow)',
    defaults: { name: 'Stop and Error' },
    inputs: [{ type: 'main' }],
    outputs: [],
    keywords: ['throw', 'fail', 'abort', 'exception'],
    properties: [
      {
        displayName: 'Error Type',
        name: 'errorType',
        type: 'options',
        default: 'errorMessage',
        options: [
          { name: 'Error Message', value: 'errorMessage' },
          { name: 'Error Object', value: 'errorObject' },
        ],
      },
      {
        displayName: 'Error Message',
        name: 'errorMessage',
        type: 'string',
        default: '',
        displayOptions: { show: { errorType: ['errorMessage'] } },
      },
      {
        displayName: 'Error Object',
        name: 'errorObject',
        type: 'json',
        default: '{\n  "code": "404",\n  "message": "Not found"\n}',
        typeOptions: { editor: 'json', rows: 5 },
        displayOptions: { show: { errorType: ['errorObject'] } },
      },
    ],
  },
  async execute(this: IExecuteFunctions) {
    const type = this.getNodeParameter<string>('errorType', 0, 'errorMessage');
    if (type === 'errorObject') {
      const raw = this.getNodeParameter<unknown>('errorObject', 0, '{}');
      let obj: IDataObject;
      try {
        obj = (typeof raw === 'string' ? JSON.parse(raw) : raw) as IDataObject;
      } catch {
        throw new NodeOperationError(this.getNode(), 'Error Object is not valid JSON');
      }
      throw new NodeOperationError(this.getNode(), String(obj.message ?? obj.description ?? 'Workflow stopped'), {
        context: obj,
      });
    }
    const message = this.getNodeParameter<string>('errorMessage', 0, '') || 'Workflow stopped by "Stop and Error" node';
    throw new NodeOperationError(this.getNode(), message);
  },
};

export const StickyNote: INodeType = {
  description: {
    name: 'flowforge.stickyNote',
    displayName: 'Sticky Note',
    icon: 'sticky-note',
    iconColor: '#facc15',
    group: ['annotation'],
    version: 1,
    description: 'Add notes to your canvas',
    defaults: { name: 'Sticky Note' },
    inputs: [],
    outputs: [],
    properties: [
      { displayName: 'Content', name: 'content', type: 'string', default: '## Note\nDouble-click to edit', typeOptions: { editor: 'markdown', rows: 6 } },
      {
        displayName: 'Color',
        name: 'color',
        type: 'options',
        default: 'yellow',
        options: ['yellow', 'blue', 'green', 'pink', 'purple', 'gray'].map((c) => ({ name: c, value: c })),
      },
    ],
  },
};
