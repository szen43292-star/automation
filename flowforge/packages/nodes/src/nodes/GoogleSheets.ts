import {
  NodeOperationError,
  type IDataObject,
  type IExecuteFunctions,
  type INodeExecutionData,
  type INodeType,
} from '@flowforge/workflow';
import { errorItem } from '../shared/helpers';
import { googleJson, toList } from '../shared/google';

const CREDENTIAL = 'googleSheetsOAuth2Api';
const API = 'https://sheets.googleapis.com/v4/spreadsheets';

/** The spreadsheet ID from an ID or a docs.google.com/spreadsheets/d/<id>/... link. */
export function spreadsheetId(value: string): string {
  const fromUrl = value.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return (fromUrl?.[1] ?? value).trim();
}

/** A sheet name as an A1 range ('My sheet'), optionally followed by a cell range. */
function a1(sheet: string, cells = ''): string {
  return `'${sheet.replace(/'/g, "''")}'${cells ? `!${cells}` : ''}`;
}

function cell(value: unknown): string | number | boolean {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export const GoogleSheets: INodeType = {
  description: {
    name: 'flowforge.googleSheets',
    displayName: 'Google Sheets',
    icon: 'sheet',
    iconColor: '#0f9d58',
    group: ['apps'],
    version: 1,
    description: 'Read rows from and append rows to a Google Sheets spreadsheet',
    subtitle: '={{ $parameter.operation === "append" ? "Append row" : "Get rows" }}',
    defaults: { name: 'Google Sheets' },
    inputs: [{ type: 'main' }],
    outputs: [{ type: 'main' }],
    keywords: ['google', 'sheets', 'spreadsheet', 'excel', 'table', 'rows', 'log'],
    credentials: [{ name: CREDENTIAL, required: true }],
    properties: [
      {
        displayName: 'Operation',
        name: 'operation',
        type: 'options',
        default: 'read',
        noDataExpression: true,
        options: [
          { name: 'Get Row(s)', value: 'read', description: 'Rows of a sheet as items' },
          { name: 'Append Row', value: 'append', description: 'Add a row at the end' },
        ],
      },
      {
        displayName: 'Spreadsheet (ID or URL)',
        name: 'documentId',
        type: 'string',
        default: '',
        required: true,
        placeholder: 'https://docs.google.com/spreadsheets/d/1AbC.../edit',
        description: 'Paste the link of the spreadsheet, or just its ID',
      },
      {
        displayName: 'Sheet Name',
        name: 'sheetName',
        type: 'string',
        default: 'Sheet1',
        required: true,
        description:
          'The tab at the bottom of the spreadsheet. The first row holds the column names.',
      },
      {
        displayName: 'Columns to Return',
        name: 'returnColumns',
        type: 'string',
        default: '',
        placeholder: 'title, date',
        description: 'Comma-separated column names (empty = all columns)',
        displayOptions: { show: { operation: ['read'] } },
      },
      {
        displayName: 'Columns',
        name: 'columnsMode',
        type: 'options',
        default: 'defineBelow',
        noDataExpression: true,
        displayOptions: { show: { operation: ['append'] } },
        options: [
          { name: 'Map Each Column Below', value: 'defineBelow' },
          {
            name: 'Map Automatically',
            value: 'autoMapInputData',
            description: 'Each input field goes into the column of the same name',
          },
        ],
      },
      {
        displayName: 'Values',
        name: 'fieldsUi',
        type: 'fixedCollection',
        typeOptions: { multipleValues: true },
        default: { values: [{ column: '', value: '' }] },
        displayOptions: { show: { operation: ['append'], columnsMode: ['defineBelow'] } },
        options: [
          {
            name: 'values',
            displayName: 'Column',
            values: [
              { displayName: 'Column', name: 'column', type: 'string', default: '' },
              { displayName: 'Value', name: 'value', type: 'string', default: '' },
            ],
          },
        ],
      },
      {
        displayName:
          'Columns that are not in the first row yet are added to it, so an empty sheet gets its column names from the first append.',
        name: 'appendNotice',
        type: 'notice',
        default: '',
        displayOptions: { show: { operation: ['append'] } },
      },
    ],
  },

  async execute(this: IExecuteFunctions) {
    const items = this.getInputData();
    const operation = this.getNodeParameter<string>('operation', 0);
    const output: INodeExecutionData[] = [];

    if (operation === 'append') {
      // One header check and one append call for all items of a sheet.
      const groups = new Map<
        string,
        { id: string; sheet: string; rows: number[]; values: IDataObject[] }
      >();
      for (let i = 0; i < items.length; i++) {
        try {
          const id = spreadsheetId(String(this.getNodeParameter('documentId', i) ?? ''));
          const sheet = String(this.getNodeParameter('sheetName', i) ?? '').trim();
          if (!id || !sheet)
            throw new NodeOperationError(
              this.getNode(),
              'Choose the spreadsheet and the sheet name',
              {
                itemIndex: i,
              },
            );
          const mode = this.getNodeParameter<string>('columnsMode', i, 'defineBelow');
          const values: IDataObject = {};
          if (mode === 'autoMapInputData') Object.assign(values, items[i]!.json);
          else {
            const pairs =
              this.getNodeParameter<{ values?: Array<{ column: string; value: unknown }> }>(
                'fieldsUi',
                i,
                {},
              ).values ?? [];
            for (const { column, value } of pairs) {
              if (String(column ?? '').trim())
                values[String(column).trim()] = value as IDataObject[keyof IDataObject];
            }
          }
          const key = `${id}\u0000${sheet}`;
          const group = groups.get(key) ?? { id, sheet, rows: [], values: [] };
          group.rows.push(i);
          group.values.push(values);
          groups.set(key, group);
        } catch (error) {
          if (this.continueOnFail()) {
            output.push(errorItem(this, error, i, items[i]));
            continue;
          }
          throw error;
        }
      }
      for (const group of groups.values()) {
        try {
          const base = `${API}/${encodeURIComponent(group.id)}/values`;
          const top = await googleJson(
            this,
            CREDENTIAL,
            { url: `${base}/${encodeURIComponent(a1(group.sheet, '1:1'))}`, method: 'GET' },
            group.rows[0]!,
          );
          const header = ((top.values as unknown[][] | undefined)?.[0] ?? []).map((v) =>
            String(v ?? '').trim(),
          );
          const missing = [...new Set(group.values.flatMap((v) => Object.keys(v)))].filter(
            (column) => !header.includes(column),
          );
          if (missing.length) {
            header.push(...missing);
            await googleJson(
              this,
              CREDENTIAL,
              {
                url: `${base}/${encodeURIComponent(a1(group.sheet, '1:1'))}`,
                method: 'PUT',
                qs: { valueInputOption: 'RAW' },
                body: { values: [header] },
              },
              group.rows[0]!,
            );
          }
          await googleJson(
            this,
            CREDENTIAL,
            {
              url: `${base}/${encodeURIComponent(a1(group.sheet))}:append`,
              method: 'POST',
              qs: { valueInputOption: 'USER_ENTERED', insertDataOption: 'INSERT_ROWS' },
              body: { values: group.values.map((v) => header.map((column) => cell(v[column]))) },
            },
            group.rows[0]!,
          );
          group.rows.forEach((itemIndex, n) =>
            output.push({ json: group.values[n]!, pairedItem: { item: itemIndex } }),
          );
        } catch (error) {
          if (this.continueOnFail()) {
            for (const itemIndex of group.rows)
              output.push(errorItem(this, error, itemIndex, items[itemIndex]));
            continue;
          }
          throw error;
        }
      }
      return [output];
    }

    for (let i = 0; i < items.length; i++) {
      try {
        const id = spreadsheetId(String(this.getNodeParameter('documentId', i) ?? ''));
        const sheet = String(this.getNodeParameter('sheetName', i) ?? '').trim();
        if (!id || !sheet)
          throw new NodeOperationError(
            this.getNode(),
            'Choose the spreadsheet and the sheet name',
            {
              itemIndex: i,
            },
          );
        const keep = toList(this.getNodeParameter('returnColumns', i, ''));
        const data = await googleJson(
          this,
          CREDENTIAL,
          {
            url: `${API}/${encodeURIComponent(id)}/values/${encodeURIComponent(a1(sheet))}`,
            method: 'GET',
            qs: { majorDimension: 'ROWS', valueRenderOption: 'FORMATTED_VALUE' },
          },
          i,
        );
        const [header = [], ...rows] = (data.values as unknown[][] | undefined) ?? [];
        const columns = header.map((v) => String(v ?? '').trim());
        rows.forEach((row, r) => {
          if (!row.some((v) => String(v ?? '') !== '')) return;
          const json: IDataObject = { row_number: r + 2 };
          columns.forEach((column, c) => {
            if (!column || (keep.length && !keep.includes(column))) return;
            json[column] = (row[c] ?? '') as string;
          });
          output.push({ json, pairedItem: { item: i } });
        });
      } catch (error) {
        if (this.continueOnFail()) {
          output.push(errorItem(this, error, i, items[i]));
          continue;
        }
        throw error;
      }
    }
    return [output];
  },
};
