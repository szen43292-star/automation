import {
  NodeOperationError,
  isObject,
  type CodeMode,
  type IExecuteFunctions,
  type INodeExecutionData,
  type INodeType,
} from '@flowforge/workflow';

const DEFAULT_CODE = `// Loop over input items and add a new field called 'myNewField' to each one
for (const item of $input.all()) {
  item.json.myNewField = 1;
}

return $input.all();`;

const RETURN_HINT =
  'Return an array of objects, one per item you want to output - e.g. return [{ json: { name: "Ada" } }] or return [{ name: "Ada" }]';

function toItem(
  ctx: IExecuteFunctions,
  value: unknown,
  index: number,
  pairedItem: number | undefined,
): INodeExecutionData {
  if (!isObject(value)) {
    throw new NodeOperationError(ctx.getNode(), `Code doesn't return items properly`, {
      description: `Item ${index} is ${value === null ? 'null' : Array.isArray(value) ? 'an array' : `a ${typeof value}`}. ${RETURN_HINT}`,
      itemIndex: index,
    });
  }
  const hasJsonKey = isObject(value.json);
  const extraKeys = Object.keys(value).filter((k) => !['json', 'binary', 'pairedItem'].includes(k));
  const item: INodeExecutionData =
    hasJsonKey && extraKeys.length === 0
      ? {
          json: value.json as INodeExecutionData['json'],
          ...(isObject(value.binary)
            ? { binary: value.binary as INodeExecutionData['binary'] }
            : {}),
        }
      : { json: value };
  if (pairedItem !== undefined) item.pairedItem = { item: pairedItem };
  else if (value.pairedItem !== undefined)
    item.pairedItem = value.pairedItem as INodeExecutionData['pairedItem'];
  return item;
}

export const Code: INodeType = {
  description: {
    name: 'flowforge.code',
    displayName: 'Code',
    icon: 'code',
    iconColor: '#ff9922',
    group: ['core', 'transform'],
    version: 1,
    description: 'Run custom JavaScript in a secure sandbox',
    subtitle: '={{ $parameter.mode }}',
    defaults: { name: 'Code' },
    inputs: [{ type: 'main' }],
    outputs: [{ type: 'main' }],
    keywords: ['javascript', 'js', 'script', 'function', 'custom'],
    properties: [
      {
        displayName: 'Mode',
        name: 'mode',
        type: 'options',
        default: 'runOnceForAllItems',
        noDataExpression: true,
        options: [
          {
            name: 'Run Once for All Items',
            value: 'runOnceForAllItems',
            description: 'Run the code once; use $input.all() to access every item',
          },
          {
            name: 'Run Once for Each Item',
            value: 'runOnceForEachItem',
            description: 'Run the code for every item; use $json for the current item',
          },
        ],
      },
      {
        displayName: 'JavaScript',
        name: 'jsCode',
        type: 'code',
        default: DEFAULT_CODE,
        noDataExpression: true,
        typeOptions: { editor: 'js', rows: 14 },
        hint: 'Available: $input.all() / first() / last(), $json & $itemIndex (each-item mode), $workflow, $execution, $vars, console.log()',
      },
    ],
  },

  async execute(this: IExecuteFunctions) {
    const items = this.getInputData();
    const mode = this.getNodeParameter<CodeMode>('mode', 0, 'runOnceForAllItems');
    const code = this.getNodeParameter<string>('jsCode', 0, '', { rawExpressions: true });

    let result: unknown;
    try {
      ({ items: result } = await this.helpers.runCode({ code, mode, items }));
    } catch (error) {
      if (error instanceof Error && error.name === 'CodeExecutionError') {
        const { itemIndex, lineNumber } = error as Error & {
          itemIndex?: number;
          lineNumber?: number;
        };
        throw new NodeOperationError(this.getNode(), error.message, {
          itemIndex,
          description:
            lineNumber !== undefined
              ? `Error in your code at line ${lineNumber}`
              : 'Error while running your code',
        });
      }
      throw error;
    }

    if (mode === 'runOnceForEachItem') {
      const results = result as unknown[];
      const out: INodeExecutionData[] = [];
      results.forEach((value, index) => {
        if (value === null || value === undefined) return;
        out.push(toItem(this, value, index, index));
      });
      return [out];
    }

    if (result === undefined || result === null) {
      throw new NodeOperationError(this.getNode(), 'Code returned nothing', {
        description: RETURN_HINT,
      });
    }
    const list = Array.isArray(result) ? result : [result];
    return [list.map((value, index) => toItem(this, value, index, undefined))];
  },
};
