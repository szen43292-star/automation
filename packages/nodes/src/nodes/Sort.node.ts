import {
  NodeOperationError,
  getPath,
  type IExecuteFunctions,
  type INodeExecutionData,
  type INodeType,
} from '@flowforge/workflow';

interface SortField {
  fieldName: string;
  order: 'ascending' | 'descending';
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export function compareValues(a: unknown, b: unknown): number {
  const aMissing = a === undefined || a === null;
  const bMissing = b === undefined || b === null;
  if (aMissing || bMissing) return aMissing === bMissing ? 0 : aMissing ? 1 : -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
  const aText = typeof a === 'object' ? JSON.stringify(a) : String(a);
  const bText = typeof b === 'object' ? JSON.stringify(b) : String(b);
  return collator.compare(aText, bText);
}

export const Sort: INodeType = {
  description: {
    name: 'flowforge.sort',
    displayName: 'Sort',
    icon: 'arrow-down-wide-narrow',
    iconColor: '#7c3aed',
    group: ['transform'],
    version: 1,
    description: 'Change the order of items',
    defaults: { name: 'Sort' },
    inputs: [{ type: 'main' }],
    outputs: [{ type: 'main' }],
    keywords: ['order', 'order by', 'arrange', 'shuffle', 'random'],
    properties: [
      {
        displayName: 'Type',
        name: 'type',
        type: 'options',
        default: 'simple',
        options: [
          { name: 'Simple', value: 'simple' },
          { name: 'Random', value: 'random' },
        ],
      },
      {
        displayName: 'Fields To Sort By',
        name: 'sortFieldsUi',
        type: 'fixedCollection',
        typeOptions: { multipleValues: true, sortable: true },
        default: { sortField: [{ fieldName: '', order: 'ascending' }] },
        displayOptions: { show: { type: ['simple'] } },
        options: [
          {
            name: 'sortField',
            displayName: 'Field To Sort By',
            values: [
              {
                displayName: 'Field Name',
                name: 'fieldName',
                type: 'string',
                default: '',
                placeholder: 'e.g. createdAt or customer.name',
                noDataExpression: true,
              },
              {
                displayName: 'Order',
                name: 'order',
                type: 'options',
                default: 'ascending',
                options: [
                  { name: 'Ascending', value: 'ascending' },
                  { name: 'Descending', value: 'descending' },
                ],
              },
            ],
          },
        ],
      },
    ],
  },

  async execute(this: IExecuteFunctions) {
    const items = this.getInputData().map((item, index) => ({ ...item, pairedItem: { item: index } }));
    const type = this.getNodeParameter<string>('type', 0, 'simple');

    if (type === 'random') {
      for (let i = items.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [items[i], items[j]] = [items[j]!, items[i]!];
      }
      return [items];
    }

    const fields = (
      this.getNodeParameter<{ sortField?: SortField[] }>('sortFieldsUi', 0, {}).sortField ?? []
    ).filter((f) => f.fieldName);
    if (fields.length === 0) {
      throw new NodeOperationError(this.getNode(), 'No sort field specified', {
        description: 'Add at least one field to sort by',
      });
    }
    const sorted: INodeExecutionData[] = [...items].sort((a, b) => {
      for (const field of fields) {
        const result = compareValues(getPath(a.json, field.fieldName), getPath(b.json, field.fieldName));
        if (result !== 0) {
          const missing = [getPath(a.json, field.fieldName), getPath(b.json, field.fieldName)].some(
            (v) => v === undefined || v === null,
          );
          // Missing values always sort last, regardless of direction.
          return field.order === 'descending' && !missing ? -result : result;
        }
      }
      return 0;
    });
    return [sorted];
  },
};
