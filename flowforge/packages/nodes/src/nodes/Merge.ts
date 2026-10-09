import {
  NodeOperationError,
  deepClone,
  getPath,
  isObject,
  type IDataObject,
  type IExecuteFunctions,
  type INodeExecutionData,
  type INodeType,
} from '@flowforge/workflow';

interface FieldPair {
  field1: string;
  field2: string;
}

type JoinMode =
  'keepMatches' | 'keepNonMatches' | 'keepEverything' | 'enrichInput1' | 'enrichInput2';

function deepMerge(target: IDataObject, source: IDataObject): IDataObject {
  const out: IDataObject = { ...target };
  for (const [key, value] of Object.entries(source)) {
    out[key] =
      isObject(value) && isObject(out[key]) ? deepMerge(out[key] as IDataObject, value) : value;
  }
  return out;
}

function keyOf(json: IDataObject, fields: string[], fuzzy: boolean): string {
  return JSON.stringify(
    fields.map((f) => {
      const v = getPath(json, f);
      return fuzzy && v !== undefined && v !== null ? String(v).trim().toLowerCase() : v;
    }),
  );
}

export const Merge: INodeType = {
  description: {
    name: 'flowforge.merge',
    displayName: 'Merge',
    icon: 'merge',
    iconColor: '#00bbcc',
    group: ['flow'],
    version: 1,
    description: 'Combine data from two branches: append, match by fields, or by position',
    subtitle: '={{ $parameter.mode }}',
    defaults: { name: 'Merge' },
    inputs: [
      { type: 'main', displayName: 'Input 1' },
      { type: 'main', displayName: 'Input 2' },
    ],
    outputs: [{ type: 'main' }],
    keywords: ['join', 'combine', 'concatenate', 'append', 'wait', 'zip', 'enrich'],
    properties: [
      {
        displayName: 'Mode',
        name: 'mode',
        type: 'options',
        default: 'append',
        noDataExpression: true,
        options: [
          {
            name: 'Append',
            value: 'append',
            description: 'Output items of input 1, then items of input 2',
          },
          {
            name: 'Combine by Matching Fields',
            value: 'combineByFields',
            description: 'Join items whose fields match (like SQL JOIN)',
          },
          {
            name: 'Combine by Position',
            value: 'combineByPosition',
            description: 'Merge item 1 with item 1, item 2 with item 2, …',
          },
          {
            name: 'Choose Branch',
            value: 'chooseBranch',
            description: 'Wait for both inputs, then output one of them',
          },
        ],
      },
      {
        displayName: 'Fields to Match',
        name: 'fieldsToMatch',
        type: 'fixedCollection',
        typeOptions: { multipleValues: true },
        default: { values: [{ field1: '', field2: '' }] },
        displayOptions: { show: { mode: ['combineByFields'] } },
        options: [
          {
            name: 'values',
            displayName: 'Fields',
            values: [
              {
                displayName: 'Input 1 Field',
                name: 'field1',
                type: 'string',
                default: '',
                placeholder: 'e.g. phone',
                noDataExpression: true,
              },
              {
                displayName: 'Input 2 Field',
                name: 'field2',
                type: 'string',
                default: '',
                placeholder: 'e.g. customer.phone',
                noDataExpression: true,
              },
            ],
          },
        ],
      },
      {
        displayName: 'Output Type',
        name: 'joinMode',
        type: 'options',
        default: 'keepMatches',
        displayOptions: { show: { mode: ['combineByFields'] } },
        options: [
          { name: 'Keep Matches (inner join)', value: 'keepMatches' },
          { name: 'Keep Non-Matches', value: 'keepNonMatches' },
          { name: 'Keep Everything (outer join)', value: 'keepEverything' },
          { name: 'Enrich Input 1 (left join)', value: 'enrichInput1' },
          { name: 'Enrich Input 2 (right join)', value: 'enrichInput2' },
        ],
      },
      {
        displayName: 'Output',
        name: 'chooseBranch',
        type: 'options',
        default: 'input1',
        displayOptions: { show: { mode: ['chooseBranch'] } },
        options: [
          { name: 'Input 1 Data', value: 'input1' },
          { name: 'Input 2 Data', value: 'input2' },
          { name: 'A Single, Empty Item', value: 'empty' },
        ],
      },
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        default: {},
        placeholder: 'Add option',
        options: [
          {
            displayName: 'When Field Values Clash',
            name: 'clashHandling',
            type: 'options',
            default: 'preferInput2',
            options: [
              { name: 'Prefer Input 2 Version', value: 'preferInput2' },
              { name: 'Prefer Input 1 Version', value: 'preferInput1' },
            ],
          },
          {
            displayName: 'Fuzzy Compare',
            name: 'fuzzyCompare',
            type: 'boolean',
            default: false,
            description: 'Compare values as trimmed, case-insensitive strings (so 5 matches "5")',
          },
          {
            displayName: 'Include Unpaired Items',
            name: 'includeUnpaired',
            type: 'boolean',
            default: false,
            description: 'Combine by position: keep items that have no partner in the other input',
          },
        ],
      },
    ],
  },

  async execute(this: IExecuteFunctions) {
    const input1 = this.getInputData(0);
    const input2 = this.getInputData(1);
    const mode = this.getNodeParameter<string>('mode', 0);
    const preferInput1 =
      this.getNodeParameter<string>('options.clashHandling', 0, 'preferInput2') === 'preferInput1';
    const combine = (
      a: INodeExecutionData | undefined,
      b: INodeExecutionData | undefined,
      ia?: number,
      ib?: number,
    ): INodeExecutionData => {
      const json = !a
        ? deepClone(b!.json)
        : !b
          ? deepClone(a.json)
          : preferInput1
            ? deepMerge(b.json, a.json)
            : deepMerge(a.json, b.json);
      const pairedItem = [
        ...(ia !== undefined ? [{ item: ia, input: 0 }] : []),
        ...(ib !== undefined ? [{ item: ib, input: 1 }] : []),
      ];
      return {
        json,
        ...(a?.binary || b?.binary
          ? { binary: { ...(a?.binary ?? {}), ...(b?.binary ?? {}) } }
          : {}),
        pairedItem,
      };
    };

    switch (mode) {
      case 'append':
        return [
          [
            ...input1.map((item, i) => ({ ...item, pairedItem: { item: i, input: 0 } })),
            ...input2.map((item, i) => ({ ...item, pairedItem: { item: i, input: 1 } })),
          ],
        ];

      case 'chooseBranch': {
        const choice = this.getNodeParameter<string>('chooseBranch', 0, 'input1');
        if (choice === 'empty') return [[{ json: {} }]];
        const items = choice === 'input2' ? input2 : input1;
        return [
          items.map((item, i) => ({
            ...item,
            pairedItem: { item: i, input: choice === 'input2' ? 1 : 0 },
          })),
        ];
      }

      case 'combineByPosition': {
        const includeUnpaired = this.getNodeParameter<boolean>('options.includeUnpaired', 0, false);
        const length = includeUnpaired
          ? Math.max(input1.length, input2.length)
          : Math.min(input1.length, input2.length);
        return [
          Array.from({ length }, (_, i) =>
            combine(input1[i], input2[i], input1[i] ? i : undefined, input2[i] ? i : undefined),
          ),
        ];
      }

      case 'combineByFields': {
        const pairs = (
          this.getNodeParameter<{ values?: FieldPair[] }>('fieldsToMatch', 0, {}).values ?? []
        ).filter((p) => p.field1 && p.field2);
        if (!pairs.length) {
          throw new NodeOperationError(this.getNode(), 'No fields to match specified', {
            description: 'Add at least one pair of fields to compare',
          });
        }
        const fuzzy = this.getNodeParameter<boolean>('options.fuzzyCompare', 0, false);
        const joinMode = this.getNodeParameter<JoinMode>('joinMode', 0, 'keepMatches');
        const fields1 = pairs.map((p) => p.field1);
        const fields2 = pairs.map((p) => p.field2);

        const index2 = new Map<string, number[]>();
        input2.forEach((item, i) => {
          const key = keyOf(item.json, fields2, fuzzy);
          index2.set(key, [...(index2.get(key) ?? []), i]);
        });
        const matched2 = new Set<number>();
        const out: INodeExecutionData[] = [];
        input1.forEach((item, i) => {
          const matches = index2.get(keyOf(item.json, fields1, fuzzy)) ?? [];
          matches.forEach((j) => matched2.add(j));
          if (matches.length) {
            if (joinMode === 'keepNonMatches') return;
            if (joinMode === 'enrichInput2') return; // handled below
            for (const j of matches) out.push(combine(item, input2[j], i, j));
          } else if (
            joinMode === 'keepNonMatches' ||
            joinMode === 'keepEverything' ||
            joinMode === 'enrichInput1'
          ) {
            out.push(combine(item, undefined, i));
          }
        });
        if (joinMode === 'enrichInput2') {
          input2.forEach((item, j) => {
            const partners = input1
              .map((a, i) => ({ a, i }))
              .filter(
                ({ a }) => keyOf(a.json, fields1, fuzzy) === keyOf(item.json, fields2, fuzzy),
              );
            if (partners.length) partners.forEach(({ a, i }) => out.push(combine(a, item, i, j)));
            else out.push(combine(undefined, item, undefined, j));
          });
        }
        if (joinMode === 'keepNonMatches' || joinMode === 'keepEverything') {
          input2.forEach((item, j) => {
            if (!matched2.has(j)) out.push(combine(undefined, item, undefined, j));
          });
        }
        return [out];
      }
      default:
        throw new NodeOperationError(this.getNode(), `Unknown mode "${mode}"`);
    }
  },
};
