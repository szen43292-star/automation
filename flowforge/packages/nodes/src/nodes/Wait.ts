import { DateTime } from 'luxon';
import {
  NodeOperationError,
  sleep,
  type IExecuteFunctions,
  type INodeType,
} from '@flowforge/workflow';

const UNIT_MS: Record<string, number> = {
  seconds: 1000,
  minutes: 60_000,
  hours: 3_600_000,
  days: 86_400_000,
};
/** Short waits stay in memory; longer ones are persisted and resumed by the server. */
const IN_MEMORY_LIMIT_MS = 65_000;

export const Wait: INodeType = {
  description: {
    name: 'flowforge.wait',
    displayName: 'Wait',
    icon: 'hourglass',
    iconColor: '#804050',
    group: ['flow'],
    version: 1,
    description: 'Pause the workflow for a while, until a date, or until a webhook is called',
    subtitle: '={{ $parameter.resume }}',
    defaults: { name: 'Wait' },
    inputs: [{ type: 'main' }],
    outputs: [{ type: 'main' }],
    keywords: ['delay', 'sleep', 'pause', 'resume', 'approval'],
    properties: [
      {
        displayName: 'Resume',
        name: 'resume',
        type: 'options',
        default: 'timeInterval',
        noDataExpression: true,
        options: [
          { name: 'After Time Interval', value: 'timeInterval' },
          { name: 'At Specified Time', value: 'specificTime' },
          {
            name: 'On Webhook Call',
            value: 'webhook',
            description: 'Resume when $execution.resumeUrl is called',
          },
        ],
      },
      {
        displayName: 'Wait Amount',
        name: 'amount',
        type: 'number',
        default: 5,
        displayOptions: { show: { resume: ['timeInterval'] } },
      },
      {
        displayName: 'Wait Unit',
        name: 'unit',
        type: 'options',
        default: 'seconds',
        displayOptions: { show: { resume: ['timeInterval'] } },
        options: ['seconds', 'minutes', 'hours', 'days'].map((u) => ({
          name: u[0]!.toUpperCase() + u.slice(1),
          value: u,
        })),
      },
      {
        displayName: 'Date and Time',
        name: 'dateTime',
        type: 'dateTime',
        default: '',
        displayOptions: { show: { resume: ['specificTime'] } },
      },
      {
        displayName:
          "The execution pauses here. Call the URL in {{ $execution.resumeUrl }} (e.g. send it in a message) to continue; the request body becomes this node's output.",
        name: 'webhookNotice',
        type: 'notice',
        default: '',
        displayOptions: { show: { resume: ['webhook'] } },
      },
      {
        displayName: 'Limit Wait Time',
        name: 'limitWaitTime',
        type: 'boolean',
        default: false,
        displayOptions: { show: { resume: ['webhook'] } },
      },
      {
        displayName: 'Max Wait (hours)',
        name: 'limitHours',
        type: 'number',
        default: 24,
        displayOptions: { show: { resume: ['webhook'], limitWaitTime: [true] } },
      },
    ],
  },

  async execute(this: IExecuteFunctions) {
    const items = this.getInputData();
    const resume = this.getNodeParameter<string>('resume', 0);

    if (resume === 'webhook') {
      const limit = this.getNodeParameter<boolean>('limitWaitTime', 0, false);
      const hours = Number(this.getNodeParameter('limitHours', 0, 24));
      this.putExecutionToWait({
        waitTill: limit ? new Date(Date.now() + hours * 3_600_000) : null,
        resumeOnWebhook: true,
      });
      return [items];
    }

    let until: Date;
    if (resume === 'specificTime') {
      const raw = this.getNodeParameter<string>('dateTime', 0, '');
      const parsed = DateTime.fromISO(String(raw), { zone: this.getTimezone() });
      if (!parsed.isValid)
        throw new NodeOperationError(this.getNode(), `"${raw}" is not a valid date`);
      until = parsed.toJSDate();
    } else {
      const amount = Number(this.getNodeParameter('amount', 0, 0));
      const unit = this.getNodeParameter<string>('unit', 0, 'seconds');
      if (!Number.isFinite(amount) || amount < 0)
        throw new NodeOperationError(this.getNode(), 'Wait Amount must be a positive number');
      until = new Date(Date.now() + amount * (UNIT_MS[unit] ?? 1000));
    }

    const ms = until.getTime() - Date.now();
    if (ms <= 0) return [items];
    if (ms <= IN_MEMORY_LIMIT_MS) {
      await sleep(ms, this.getSignal());
      return [items];
    }
    this.putExecutionToWait({ waitTill: until });
    return [items];
  },
};
