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
    retryOnFail?: boolean;
    maxTries?: number;
    waitBetweenTries?: number;
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

// "AI Story Shorts – Daily": publish settings and the safety gate, shared by several nodes.
const SHORTS_SETTINGS = "$('Publish Settings').first().json";
const SHORTS_MODE_RAW = `String(${SHORTS_SETTINGS}.publish_mode).trim().toLowerCase()`;
const SHORTS_MODE_VALID = `['scheduled', 'public', 'private'].includes(${SHORTS_MODE_RAW})`;
const SHORTS_REQUESTED = `(${SHORTS_MODE_VALID} ? ${SHORTS_MODE_RAW} : 'private')`;
const SHORTS_FIRST_TRY = "$('Set Attempt').first().json.attempt === 1";
const SHORTS_LOW_SCORES =
  "['hook', 'clarity', 'originality', 'safety'].filter(k => !(Number($json.output[k]) >= 8))";
const SHORTS_DECISION = "$('Decide Publishing').first().json";
const SHORTS_TZ = `(${SHORTS_SETTINGS}.publish_timezone || 'Asia/Kolkata')`;
/** The publish time as "8 PM" / "8:15 PM", from the publish_at the node's input carries. */
const SHORTS_LIVE_TIME = `(at => at.toFormat(at.minute ? 'h:mm a' : 'h a'))(DateTime.fromISO($json.publish_at).setZone(${SHORTS_TZ}))`;
const SHORTS_LIVE_WHEN = `((DateTime.fromISO($json.publish_at).setZone(${SHORTS_TZ}).hasSame($now.setZone(${SHORTS_TZ}), 'day') ? 'at ' : 'tomorrow at ') + ${SHORTS_LIVE_TIME})`;

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
      "Every evening: picks one of India's trending topics, writes a 45-second story with Groq, has it checked, turns it into a vertical video with MoneyPrinterTurbo on your PC and publishes it on YouTube (scheduled for 20:00 by default; see Publish Settings).",
    category: 'Content',
    setup: [
      'Connect the credentials: YouTube OAuth2 API, Groq API (free key at https://console.groq.com/keys), Google Sheets OAuth2 API and Gmail OAuth2 API',
      'Pick your spreadsheet in "Get Past Titles" and "Log Post" (it needs a sheet named "Posted")',
      'Enter your email address in "Email Approval Link", "Notify Me" and "Upload Problem"',
      'Choose publish_mode (scheduled, public or private) and publish_time in "Publish Settings"',
      'Scheduled and public uploads need your Google Cloud project to pass the YouTube API audit; until then YouTube keeps them private and you get an "Upload problem" email',
      'Start MoneyPrinterTurbo on this PC (with a free Coverr API key in its config.toml) and check the field names of "Make Video" at http://127.0.0.1:8080/docs',
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
            '## AI Story Shorts – Daily\n1. Every day at 18:00 it collects trending searches (Google Trends) and trending videos (YouTube) in India.\n2. Groq writes a short story about one trend, a second Groq editor checks it, and MoneyPrinterTurbo turns it into a 9:16 video.\n3. You get an email to watch and approve the video on your phone; once approved it is uploaded to YouTube (scheduled for 20:00 by default, see Publish Settings) and logged in Google Sheets.',
          color: 'blue',
        },
        { width: 760, height: 190 },
      ),
      node('Every day 18:00', 'flowforge.scheduleTrigger', [0, 0], daily(18)),
      node('Publish Settings', 'flowforge.set', [240, 0], {
        mode: 'manual',
        includeOtherFields: false,
        assignments: {
          assignments: [
            { id: '1', name: 'publish_mode', value: 'scheduled', type: 'string' },
            { id: '2', name: 'publish_time', value: '20:00', type: 'string' },
            { id: '3', name: 'publish_timezone', value: 'Asia/Kolkata', type: 'string' },
          ],
        },
      }),
      node(
        'About Publish Settings',
        'flowforge.stickyNote',
        [120, 220],
        {
          content:
            '**publish_mode**\n- scheduled (default): goes public at publish_time\n- public: public right away\n- private: stays Private for review\n\nScheduled and public need a first-try approval with every score 8+; otherwise the video stays Private.',
          color: 'green',
        },
        { width: 340, height: 200 },
      ),
      node('Google Trends RSS', 'flowforge.rssFeedRead', [480, -100], {
        url: 'https://trends.google.com/trending/rss?geo=IN',
      }),
      node(
        'YouTube Trending',
        'flowforge.httpRequest',
        [480, 100],
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
      node('Split Out Videos', 'flowforge.splitOut', [720, 100], {
        fieldToSplitOut: 'items',
        include: 'noOtherFields',
      }),
      node('Keep Video Titles', 'flowforge.set', [960, 100], {
        mode: 'manual',
        includeOtherFields: false,
        assignments: {
          assignments: [
            { id: '1', name: 'title', value: '={{ $json.snippet.title }}', type: 'string' },
          ],
        },
      }),
      node('Merge Trends', 'flowforge.merge', [1200, 0], { mode: 'append' }),
      node('Aggregate Trends', 'flowforge.aggregate', [1440, 0], {
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
        [1680, 0],
        { operation: 'read', documentId: '', sheetName: 'Posted', returnColumns: 'title' },
        { credentialTypes: ['googleSheetsOAuth2Api'], alwaysOutputData: true },
      ),
      node('Last 30 Titles', 'flowforge.limit', [1920, 0], { maxItems: 30, keep: 'lastItems' }),
      node(
        'Aggregate Past Titles',
        'flowforge.aggregate',
        [2160, 0],
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
      node('Set Attempt', 'flowforge.set', [2400, 0], {
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
        [2640, 0],
        {
          modelProvider: 'groq',
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
        { credentialTypes: ['groqApi'] },
      ),
      node(
        'Quality Check',
        'flowforge.chainLlm',
        [2880, 0],
        {
          modelProvider: 'groq',
          model: '',
          hasOutputParser: true,
          jsonSchemaExample:
            '{"hook":0,"clarity":0,"originality":0,"safety":0,"approve":true,"reason":""}',
          options: { temperature: 0.2 },
          text: '=You are a strict YouTube Shorts editor. Score this Short 1-10 on hook, clarity, originality, and safety (no misinformation, tragedy exploitation, hate, sexual or violent content, or copyrighted characters). Approve only if every score is 7 or higher. Title: {{ $json.output.title }} Script: {{ $json.output.script }}. Output only the JSON.',
        },
        { credentialTypes: ['groqApi'] },
      ),
      node('Approved?', 'flowforge.if', [3120, 0], {
        conditions: condition('={{ $json.output.approve }}', 'boolean', 'true'),
        looseTypeValidation: true,
      }),
      node('First Attempt?', 'flowforge.if', [3600, 200], {
        conditions: condition(
          "={{ $('Set Attempt').first().json.attempt }}",
          'number',
          'equals',
          1,
        ),
        looseTypeValidation: true,
      }),
      node('Retry With Feedback', 'flowforge.set', [3840, 200], {
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
      node('Rejected', 'flowforge.stopAndError', [3840, 400], {
        errorType: 'errorMessage',
        errorMessage: '=Rejected twice: {{ $json.output.reason }}',
      }),
      node(
        'MoneyPrinterTurbo fields',
        'flowforge.stickyNote',
        [3320, -250],
        {
          content:
            'Check these field names at http://127.0.0.1:8080/docs under POST /api/v1/videos.',
          color: 'yellow',
        },
        { width: 300, height: 120 },
      ),
      node('Decide Publishing', 'flowforge.set', [3360, 0], {
        mode: 'manual',
        includeOtherFields: false,
        assignments: {
          assignments: [
            {
              id: '1',
              name: 'requested_mode',
              value: `={{ ${SHORTS_REQUESTED} }}`,
              type: 'string',
            },
            {
              id: '2',
              name: 'mode',
              value: `={{ ${SHORTS_REQUESTED} !== 'private' && ${SHORTS_FIRST_TRY} && ${SHORTS_LOW_SCORES}.length === 0 ? ${SHORTS_REQUESTED} : 'private' }}`,
              type: 'string',
            },
            {
              id: '3',
              name: 'review_reason',
              value: `={{ !${SHORTS_MODE_VALID} ? 'publish_mode "' + ${SHORTS_SETTINGS}.publish_mode + '" is not scheduled, public or private' : ${SHORTS_REQUESTED} === 'private' ? '' : [!(${SHORTS_FIRST_TRY}) ? 'the story needed a second try' : '', ${SHORTS_LOW_SCORES}.length ? 'scores below 8: ' + ${SHORTS_LOW_SCORES}.map(k => k + ' ' + $json.output[k]).join(', ') : ''].filter(Boolean).join(' and ') }}`,
              type: 'string',
            },
          ],
        },
      }),
      node(
        'Make Video',
        'flowforge.httpRequest',
        [3600, 0],
        {
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
  "video_source": "coverr",
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
        },
        // MoneyPrinterTurbo may still be starting or busy: try again before giving up.
        { retryOnFail: true, maxTries: 3, waitBetweenTries: 60000 },
      ),
      node('Save Task ID', 'flowforge.set', [3840, 0], {
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
      node('Wait 5 Minutes', 'flowforge.wait', [4080, 0], {
        resume: 'timeInterval',
        amount: 5,
        unit: 'minutes',
      }),
      node('Check Task', 'flowforge.httpRequest', [4320, 0], {
        method: 'GET',
        url: "=http://127.0.0.1:8080/api/v1/tasks/{{ $('Save Task ID').first().json.task_id }}",
      }),
      node('Done?', 'flowforge.if', [4560, 0], {
        conditions: condition(
          '={{ $json.data?.progress ?? $json.progress }}',
          'number',
          'equals',
          100,
        ),
        looseTypeValidation: true,
      }),
      node('Count Tries', 'flowforge.set', [4800, 200], {
        mode: 'manual',
        includeOtherFields: true,
        assignments: {
          assignments: [{ id: '1', name: 'tries', value: '={{ $runIndex + 1 }}', type: 'number' }],
        },
      }),
      node('Too Many Tries?', 'flowforge.if', [6240, 200], {
        conditions: condition('={{ $json.tries }}', 'number', 'gte', 6),
        looseTypeValidation: true,
      }),
      node('Give Up', 'flowforge.stopAndError', [6480, 300], {
        errorType: 'errorMessage',
        errorMessage:
          '=The video was not ready after {{ $json.tries }} checks (30 minutes). Check MoneyPrinterTurbo on your PC.',
      }),
      node('Download Video', 'flowforge.httpRequest', [4800, 0], {
        method: 'GET',
        // MoneyPrinterTurbo returns "/tasks/..." when its endpoint setting is empty (the default).
        url: "={{ (v => (v.startsWith('http') ? '' : 'http://127.0.0.1:8080') + v)(String(($json.data?.videos ?? $json.videos)[0])) }}",
        options: { responseFormat: 'binary', timeout: 600000 },
      }),
      node('Request Approval', 'flowforge.approval', [5040, 0], {
        operation: 'request',
        title: "={{ $('Write Story').first().json.output.title }}",
        description: `={{ $('Write Story').first().json.output.description }}

Trend: {{ $('Write Story').first().json.output.trend_used }}
Quality check: hook {{ $('Quality Check').first().json.output.hook }}, clarity {{ $('Quality Check').first().json.output.clarity }}, originality {{ $('Quality Check').first().json.output.originality }}, safety {{ $('Quality Check').first().json.output.safety }}
If you approve: {{ ${SHORTS_DECISION}.mode === 'public' ? 'published right away' : ${SHORTS_DECISION}.mode === 'scheduled' ? 'goes public at ' + ${SHORTS_SETTINGS}.publish_time : 'uploaded as Private' + (${SHORTS_DECISION}.review_reason ? ' (' + ${SHORTS_DECISION}.review_reason + ')' : '') }}`,
        binaryPropertyName: 'data',
        expiresAfterHours: 24,
      }),
      node(
        'Email Approval Link',
        'flowforge.gmail',
        [5280, 0],
        {
          resource: 'message',
          operation: 'send',
          sendTo: '',
          subject: "=Approve your new Short: {{ $('Write Story').first().json.output.title }}",
          emailType: 'text',
          message: `=Your new Short "{{ $('Write Story').first().json.output.title }}" is ready.

Watch it and approve or reject it here:
{{ $json.approval_url }}

The link works on your phone from anywhere while your PC is on. If you do not answer within 24 hours, nothing is uploaded.`,
        },
        { credentialTypes: ['gmailOAuth2'] },
      ),
      node('Wait for Approval', 'flowforge.wait', [5520, 0], {
        resume: 'webhook',
        limitWaitTime: true,
        limitHours: 24,
      }),
      node('Approved by You?', 'flowforge.if', [5760, 0], {
        conditions: condition('={{ $json.approved }}', 'boolean', 'true'),
        looseTypeValidation: true,
      }),
      node('Not Approved', 'flowforge.noOp', [6000, 220]),
      node('Load Approved Video', 'flowforge.approval', [6000, 0], {
        operation: 'media',
        approvalId: "={{ $('Request Approval').first().json.approval_id }}",
        outputBinaryPropertyName: 'data',
      }),
      node(
        'YouTube Upload',
        'flowforge.youTube',
        [6240, 0],
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
            privacyStatus: `={{ ${SHORTS_DECISION}.mode === 'public' ? 'public' : 'private' }}`,
            selfDeclaredMadeForKids: false,
            notifySubscribers: `={{ ${SHORTS_DECISION}.mode !== 'private' }}`,
            // Today at publish_time in the publish timezone, or tomorrow when that has passed.
            publishAt: `={{ ${SHORTS_DECISION}.mode !== 'scheduled' ? '' : (() => { const [h, m] = String(${SHORTS_SETTINGS}.publish_time).split(':').map(Number); let at = $now.setZone(${SHORTS_TZ}).set({ hour: h, minute: m || 0, second: 0, millisecond: 0 }); if (at <= $now) at = at.plus({ days: 1 }); return at.toUTC().toISO({ suppressMilliseconds: true }); })() }}`,
            containsSyntheticMedia: true,
          },
        },
        { credentialTypes: ['youTubeOAuth2Api'] },
      ),
      node(
        'Log Post',
        'flowforge.googleSheets',
        [6480, 0],
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
              {
                column: 'publish_mode',
                value: `={{ ${SHORTS_DECISION}.mode + (${SHORTS_DECISION}.review_reason ? ' (review)' : '') }}`,
              },
              {
                column: 'publish_time',
                value: `={{ ${SHORTS_DECISION}.mode === 'scheduled' ? ($('YouTube Upload').first().json.status?.publishAt ? DateTime.fromISO($('YouTube Upload').first().json.status.publishAt).setZone(${SHORTS_TZ}).toFormat('yyyy-MM-dd HH:mm') : 'not scheduled') : ${SHORTS_DECISION}.mode === 'public' ? $now.setZone(${SHORTS_TZ}).toFormat('yyyy-MM-dd HH:mm') : '' }}`,
              },
            ],
          },
        },
        { credentialTypes: ['googleSheetsOAuth2Api'] },
      ),
      node('Wait for Processing', 'flowforge.wait', [6960, 0], {
        resume: 'timeInterval',
        amount: 2,
        unit: 'minutes',
      }),
      node(
        'Check Status',
        'flowforge.httpRequest',
        [7200, 0],
        {
          method: 'GET',
          url: 'https://www.googleapis.com/youtube/v3/videos',
          authentication: 'predefinedCredentialType',
          nodeCredentialType: 'youTubeOAuth2Api',
          sendQuery: true,
          queryParameters: {
            parameters: [
              { name: 'part', value: 'status,processingDetails' },
              { name: 'id', value: "={{ $('YouTube Upload').first().json.id }}" },
            ],
          },
        },
        { credentialTypes: ['youTubeOAuth2Api'] },
      ),
      node('Read Status', 'flowforge.set', [7440, 0], {
        mode: 'manual',
        includeOtherFields: false,
        assignments: {
          assignments: [
            {
              id: '1',
              name: 'video_id',
              value: "={{ $('YouTube Upload').first().json.id }}",
              type: 'string',
            },
            {
              id: '2',
              name: 'upload_status',
              value: "={{ $json.items?.[0]?.status?.uploadStatus ?? 'not found' }}",
              type: 'string',
            },
            {
              id: '3',
              name: 'privacy_status',
              value: "={{ $json.items?.[0]?.status?.privacyStatus ?? '' }}",
              type: 'string',
            },
            {
              id: '4',
              name: 'publish_at',
              value: "={{ $json.items?.[0]?.status?.publishAt ?? '' }}",
              type: 'string',
            },
            {
              id: '5',
              name: 'failure_reason',
              value: "={{ $json.items?.[0]?.status?.failureReason ?? '' }}",
              type: 'string',
            },
            {
              id: '6',
              name: 'rejection_reason',
              value: "={{ $json.items?.[0]?.status?.rejectionReason ?? '' }}",
              type: 'string',
            },
            {
              id: '7',
              name: 'problem',
              value: `={{ (() => { const v = $json.items?.[0]; const s = v?.status ?? {}; const mode = ${SHORTS_DECISION}.mode; if (!v) return 'YouTube cannot find the video (it may have been deleted).'; if (s.uploadStatus === 'failed') return 'The upload failed: ' + (s.failureReason || 'no reason given'); if (s.uploadStatus === 'rejected') return 'YouTube rejected the video: ' + (s.rejectionReason || 'no reason given'); if (s.uploadStatus === 'deleted') return 'The video was deleted.'; if (mode === 'public' && s.privacyStatus !== 'public') return 'Locked as private: it was uploaded as public, but YouTube keeps it ' + s.privacyStatus + '.'; if (mode === 'scheduled' && !s.publishAt) return 'Locked as private: YouTube dropped the scheduled publish time, so it will not go public.'; return ''; })() }}`,
              type: 'string',
            },
          ],
        },
      }),
      node('Upload OK?', 'flowforge.if', [7680, 0], {
        conditions: condition('={{ $json.problem }}', 'string', 'empty'),
      }),
      node(
        'Notify Me',
        'flowforge.gmail',
        [7920, 0],
        {
          resource: 'message',
          operation: 'send',
          sendTo: '',
          subject: `={{ ${SHORTS_DECISION}.mode === 'public' ? 'Now live: ' : ${SHORTS_DECISION}.mode === 'scheduled' ? 'Going live ' + ${SHORTS_LIVE_WHEN} + ': ' : 'New Short ready: ' }}{{ $('Write Story').first().json.output.title }}`,
          emailType: 'text',
          message: `=Your new Short "{{ $('Write Story').first().json.output.title }}" {{ ${SHORTS_DECISION}.mode === 'public' ? 'is live: https://youtube.com/shorts/' + $json.video_id : ${SHORTS_DECISION}.mode === 'scheduled' ? 'is scheduled to go public ' + ${SHORTS_LIVE_WHEN} + '.' : 'is uploaded as Private.' + (${SHORTS_DECISION}.review_reason ? "\\nIt was kept Private for manual review because " + ${SHORTS_DECISION}.review_reason + '.' : '') }}

{{ ${SHORTS_DECISION}.mode === 'private' ? 'Review it and publish it in YouTube Studio:' : 'YouTube Studio:' }}
https://studio.youtube.com/video/{{ $json.video_id }}/edit{{ ${SHORTS_DECISION}.mode === 'scheduled' ? "\\nTo stop it, open the link and set it to Private before " + ${SHORTS_LIVE_TIME} + '.' : '' }}

Trend used: {{ $('Write Story').first().json.output.trend_used }}
Attempt: {{ $('Set Attempt').first().json.attempt }} of 2{{ $('Set Attempt').first().json.attempt > 1 ? ' (the first story was rejected: ' + $('Set Attempt').first().json.feedback + ')' : '' }}
Quality check: hook {{ $('Quality Check').first().json.output.hook }}, clarity {{ $('Quality Check').first().json.output.clarity }}, originality {{ $('Quality Check').first().json.output.originality }}, safety {{ $('Quality Check').first().json.output.safety }}`,
        },
        { credentialTypes: ['gmailOAuth2'] },
      ),
      node(
        'Upload Problem',
        'flowforge.gmail',
        [7920, 220],
        {
          resource: 'message',
          operation: 'send',
          sendTo: '',
          subject: "=Upload problem: {{ $('Write Story').first().json.output.title }}",
          emailType: 'text',
          message: `=Something is wrong with "{{ $('Write Story').first().json.output.title }}" after the upload.

Problem: {{ $json.problem }}

What YouTube reports:
- Upload status: {{ $json.upload_status }}
- Privacy: {{ $json.privacy_status || 'unknown' }}
- Scheduled publish time: {{ $json.publish_at || 'none' }}
- Failure reason: {{ $json.failure_reason || 'none' }}
- Rejection reason: {{ $json.rejection_reason || 'none' }}
- Asked for: {{ ${SHORTS_DECISION}.mode }}

YouTube Studio:
https://studio.youtube.com/video/{{ $json.video_id }}/edit{{ $json.problem.startsWith('Locked') ? "\\n\\nVideos uploaded through the API stay private until your Google Cloud project passes YouTube's API audit. Request it here: https://support.google.com/youtube/contact/yt_api_form" : '' }}`,
        },
        { credentialTypes: ['gmailOAuth2'] },
      ),
    ],
    connections: [
      link('Every day 18:00', 'Publish Settings'),
      link('Publish Settings', 'Google Trends RSS'),
      link('Publish Settings', 'YouTube Trending'),
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
      link('Approved?', 'Decide Publishing', 0),
      link('Decide Publishing', 'Make Video'),
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
      link('Download Video', 'Request Approval'),
      link('Request Approval', 'Email Approval Link'),
      link('Email Approval Link', 'Wait for Approval'),
      link('Wait for Approval', 'Approved by You?'),
      link('Approved by You?', 'Load Approved Video', 0),
      link('Approved by You?', 'Not Approved', 1),
      link('Load Approved Video', 'YouTube Upload'),
      link('YouTube Upload', 'Log Post'),
      link('Log Post', 'Wait for Processing'),
      link('Wait for Processing', 'Check Status'),
      link('Check Status', 'Read Status'),
      link('Read Status', 'Upload OK?'),
      link('Upload OK?', 'Notify Me', 0),
      link('Upload OK?', 'Upload Problem', 1),
    ],
  },
];
