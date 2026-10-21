/**
 * Ready-made workflows. "Use template" copies one into a new workflow; the WhatsApp number and
 * URLs are left for the user to choose.
 */
export interface WorkflowTemplate {
  id: string;
  name: string;
  description: string;
  category: 'WhatsApp' | 'Calls' | 'AI agent' | 'Leads' | 'Reports' | 'Content';
  /** Shown as setup steps after the template is used. */
  setup: string[];
  nodes: Array<{
    id: string;
    name: string;
    type: string;
    typeVersion: number;
    position: [number, number];
    parameters: Record<string, unknown>;
    /** Credential types the node needs: "Use template" picks the user's own credential of each. */
    credentialTypes?: string[];
    alwaysOutputData?: boolean;
    notes?: string;
    width?: number;
    height?: number;
  }>;
  connections: Array<{ source: string; sourceOutput: number; target: string; targetInput: number }>;
  settings?: { timezone?: string };
}

type TemplateNode = WorkflowTemplate['nodes'][number];

const node = (
  name: string,
  type: string,
  position: [number, number],
  parameters: Record<string, unknown> = {},
  extra: Partial<TemplateNode> = {},
): TemplateNode => ({
  id: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
  name,
  type,
  typeVersion: 1,
  position,
  parameters,
  ...extra,
});

const link = (source: string, target: string, sourceOutput = 0, targetInput = 0) => ({
  source: source.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
  sourceOutput,
  target: target.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
  targetInput,
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
  {
    id: 'ai-story-shorts-daily',
    name: 'AI Story Shorts – Daily',
    description:
      "Every evening: picks one of India's trending topics, writes a 45-second story with Gemini, has it checked, turns it into a vertical video with MoneyPrinterTurbo on your PC and uploads it to YouTube as Private.",
    category: 'Content',
    setup: [
      'Connect the credentials: YouTube OAuth2 API, Google Gemini (PaLM) API, Google Sheets OAuth2 API and Gmail OAuth2 API',
      'Pick your spreadsheet in "Get Past Titles" and "Log Post" (it needs a sheet named "Posted")',
      'Enter your email address in "Notify Me"',
      'Start MoneyPrinterTurbo on this PC and check the field names of "Make Video" at http://127.0.0.1:8080/docs',
      'Run it once with "Test workflow", then activate',
    ],
    settings: { timezone: 'Asia/Kolkata' },
    nodes: [
      node(
        'About this workflow',
        'flowforge.stickyNote',
        [-40, -330],
        {
          content:
            '## AI Story Shorts – Daily\n1. Every day at 18:00 it collects trending searches (Google Trends) and trending videos (YouTube) in India.\n2. Gemini writes a short story about one trend, a second Gemini editor checks it, and MoneyPrinterTurbo turns it into a 9:16 video.\n3. The video is uploaded to YouTube as Private, logged in Google Sheets and you get an email with the YouTube Studio link.',
          color: 'blue',
        },
        { width: 760, height: 190 },
      ),
      node('Every day 18:00', 'flowforge.scheduleTrigger', [0, 0], daily(18)),
      node('Google Trends RSS', 'flowforge.rssFeedRead', [240, -100], {
        url: 'https://trends.google.com/trending/rss?geo=IN',
      }),
      node(
        'YouTube Trending',
        'flowforge.httpRequest',
        [240, 100],
        {
          method: 'GET',
          url: 'https://www.googleapis.com/youtube/v3/videos',
          authentication: 'predefinedCredentialType',
          nodeCredentialType: 'youTubeOAuth2Api',
          sendQuery: true,
          queryParameters: {
            parameters: [
              { name: 'part', value: 'snippet' },
              { name: 'chart', value: 'mostPopular' },
              { name: 'regionCode', value: 'IN' },
              { name: 'maxResults', value: '20' },
            ],
          },
        },
        { credentialTypes: ['youTubeOAuth2Api'] },
      ),
      node('Split Out Videos', 'flowforge.splitOut', [480, 100], {
        fieldToSplitOut: 'items',
        include: 'noOtherFields',
      }),
      node('Keep Video Titles', 'flowforge.set', [720, 100], {
        mode: 'manual',
        includeOtherFields: false,
        assignments: {
          assignments: [
            { id: '1', name: 'title', value: '={{ $json.snippet.title }}', type: 'string' },
          ],
        },
      }),
      node('Merge Trends', 'flowforge.merge', [960, 0], { mode: 'append' }),
      node('Aggregate Trends', 'flowforge.aggregate', [1200, 0], {
        aggregate: 'aggregateIndividualFields',
        fieldsToAggregate: {
          fieldToAggregate: [
            { fieldToAggregate: 'title', renameField: true, outputFieldName: 'trends' },
          ],
        },
      }),
      node(
        'Get Past Titles',
        'flowforge.googleSheets',
        [1440, 0],
        { operation: 'read', documentId: '', sheetName: 'Posted', returnColumns: 'title' },
        { credentialTypes: ['googleSheetsOAuth2Api'], alwaysOutputData: true },
      ),
      node('Last 30 Titles', 'flowforge.limit', [1680, 0], { maxItems: 30, keep: 'lastItems' }),
      node(
        'Aggregate Past Titles',
        'flowforge.aggregate',
        [1920, 0],
        {
          aggregate: 'aggregateIndividualFields',
          fieldsToAggregate: {
            fieldToAggregate: [
              { fieldToAggregate: 'title', renameField: true, outputFieldName: 'past_titles' },
            ],
          },
        },
        { alwaysOutputData: true },
      ),
      node('Set Attempt', 'flowforge.set', [2160, 0], {
        mode: 'manual',
        includeOtherFields: true,
        assignments: {
          assignments: [
            { id: '1', name: 'attempt', value: '={{ $json.attempt ?? 1 }}', type: 'number' },
            { id: '2', name: 'feedback', value: "={{ $json.feedback ?? '' }}", type: 'string' },
          ],
        },
      }),
      node(
        'Write Story',
        'flowforge.chainLlm',
        [2400, 0],
        {
          modelProvider: 'googleGemini',
          model: '',
          hasOutputParser: true,
          jsonSchemaExample:
            '{"trend_used":"","title":"","script":"","description":"","tags":["",""],"search_terms":["",""]}',
          text: `=You are the head writer for a YouTube Shorts channel that tells gripping short stories inspired by what people are talking about today.
Today's trending searches and videos: {{ $('Aggregate Trends').first().json.trends.join(' | ') }}
Titles we already posted (never repeat these ideas): {{ ($json.past_titles ?? []).join(' | ') || 'none yet' }}
1. Pick ONE trend that can become a strong story: a real event retold as a story, a "what if" story, a mystery, a moral tale, or a story with a tech or AI twist. Skip deaths, tragedies, disasters, elections, religion, real private people, and anything sexual or violent.
2. Write an ORIGINAL story script of 120-140 words (45-55 seconds spoken).
Script rules: first sentence is a hook under 12 words; never say "In this video", "Hey guys" or "Subscribe"; short spoken sentences, present tense, simple English; one twist near the end; last line ends on a question or loops back to the first line; no emojis, hashtags, scene directions or speaker names; if fiction, don't present it as real news; if based on a real event, use only facts from the headline and never invent quotes.
Also write: title (under 60 characters, honest, no ALL CAPS); description (2 short lines, then "Story written and narrated with AI assistance.", then 3 hashtags including #shorts); tags (8); search_terms (5 short English stock-footage phrases matching the scenes in order).
Output only the JSON.{{ $json.feedback ? "\\n\\nYour previous draft was rejected by the editor for this reason: " + $json.feedback + "\\nWrite a completely new story that fixes this problem. You may choose a different trend." : "" }}`,
        },
        { credentialTypes: ['googlePalmApi'] },
      ),
      node(
        'Quality Check',
        'flowforge.chainLlm',
        [2640, 0],
        {
          modelProvider: 'googleGemini',
          model: '',
          hasOutputParser: true,
          jsonSchemaExample:
            '{"hook":0,"clarity":0,"originality":0,"safety":0,"approve":true,"reason":""}',
          options: { temperature: 0.2 },
          text: '=You are a strict YouTube Shorts editor. Score this Short 1-10 on hook, clarity, originality, and safety (no misinformation, tragedy exploitation, hate, sexual or violent content, or copyrighted characters). Approve only if every score is 7 or higher. Title: {{ $json.output.title }} Script: {{ $json.output.script }}. Output only the JSON.',
        },
        { credentialTypes: ['googlePalmApi'] },
      ),
      node('Approved?', 'flowforge.if', [2880, 0], {
        conditions: condition('={{ $json.output.approve }}', 'boolean', 'true'),
        looseTypeValidation: true,
      }),
      node('First Attempt?', 'flowforge.if', [3120, 200], {
        conditions: condition(
          "={{ $('Set Attempt').first().json.attempt }}",
          'number',
          'equals',
          1,
        ),
        looseTypeValidation: true,
      }),
      node('Retry With Feedback', 'flowforge.set', [3360, 200], {
        mode: 'manual',
        includeOtherFields: false,
        assignments: {
          assignments: [
            { id: '1', name: 'attempt', value: '2', type: 'number' },
            { id: '2', name: 'feedback', value: '={{ $json.output.reason }}', type: 'string' },
            {
              id: '3',
              name: 'past_titles',
              value: "={{ $('Set Attempt').first().json.past_titles }}",
              type: 'array',
            },
          ],
        },
      }),
      node('Rejected', 'flowforge.stopAndError', [3360, 400], {
        errorType: 'errorMessage',
        errorMessage: '=Rejected twice: {{ $json.output.reason }}',
      }),
      node(
        'MoneyPrinterTurbo fields',
        'flowforge.stickyNote',
        [3080, -250],
        {
          content:
            'Check these field names at http://127.0.0.1:8080/docs under POST /api/v1/videos.',
          color: 'yellow',
        },
        { width: 300, height: 120 },
      ),
      node('Make Video', 'flowforge.httpRequest', [3120, 0], {
        method: 'POST',
        url: 'http://127.0.0.1:8080/api/v1/videos',
        sendBody: true,
        contentType: 'json',
        specifyBody: 'json',
        jsonBody: `={
  "video_subject": {{ JSON.stringify($('Write Story').first().json.output.title) }},
  "video_script": {{ JSON.stringify($('Write Story').first().json.output.script) }},
  "video_terms": {{ JSON.stringify($('Write Story').first().json.output.search_terms) }},
  "video_aspect": "9:16",
  "video_source": "pexels",
  "video_clip_duration": 3,
  "video_count": 1,
  "voice_name": "en-US-AndrewNeural-Male",
  "voice_rate": 1.1,
  "bgm_type": "random",
  "bgm_volume": 0.2,
  "subtitle_enabled": true,
  "subtitle_position": "bottom"
}`,
        options: { timeout: 120000 },
      }),
      node('Save Task ID', 'flowforge.set', [3360, 0], {
        mode: 'manual',
        includeOtherFields: false,
        assignments: {
          assignments: [
            {
              id: '1',
              name: 'task_id',
              value: '={{ $json.data?.task_id ?? $json.task_id }}',
              type: 'string',
            },
          ],
        },
      }),
      node('Wait 5 Minutes', 'flowforge.wait', [3600, 0], {
        resume: 'timeInterval',
        amount: 5,
        unit: 'minutes',
      }),
      node('Check Task', 'flowforge.httpRequest', [3840, 0], {
        method: 'GET',
        url: "=http://127.0.0.1:8080/api/v1/tasks/{{ $('Save Task ID').first().json.task_id }}",
      }),
      node('Done?', 'flowforge.if', [4080, 0], {
        conditions: condition(
          '={{ $json.data?.progress ?? $json.progress }}',
          'number',
          'equals',
          100,
        ),
        looseTypeValidation: true,
      }),
      node('Count Tries', 'flowforge.set', [4320, 200], {
        mode: 'manual',
        includeOtherFields: true,
        assignments: {
          assignments: [{ id: '1', name: 'tries', value: '={{ $runIndex + 1 }}', type: 'number' }],
        },
      }),
      node('Too Many Tries?', 'flowforge.if', [4560, 200], {
        conditions: condition('={{ $json.tries }}', 'number', 'gte', 6),
        looseTypeValidation: true,
      }),
      node('Give Up', 'flowforge.stopAndError', [4800, 300], {
        errorType: 'errorMessage',
        errorMessage:
          '=The video was not ready after {{ $json.tries }} checks (30 minutes). Check MoneyPrinterTurbo on your PC.',
      }),
      node('Download Video', 'flowforge.httpRequest', [4320, 0], {
        method: 'GET',
        // MoneyPrinterTurbo returns "/tasks/..." when its endpoint setting is empty (the default).
        url: "={{ (v => (v.startsWith('http') ? '' : 'http://127.0.0.1:8080') + v)(String(($json.data?.videos ?? $json.videos)[0])) }}",
        options: { responseFormat: 'binary', timeout: 600000 },
      }),
      node(
        'YouTube Upload',
        'flowforge.youTube',
        [4560, 0],
        {
          resource: 'video',
          operation: 'upload',
          title: "={{ $('Write Story').first().json.output.title }}",
          regionCode: 'IN',
          categoryId: '24',
          binaryPropertyName: 'data',
          options: {
            description: "={{ $('Write Story').first().json.output.description }}",
            tags: "={{ $('Write Story').first().json.output.tags }}",
            privacyStatus: 'private',
            selfDeclaredMadeForKids: false,
          },
        },
        { credentialTypes: ['youTubeOAuth2Api'] },
      ),
      node(
        'Log Post',
        'flowforge.googleSheets',
        [4800, 0],
        {
          operation: 'append',
          documentId: '',
          sheetName: 'Posted',
          columnsMode: 'defineBelow',
          fieldsUi: {
            values: [
              { column: 'title', value: "={{ $('Write Story').first().json.output.title }}" },
              {
                column: 'trend_used',
                value: "={{ $('Write Story').first().json.output.trend_used }}",
              },
              { column: 'video_id', value: '={{ $json.id }}' },
              { column: 'date', value: "={{ $now.toFormat('yyyy-MM-dd') }}" },
              { column: 'attempt', value: "={{ $('Set Attempt').first().json.attempt }}" },
            ],
          },
        },
        { credentialTypes: ['googleSheetsOAuth2Api'] },
      ),
      node(
        'Notify Me',
        'flowforge.gmail',
        [5040, 0],
        {
          resource: 'message',
          operation: 'send',
          sendTo: '',
          subject: "=New Short ready: {{ $('Write Story').first().json.output.title }}",
          emailType: 'text',
          message: `=Your new Short "{{ $('Write Story').first().json.output.title }}" is uploaded as Private.

Review it and publish it in YouTube Studio:
https://studio.youtube.com/video/{{ $('YouTube Upload').first().json.id }}/edit

Trend used: {{ $('Write Story').first().json.output.trend_used }}
Attempt: {{ $('Set Attempt').first().json.attempt }} of 2{{ $('Set Attempt').first().json.attempt > 1 ? ' (the first story was rejected: ' + $('Set Attempt').first().json.feedback + ')' : '' }}`,
        },
        { credentialTypes: ['gmailOAuth2'] },
      ),
    ],
    connections: [
      link('Every day 18:00', 'Google Trends RSS'),
      link('Every day 18:00', 'YouTube Trending'),
      link('YouTube Trending', 'Split Out Videos'),
      link('Split Out Videos', 'Keep Video Titles'),
      link('Google Trends RSS', 'Merge Trends', 0, 0),
      link('Keep Video Titles', 'Merge Trends', 0, 1),
      link('Merge Trends', 'Aggregate Trends'),
      link('Aggregate Trends', 'Get Past Titles'),
      link('Get Past Titles', 'Last 30 Titles'),
      link('Last 30 Titles', 'Aggregate Past Titles'),
      link('Aggregate Past Titles', 'Set Attempt'),
      link('Set Attempt', 'Write Story'),
      link('Write Story', 'Quality Check'),
      link('Quality Check', 'Approved?'),
      link('Approved?', 'Make Video', 0),
      link('Approved?', 'First Attempt?', 1),
      link('First Attempt?', 'Retry With Feedback', 0),
      link('First Attempt?', 'Rejected', 1),
      link('Retry With Feedback', 'Set Attempt'),
      link('Make Video', 'Save Task ID'),
      link('Save Task ID', 'Wait 5 Minutes'),
      link('Wait 5 Minutes', 'Check Task'),
      link('Check Task', 'Done?'),
      link('Done?', 'Download Video', 0),
      link('Done?', 'Count Tries', 1),
      link('Count Tries', 'Too Many Tries?'),
      link('Too Many Tries?', 'Give Up', 0),
      link('Too Many Tries?', 'Wait 5 Minutes', 1),
      link('Download Video', 'YouTube Upload'),
      link('YouTube Upload', 'Log Post'),
      link('Log Post', 'Notify Me'),
    ],
  },
];
