import { DateTime } from 'luxon';
import type { IExecuteFunctions, INodeParameters, INodeType } from '@flowforge/workflow';

interface Rule {
  field: 'seconds' | 'minutes' | 'hours' | 'days' | 'weeks' | 'months' | 'cronExpression';
  secondsInterval?: number;
  minutesInterval?: number;
  hoursInterval?: number;
  daysInterval?: number;
  monthsInterval?: number;
  triggerAtDay?: number[];
  triggerAtDayOfMonth?: number;
  triggerAtHour?: number;
  triggerAtMinute?: number;
  expression?: string;
}

const clamp = (value: unknown, min: number, max: number, fallback: number) => {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

/** Convert schedule rules into 6-field cron expressions (with seconds). */
export function scheduleToCron(parameters: INodeParameters): string[] {
  const rules = ((parameters.rule as { interval?: Rule[] } | undefined)?.interval ?? []) as Rule[];
  return rules
    .map((rule) => {
      const minute = clamp(rule.triggerAtMinute, 0, 59, 0);
      const hour = clamp(rule.triggerAtHour, 0, 23, 0);
      switch (rule.field) {
        case 'seconds':
          return `*/${clamp(rule.secondsInterval, 1, 59, 30)} * * * * *`;
        case 'minutes':
          return `0 */${clamp(rule.minutesInterval, 1, 59, 5)} * * * *`;
        case 'hours':
          return `0 ${minute} */${clamp(rule.hoursInterval, 1, 23, 1)} * * *`;
        case 'days':
          return `0 ${minute} ${hour} */${clamp(rule.daysInterval, 1, 31, 1)} * *`;
        case 'weeks': {
          const days = (rule.triggerAtDay?.length ? rule.triggerAtDay : [1]).map((d) =>
            clamp(d, 0, 6, 1),
          );
          return `0 ${minute} ${hour} * * ${[...new Set(days)].sort().join(',')}`;
        }
        case 'months':
          return `0 ${minute} ${hour} ${clamp(rule.triggerAtDayOfMonth, 1, 31, 1)} */${clamp(rule.monthsInterval, 1, 12, 1)} *`;
        case 'cronExpression':
          return String(rule.expression ?? '').trim();
        default:
          return '';
      }
    })
    .filter(Boolean);
}

const show = (...fields: string[]) => ({ show: { field: fields } });

export const ScheduleTrigger: INodeType = {
  description: {
    name: 'flowforge.scheduleTrigger',
    displayName: 'Schedule Trigger',
    icon: 'alarm-clock',
    iconColor: '#31c49f',
    group: ['trigger'],
    triggerKind: 'schedule',
    version: 1,
    description: 'Start the workflow on a schedule (every N minutes, daily at 9:00, cron, …)',
    defaults: { name: 'Schedule Trigger' },
    inputs: [],
    outputs: [{ type: 'main' }],
    keywords: ['cron', 'interval', 'timer', 'every', 'daily', 'hourly'],
    properties: [
      {
        displayName: 'Trigger Rules',
        name: 'rule',
        type: 'fixedCollection',
        typeOptions: { multipleValues: true },
        default: {
          interval: [{ field: 'days', daysInterval: 1, triggerAtHour: 9, triggerAtMinute: 0 }],
        },
        options: [
          {
            name: 'interval',
            displayName: 'Trigger Interval',
            values: [
              {
                displayName: 'Trigger Interval',
                name: 'field',
                type: 'options',
                default: 'days',
                options: [
                  { name: 'Seconds', value: 'seconds' },
                  { name: 'Minutes', value: 'minutes' },
                  { name: 'Hours', value: 'hours' },
                  { name: 'Days', value: 'days' },
                  { name: 'Weeks', value: 'weeks' },
                  { name: 'Months', value: 'months' },
                  { name: 'Custom (Cron)', value: 'cronExpression' },
                ],
              },
              {
                displayName: 'Seconds Between Triggers',
                name: 'secondsInterval',
                type: 'number',
                default: 30,
                displayOptions: show('seconds'),
              },
              {
                displayName: 'Minutes Between Triggers',
                name: 'minutesInterval',
                type: 'number',
                default: 5,
                displayOptions: show('minutes'),
              },
              {
                displayName: 'Hours Between Triggers',
                name: 'hoursInterval',
                type: 'number',
                default: 1,
                displayOptions: show('hours'),
              },
              {
                displayName: 'Days Between Triggers',
                name: 'daysInterval',
                type: 'number',
                default: 1,
                displayOptions: show('days'),
              },
              {
                displayName: 'Months Between Triggers',
                name: 'monthsInterval',
                type: 'number',
                default: 1,
                displayOptions: show('months'),
              },
              {
                displayName: 'Trigger on Weekdays',
                name: 'triggerAtDay',
                type: 'multiOptions',
                default: [1],
                displayOptions: show('weeks'),
                options: [
                  'Sunday',
                  'Monday',
                  'Tuesday',
                  'Wednesday',
                  'Thursday',
                  'Friday',
                  'Saturday',
                ].map((name, value) => ({ name, value })),
              },
              {
                displayName: 'Trigger at Day of Month',
                name: 'triggerAtDayOfMonth',
                type: 'number',
                default: 1,
                displayOptions: show('months'),
              },
              {
                displayName: 'Trigger at Hour',
                name: 'triggerAtHour',
                type: 'number',
                default: 9,
                displayOptions: show('days', 'weeks', 'months'),
              },
              {
                displayName: 'Trigger at Minute',
                name: 'triggerAtMinute',
                type: 'number',
                default: 0,
                displayOptions: show('hours', 'days', 'weeks', 'months'),
              },
              {
                displayName: 'Cron Expression',
                name: 'expression',
                type: 'string',
                default: '0 9 * * 1-5',
                hint: 'minute hour day month weekday, e.g. "0 9 * * 1-5" = weekdays at 9:00 (an optional 6th leading field is seconds)',
                displayOptions: show('cronExpression'),
              },
            ],
          },
        ],
      },
      {
        displayName: 'Times use the workflow timezone (Workflow settings → Timezone).',
        name: 'tzNotice',
        type: 'notice',
        default: '',
      },
    ],
  },

  cronExpressions: scheduleToCron,

  async execute(this: IExecuteFunctions) {
    const now = DateTime.now().setZone(this.getTimezone());
    return [
      [
        {
          json: {
            timestamp: now.toISO(),
            'Readable date': now.toFormat('MMMM d, yyyy, h:mm:ss a'),
            'Readable time': now.toFormat('h:mm:ss a'),
            'Day of week': now.toFormat('cccc'),
            Year: now.year,
            Month: now.toFormat('MMMM'),
            'Day of month': now.toFormat('dd'),
            Hour: now.toFormat('HH'),
            Minute: now.toFormat('mm'),
            Second: now.toFormat('ss'),
            Timezone: `${now.zoneName} (UTC${now.toFormat('ZZ')})`,
          },
        },
      ],
    ];
  },
};
