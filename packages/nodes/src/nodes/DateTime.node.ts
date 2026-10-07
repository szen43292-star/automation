import { DateTime as Luxon, type DurationUnit } from 'luxon';
import {
  NodeOperationError,
  deepClone,
  setPath,
  type IDataObject,
  type IExecuteFunctions,
  type INodeExecutionData,
  type INodeType,
} from '@flowforge/workflow';
import { errorItem, parseDate, wrapItemError } from '../shared/helpers';

const UNITS = [
  { name: 'Years', value: 'years' },
  { name: 'Quarters', value: 'quarters' },
  { name: 'Months', value: 'months' },
  { name: 'Weeks', value: 'weeks' },
  { name: 'Days', value: 'days' },
  { name: 'Hours', value: 'hours' },
  { name: 'Minutes', value: 'minutes' },
  { name: 'Seconds', value: 'seconds' },
  { name: 'Milliseconds', value: 'milliseconds' },
];

const PARTS = ['year', 'month', 'week', 'day', 'hour', 'minute', 'second'] as const;

const FORMATS = [
  { name: 'ISO 8601 (2025-01-31T14:30:00.000+05:30)', value: 'iso' },
  { name: 'Date only (2025-01-31)', value: 'yyyy-MM-dd' },
  { name: 'Day/Month/Year (31/01/2025)', value: 'dd/MM/yyyy' },
  { name: 'Month/Day/Year (01/31/2025)', value: 'MM/dd/yyyy' },
  { name: 'Readable (Jan 31, 2025, 2:30 PM)', value: 'ff' },
  { name: 'Time (14:30)', value: 'HH:mm' },
  { name: 'Unix Timestamp (seconds)', value: 'X' },
  { name: 'Unix Timestamp (milliseconds)', value: 'x' },
  { name: 'Custom Format', value: 'custom' },
];

const show = (...operations: string[]) => ({ show: { operation: operations } });

export const DateTimeNode: INodeType = {
  description: {
    name: 'flowforge.dateTime',
    displayName: 'Date & Time',
    icon: 'calendar-clock',
    iconColor: '#d97706',
    group: ['transform'],
    version: 1,
    description: 'Get, format, shift and compare dates',
    subtitle: '={{ $parameter.operation }}',
    defaults: { name: 'Date & Time' },
    inputs: [{ type: 'main' }],
    outputs: [{ type: 'main' }],
    keywords: ['time', 'date', 'timezone', 'format', 'duration', 'now'],
    properties: [
      {
        displayName: 'Operation',
        name: 'operation',
        type: 'options',
        default: 'getCurrentDate',
        noDataExpression: true,
        options: [
          { name: 'Get Current Date', value: 'getCurrentDate' },
          { name: 'Add to a Date', value: 'addToDate' },
          { name: 'Subtract From a Date', value: 'subtractFromDate' },
          { name: 'Format a Date', value: 'formatDate' },
          { name: 'Get Time Between Dates', value: 'getTimeBetweenDates' },
          { name: 'Extract Part of a Date', value: 'extractDate' },
          { name: 'Round a Date', value: 'roundDate' },
        ],
      },
      {
        displayName: 'Include Current Time',
        name: 'includeTime',
        type: 'boolean',
        default: true,
        displayOptions: show('getCurrentDate'),
      },
      {
        displayName: 'Date',
        name: 'magnitude',
        type: 'string',
        default: '',
        placeholder: '={{ $json.createdAt }}',
        displayOptions: show('addToDate', 'subtractFromDate', 'formatDate', 'extractDate', 'roundDate'),
      },
      {
        displayName: 'Time Unit',
        name: 'timeUnit',
        type: 'options',
        default: 'days',
        options: UNITS,
        displayOptions: show('addToDate', 'subtractFromDate'),
      },
      {
        displayName: 'Duration',
        name: 'duration',
        type: 'number',
        default: 1,
        displayOptions: show('addToDate', 'subtractFromDate'),
      },
      {
        displayName: 'Format',
        name: 'format',
        type: 'options',
        default: 'iso',
        options: FORMATS,
        displayOptions: show('formatDate'),
      },
      {
        displayName: 'Custom Format',
        name: 'customFormat',
        type: 'string',
        default: 'yyyy-MM-dd HH:mm',
        hint: 'Luxon tokens, e.g. dd LLL yyyy → 31 Jan 2025',
        displayOptions: { show: { operation: ['formatDate'], format: ['custom'] } },
      },
      { displayName: 'Start Date', name: 'startDate', type: 'string', default: '', displayOptions: show('getTimeBetweenDates') },
      { displayName: 'End Date', name: 'endDate', type: 'string', default: '', displayOptions: show('getTimeBetweenDates') },
      {
        displayName: 'Units',
        name: 'units',
        type: 'multiOptions',
        default: ['days'],
        options: UNITS,
        displayOptions: show('getTimeBetweenDates'),
      },
      {
        displayName: 'Part',
        name: 'part',
        type: 'options',
        default: 'month',
        options: PARTS.map((p) => ({ name: p[0]!.toUpperCase() + p.slice(1), value: p })),
        displayOptions: show('extractDate'),
      },
      {
        displayName: 'Mode',
        name: 'roundMode',
        type: 'options',
        default: 'roundDown',
        options: [
          { name: 'Round Down', value: 'roundDown' },
          { name: 'Round Up', value: 'roundUp' },
        ],
        displayOptions: show('roundDate'),
      },
      {
        displayName: 'To Nearest',
        name: 'toNearest',
        type: 'options',
        default: 'day',
        options: PARTS.map((p) => ({ name: p[0]!.toUpperCase() + p.slice(1), value: p })),
        displayOptions: show('roundDate'),
      },
      {
        displayName: 'Output Field Name',
        name: 'outputFieldName',
        type: 'string',
        default: 'date',
      },
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        default: {},
        placeholder: 'Add option',
        options: [
          {
            displayName: 'Timezone',
            name: 'timezone',
            type: 'string',
            default: '',
            placeholder: 'Asia/Kolkata',
            description: 'Defaults to the workflow timezone',
          },
          { displayName: 'Include Input Fields', name: 'includeInputFields', type: 'boolean', default: true },
        ],
      },
    ],
  },

  async execute(this: IExecuteFunctions) {
    const items = this.getInputData();
    const out: INodeExecutionData[] = [];

    for (let i = 0; i < items.length; i++) {
      const item = items[i]!;
      try {
        const operation = this.getNodeParameter<string>('operation', i);
        const zone = this.getNodeParameter<string>('options.timezone', i, '') || this.getTimezone();
        if (!Luxon.now().setZone(zone).isValid) {
          throw new NodeOperationError(this.getNode(), `Unknown timezone "${zone}"`, { itemIndex: i });
        }
        const includeInput = this.getNodeParameter<boolean>('options.includeInputFields', i, true);
        const field = this.getNodeParameter<string>('outputFieldName', i, 'date') || 'date';

        const readDate = (name: string): Luxon => {
          const raw = this.getNodeParameter<unknown>(name, i, '');
          const parsed = parseDate(raw, zone);
          if (!parsed || !parsed.isValid) {
            throw new NodeOperationError(this.getNode(), `"${String(raw)}" is not a valid date`, {
              itemIndex: i,
              description: 'Use an ISO 8601 string (2025-01-31T10:00:00Z), a Unix timestamp or an expression',
            });
          }
          return parsed;
        };

        let value: unknown;
        switch (operation) {
          case 'getCurrentDate': {
            const now = Luxon.now().setZone(zone);
            value = this.getNodeParameter<boolean>('includeTime', i, true) ? now.toISO() : now.toISODate();
            break;
          }
          case 'addToDate':
          case 'subtractFromDate': {
            const unit = this.getNodeParameter<DurationUnit>('timeUnit', i);
            const amount = Number(this.getNodeParameter('duration', i, 0));
            const date = readDate('magnitude');
            value = (operation === 'addToDate' ? date.plus({ [unit]: amount }) : date.minus({ [unit]: amount })).toISO();
            break;
          }
          case 'formatDate': {
            const date = readDate('magnitude');
            let format = this.getNodeParameter<string>('format', i, 'iso');
            if (format === 'custom') format = this.getNodeParameter<string>('customFormat', i, 'yyyy-MM-dd');
            if (format === 'iso') value = date.toISO();
            else if (format === 'X') value = Math.floor(date.toSeconds());
            else if (format === 'x') value = date.toMillis();
            else value = date.toFormat(format);
            break;
          }
          case 'getTimeBetweenDates': {
            const start = readDate('startDate');
            const end = readDate('endDate');
            const units = this.getNodeParameter<DurationUnit[]>('units', i, ['days']);
            value = end.diff(start, units.length ? units : ['days']).toObject();
            break;
          }
          case 'extractDate': {
            const date = readDate('magnitude');
            const part = this.getNodeParameter<(typeof PARTS)[number]>('part', i);
            value = part === 'week' ? date.weekNumber : date[part];
            break;
          }
          case 'roundDate': {
            const date = readDate('magnitude');
            const unit = this.getNodeParameter<(typeof PARTS)[number]>('toNearest', i);
            const mode = this.getNodeParameter<string>('roundMode', i, 'roundDown');
            const down = date.startOf(unit);
            value = (mode === 'roundUp' && down.toMillis() !== date.toMillis() ? date.endOf(unit).plus({ milliseconds: 1 }) : down).toISO();
            break;
          }
          default:
            throw new NodeOperationError(this.getNode(), `Unknown operation "${operation}"`, { itemIndex: i });
        }

        const json: IDataObject = includeInput ? deepClone(item.json) : {};
        setPath(json, field, value);
        out.push({ json, pairedItem: { item: i } });
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
