/**
 * Ready-made workflows. "Use template" copies one into a new workflow; the WhatsApp number and
 * URLs are left for the user to choose.
 */
export interface WorkflowTemplate {
  id: string;
  name: string;
  description: string;
  category: 'WhatsApp' | 'Calls' | 'AI agent' | 'Leads' | 'Reports';
  /** Shown as setup steps after the template is used. */
  setup: string[];
  nodes: Array<{
    id: string;
    name: string;
    type: string;
    typeVersion: number;
    position: [number, number];
    parameters: Record<string, unknown>;
  }>;
  connections: Array<{ source: string; sourceOutput: number; target: string; targetInput: number }>;
}

const node = (
  name: string,
  type: string,
  position: [number, number],
  parameters: Record<string, unknown> = {},
) => ({
  id: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
  name,
  type,
  typeVersion: 1,
  position,
  parameters,
});

const link = (source: string, target: string, sourceOutput = 0) => ({
  source: source.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
  sourceOutput,
  target: target.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
  targetInput: 0,
});

const condition = (leftValue: string, type: string, operation: string, rightValue?: unknown) => ({
  combinator: 'and',
  conditions: [
    {
      id: '1',
      leftValue,
      ...(rightValue !== undefined ? { rightValue } : {}),
      operator: { type, operation },
    },
  ],
});

const daily = (hour: number) => ({
  rule: { interval: [{ field: 'days', daysInterval: 1, triggerAtHour: hour, triggerAtMinute: 0 }] },
});

export const TEMPLATES: WorkflowTemplate[] = [
  {
    id: 'whatsapp-auto-reply',
    name: 'WhatsApp auto-reply with menu',
    description: 'Greets every new message and offers buttons: prices, opening hours, talk to us.',
    category: 'WhatsApp',
    setup: ['Choose your number in both WhatsApp nodes', 'Edit the texts', 'Activate'],
    nodes: [
      node('WhatsApp Trigger', 'flowforge.whatsAppTrigger', [0, 0], {
        account: '',
        events: ['message'],
      }),
      node('Send menu', 'flowforge.whatsApp', [260, 0], {
        account: '',
        operation: 'sendButtons',
        to: '={{ $json.from }}',
        bodyText: "=Hi {{ $json.contactName ?? 'there' }}! 👋 How can we help?",
        buttons: {
          button: [
            { title: 'Prices', id: 'prices' },
            { title: 'Opening hours', id: 'hours' },
            { title: 'Talk to us', id: 'human' },
          ],
        },
      }),
    ],
    connections: [link('WhatsApp Trigger', 'Send menu')],
  },
  {
    id: 'missed-call-follow-up',
    name: 'Missed call → WhatsApp follow-up',
    description:
      'When a call is missed or declined, send the caller a WhatsApp message right away.',
    category: 'Calls',
    setup: ['Choose your number in the trigger and the WhatsApp node', 'Activate'],
    nodes: [
      node('Call ended', 'flowforge.whatsAppTrigger', [0, 0], {
        account: '',
        events: ['call_ended'],
      }),
      node('Missed?', 'flowforge.if', [240, 0], {
        conditions: condition(
          '={{ ["missed", "rejected"].includes($json.status) }}',
          'boolean',
          'true',
        ),
      }),
      node('Send follow-up', 'flowforge.whatsApp', [480, -80], {
        account: '',
        operation: 'sendText',
        to: '={{ $json.from }}',
        text: "=Sorry we missed your call, {{ $json.contactName ?? '' }}! Reply here and we'll get back to you, or call again any time.",
      }),
    ],
    connections: [link('Call ended', 'Missed?'), link('Missed?', 'Send follow-up')],
  },
  {
    id: 'call-summary-webhook',
    name: 'Send every call summary to a sheet or CRM',
    description:
      'After each call, POST the caller, duration, transcript and AI summary to a URL (Google Apps Script, Zapier, your CRM...).',
    category: 'Calls',
    setup: ['Choose your number in the trigger', 'Paste your URL into HTTP Request', 'Activate'],
    nodes: [
      node('Call ended', 'flowforge.whatsAppTrigger', [0, 0], {
        account: '',
        events: ['call_ended'],
      }),
      node('HTTP Request', 'flowforge.httpRequest', [260, 0], {
        method: 'POST',
        url: 'https://example.com/your-webhook',
        sendBody: true,
        specifyBody: 'json',
        jsonBody:
          '={{ { phone: $json.from, name: $json.contactName, status: $json.status, handledBy: $json.handledBy, seconds: $json.durationSeconds, summary: $json.summary, at: $json.startedAt } }}',
      }),
    ],
    connections: [link('Call ended', 'HTTP Request')],
  },
  {
    id: 'agent-booking-tool',
    name: 'Booking tool for the AI agent',
    description:
      'A workflow the AI agent can run during calls to book appointments. Add it to an agent under Tools with the details "day", "time" and "service".',
    category: 'AI agent',
    setup: [
      'Replace the Code node with your calendar or sheet (HTTP Request)',
      'Agent → Tools → Add workflow tool: name book_appointment, details day, time, service',
    ],
    nodes: [
      node('When the agent calls', 'flowforge.executeWorkflowTrigger', [0, 0]),
      node('Book', 'flowforge.code', [260, 0], {
        jsCode:
          "// Save the booking (e.g. call your calendar API here) and tell the agent the result.\nconst b = $input.first().json;\nreturn [{ json: { booked: true, reference: 'B-' + Date.now().toString(36).toUpperCase(), day: b.day, time: b.time, service: b.service, name: b.caller?.name } }];",
      }),
    ],
    connections: [link('When the agent calls', 'Book')],
  },
  {
    id: 'website-lead',
    name: 'Website lead → WhatsApp message',
    description:
      'A form on your website posts to a webhook; the lead gets a WhatsApp message within seconds.',
    category: 'Leads',
    setup: [
      'Choose your number in the WhatsApp node (outside 24 h, use a template)',
      'Point your form to the Production URL of the webhook',
      'Activate',
    ],
    nodes: [
      node('Lead form', 'flowforge.webhook', [0, 0], {
        httpMethod: 'POST',
        path: 'lead',
        responseMode: 'onReceived',
      }),
      node('Welcome message', 'flowforge.whatsApp', [260, 0], {
        account: '',
        operation: 'sendText',
        to: "={{ String($json.body.phone).replace(/\\D/g, '') }}",
        text: '=Hi {{ $json.body.name }}, thanks for your enquiry! Our team will call you shortly.',
      }),
    ],
    connections: [link('Lead form', 'Welcome message')],
  },
  {
    id: 'daily-reminders',
    name: 'Daily appointment reminders',
    description:
      'Every morning, message everyone with an appointment today. Replace the list with your calendar.',
    category: 'WhatsApp',
    setup: [
      'Replace the Code node with your appointment list',
      'Choose your number and template',
      'Activate',
    ],
    nodes: [
      node('Every day 9:00', 'flowforge.scheduleTrigger', [0, 0], daily(9)),
      node("Today's appointments", 'flowforge.code', [240, 0], {
        jsCode: "return [\n  { json: { phone: '919876543210', name: 'Asha', time: '11:00' } },\n];",
      }),
      node('Remind', 'flowforge.whatsApp', [480, 0], {
        account: '',
        operation: 'sendText',
        to: '={{ $json.phone }}',
        text: '=Hi {{ $json.name }}, a reminder of your appointment today at {{ $json.time }}. Reply 1 to confirm or 2 to reschedule.',
      }),
    ],
    connections: [
      link('Every day 9:00', "Today's appointments"),
      link("Today's appointments", 'Remind'),
    ],
  },
  {
    id: 'ai-reminder-calls',
    name: 'AI reminder calls',
    description:
      'Every morning the AI agent calls customers with an appointment today, confirms they are coming and reschedules if needed.',
    category: 'AI agent',
    setup: [
      'Replace the Code node with your appointment list',
      'Choose your number; customers must have allowed calls (Ask Permission to Call)',
      'Pick the agent and adjust the purpose',
      'Activate',
    ],
    nodes: [
      node('Every day 10:00', 'flowforge.scheduleTrigger', [0, 0], daily(10)),
      node("Today's appointments", 'flowforge.code', [240, 0], {
        jsCode:
          "return [\n  { json: { phone: '919876543210', name: 'Asha', time: '4 pm', service: 'haircut' } },\n];",
      }),
      node('AI call', 'flowforge.whatsApp', [480, 0], {
        account: '',
        operation: 'callWithAgent',
        to: '={{ $json.phone }}',
        agentId: '',
        purpose:
          '=Remind {{ $json.name }} of their {{ $json.service }} appointment today at {{ $json.time }}. Confirm they are coming; if not, offer another time.',
      }),
    ],
    connections: [
      link('Every day 10:00', "Today's appointments"),
      link("Today's appointments", 'AI call'),
    ],
  },
];
