import {
  NodeOperationError,
  deepClone,
  isObject,
  setPath,
  typeOf,
  type IDataObject,
  type IExecuteFunctions,
  type INodeExecutionData,
  type INodeType,
} from '@flowforge/workflow';
import { errorItem, wrapItemError } from '../shared/helpers';

export type AssignmentType = 'string' | 'number' | 'boolean' | 'array' | 'object';

export interface Assignment {
  id: string;
  name: string;
  value: unknown;
  type: AssignmentType;
}

function convert(value: unknown, type: AssignmentType, field: string, ignoreErrors: boolean): unknown {
  const fail = (): never => {
    throw new Error(`Value for field "${field}" (${JSON.stringify(value)}) cannot be converted to ${type}`);
  };
  try {
    switch (type) {
      case 'string':
        if (value === undefined || value === null) return '';
        return typeof value === 'object' ? JSON.stringify(value) : String(value);
      case 'number': {
        if (typeof value === 'number') return value;
        if (value === '' || value === null || value === undefined) return null;
        const n = Number(value);
        return Number.isNaN(n) ? fail() : n;
      }
      case 'boolean':
        if (typeof value === 'boolean') return value;
        if (value === 'true' || value === '1' || value === 1) return true;
        if (value === 'false' || value === '0' || value === 0 || value === '' || value == null) return false;
        return fail();
      case 'array':
        if (Array.isArray(value)) return value;
        if (typeof value === 'string') {
          const parsed: unknown = value.trim() === '' ? [] : JSON.parse(value);
          return Array.isArray(parsed) ? parsed : fail();
        }
        return fail();
      case 'object':
        if (isObject(value)) return value;
        if (typeof value === 'string') {
          const parsed: unknown = value.trim() === '' ? {} : JSON.parse(value);
          return isObject(parsed) ? parsed : fail();
        }
        return fail();
    }
  } catch (error) {
    if (ignoreErrors) return value;
    if (error instanceof SyntaxError) {
      throw new Error(`Value for field "${field}" is not valid JSON for type ${type}: ${error.message}`);
    }
    throw error;
  }
}

export const EditFields: INodeType = {
  description: {
    name: 'flowforge.set',
    displayName: 'Edit Fields (Set)',
    icon: 'pen-line',
    iconColor: '#0000ff',
    group: ['transform'],
    version: 1,
    description: 'Add, modify or remove item fields',
    subtitle: '={{ $parameter.mode }}',
    defaults: { name: 'Edit Fields' },
    inputs: [{ type: 'main' }],
    outputs: [{ type: 'main' }],
    keywords: ['set', 'assign', 'map', 'rename', 'fields', 'transform'],
    properties: [
      {
        displayName: 'Mode',
        name: 'mode',
        type: 'options',
        default: 'manual',
        noDataExpression: true,
        options: [
          { name: 'Manual Mapping', value: 'manual', description: 'Edit fields one by one' },
          { name: 'JSON', value: 'raw', description: 'Write the output object as JSON' },
        ],
      },
      {
        displayName: 'Fields to Set',
        name: 'assignments',
        type: 'assignmentCollection',
        default: { assignments: [] },
        displayOptions: { show: { mode: ['manual'] } },
      },
      {
        displayName: 'JSON Output',
        name: 'jsonOutput',
        type: 'json',
        default: '{\n  "my_field_1": "value",\n  "my_field_2": 1\n}',
        typeOptions: { rows: 8, editor: 'json' },
        displayOptions: { show: { mode: ['raw'] } },
      },
      {
        displayName: 'Include Other Input Fields',
        name: 'includeOtherFields',
        type: 'boolean',
        default: false,
        description: 'Whether to pass all input fields through (along with the fields set above)',
      },
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        default: {},
        placeholder: 'Add option',
        options: [
          {
            displayName: 'Support Dot Notation',
            name: 'dotNotation',
            type: 'boolean',
            default: true,
            description: 'Treat "a.b" as nested field b inside a, instead of a field literally named "a.b"',
          },
          {
            displayName: 'Ignore Type Conversion Errors',
            name: 'ignoreConversionErrors',
            type: 'boolean',
            default: false,
          },
        ],
      },
    ],
  },

  async execute(this: IExecuteFunctions) {
    const items = this.getInputData();
    const out: INodeExecutionData[] = [];
    const mode = this.getNodeParameter<string>('mode', 0, 'manual');

    for (let i = 0; i < items.length; i++) {
      const item = items[i]!;
      try {
        const includeOther = this.getNodeParameter<boolean>('includeOtherFields', i, false);
        const dotNotation = this.getNodeParameter<boolean>('options.dotNotation', i, true);
        const ignoreErrors = this.getNodeParameter<boolean>('options.ignoreConversionErrors', i, false);
        const json: IDataObject = includeOther ? deepClone(item.json) : {};

        if (mode === 'raw') {
          const raw = this.getNodeParameter<unknown>('jsonOutput', i, '{}');
          let parsed: unknown = raw;
          if (typeof raw === 'string') {
            try {
              parsed = JSON.parse(raw);
            } catch (error) {
              throw new NodeOperationError(this.getNode(), "'JSON Output' does not contain a valid JSON object", {
                itemIndex: i,
                description: (error as Error).message,
              });
            }
          }
          if (!isObject(parsed)) {
            throw new NodeOperationError(this.getNode(), `'JSON Output' must be an object, got ${typeOf(parsed)}`, {
              itemIndex: i,
            });
          }
          Object.assign(json, parsed);
        } else {
          const { assignments = [] } = this.getNodeParameter<{ assignments?: Assignment[] }>('assignments', i, {});
          for (const assignment of assignments) {
            if (!assignment.name) continue;
            const value = convert(assignment.value, assignment.type ?? 'string', assignment.name, ignoreErrors);
            if (dotNotation) setPath(json, assignment.name, value);
            else json[assignment.name] = value;
          }
        }

        out.push({
          json,
          ...(includeOther && item.binary ? { binary: item.binary } : {}),
          pairedItem: { item: i },
        });
      } catch (error) {
        if (this.continueOnFail()) {
          out.push(errorItem(this, error, i, item));
          continue;
        }
        throw wrapItemError(this, error, i);
      }
    }
    return [out];
  },
};
