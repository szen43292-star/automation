import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CallMediaSession, rms, tone, type MediaConfig } from '@flowforge/media';
import { KnowledgeIndex, splitDocument, tokenize } from '../src/agent/knowledge';
import { defaultCallSettings } from '../src/calls/settings';
import { startFakeAi } from './fakeAi';
import { auth, createTestApp, eventually, prisma, resetDb, setupOwner } from './helpers';
import { startStunServer } from './stun';

/**
 * Phase 5 - the AI voice agent. Real calls (WebRTC over localhost) against fake AI providers:
 * speech is encoded as tone pitch, so the whole loop - listening, thinking with tools, speaking,
 * barge-in, transfer, hang-up and the summary - runs without keys or network.
 */
let app: FastifyInstance;
let token: string;
let fake: Awaited<ReturnType<typeof startFakeAi>>;
let stun: Awaited<ReturnType<typeof startStunServer>>;
let media: MediaConfig;
const peers: CallMediaSession[] = [];
let dataDir: string;

const PRICE_LIST = `Prices

Haircut: 300 rupees. Beard trim: 150 rupees. Hair colour from 1200 rupees.

Opening hours

We are open Monday to Saturday, 10 am to 8 pm. Closed on Sunday.

बाल कटवाने की कीमत 300 रुपये है।`;

beforeAll(async () => {
  stun = await startStunServer();
  media = { iceServers: [{ urls: stun.url }], allowLoopback: true };
  fake = await startFakeAi();
  dataDir = mkdtempSync(join(tmpdir(), 'ff-agent-'));
  app = await createTestApp({ ...fake.env, DATA_DIR: dataDir }, { media });
});

afterAll(async () => {
  await app.close();
  await Promise.all(peers.map((p) => p.close()));
  await fake.close();
  await stun.close();
  rmSync(dataDir, { recursive: true, force: true });
  await prisma.$disconnect();
});

beforeEach(async () => {
  await resetDb();
  app.aiProviders.invalidate();
  app.whatsappPlatform.invalidate();
  fake.requests.length = 0;
  fake.realtimeEvents.length = 0;
  fake.spoken.length = 0;
  token = await setupOwner(app);
});

const H = () => auth(token);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function setKeys(keys: Record<string, string | null>) {
  const res = await app.inject({
    method: 'PUT',
    url: '/api/ai/providers',
    headers: H(),
    payload: keys,
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().data as Array<{
    id: string;
    configured: boolean;
    source: string;
    hint: string;
  }>;
}

async function createAgent(body: Record<string, unknown> = {}) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/agents',
    headers: H(),
    payload: {
      name: 'Salon receptionist',
      instructions: 'You answer calls for Shine Salon.',
      greeting: 'Hello, Shine Salon, how can I help?',
      languages: ['English', 'Hindi', 'Hinglish'],
      ...body,
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  const agent = res.json();
  const doc = await app.inject({
    method: 'POST',
    url: `/api/agents/${agent.id}/documents`,
    headers: H(),
    payload: { title: 'Price list', content: PRICE_LIST },
  });
  expect(doc.statusCode, doc.body).toBe(201);
  return agent as { id: string };
}

async function aiNumber(agentId: string, settings: Record<string, unknown> = {}) {
  const account = (
    await app.inject({
      method: 'POST',
      url: '/api/whatsapp/accounts/simulator',
      headers: H(),
      payload: {},
    })
  ).json();
  const res = await app.inject({
    method: 'PUT',
    url: `/api/whatsapp/accounts/${account.id}/calling`,
    headers: H(),
    payload: { ...defaultCallSettings(), mode: 'ai', ...settings },
  });
  expect(res.statusCode, res.body).toBe(200);
  const assign = await app.inject({
    method: 'PUT',
    url: `/api/whatsapp/accounts/${account.id}/agent`,
    headers: H(),
    payload: { agentId },
  });
  expect(assign.statusCode, assign.body).toBe(200);
  return account.id as string;
}

function peer() {
  const p = new CallMediaSession(media);
  peers.push(p);
  return p;
}

/** Call a test number like the browser does; returns the caller with a meter of what it hears. */
async function call(accountId: string) {
  const caller = peer();
  const heard: Array<{ at: number; level: number }> = [];
  caller.onAudio((frame) => heard.push({ at: Date.now(), level: rms(frame) }));
  const res = await app.inject({
    method: 'POST',
    url: `/api/whatsapp/accounts/${accountId}/simulate-call`,
    headers: H(),
    payload: { from: '+91 98765 43210', name: 'Ravi', sdp: await caller.offer() },
  });
  expect(res.statusCode, res.body).toBe(200);
  const result = res.json() as { waCallId: string; sdp?: string };
  expect(result.sdp).toBeTruthy();
  await caller.acceptAnswer(result.sdp!);
  await caller.connected();
  const loudSince = (since: number) => heard.filter((h) => h.at >= since && h.level > 0.05).length;
  return { caller, waCallId: result.waCallId, heard, loudSince };
}

/** Say something: a tone the fake speech-to-text maps to a sentence (see PHRASES). */
const say = (caller: CallMediaSession, hz: number) => caller.play(tone(hz, 900, 0.3));

const latestCall = () => prisma.call.findFirstOrThrow({ orderBy: { startedAt: 'desc' } });
const transcriptOf = async () =>
  ((await latestCall()).transcript as Array<{ role: string; text: string }> | null) ?? [];

describe('knowledge base', () => {
  it('splits documents and finds passages with BM25, in Hindi too', () => {
    expect(tokenize('बाल कटवाने की कीमत')).toEqual(['बाल', 'कटवाने', 'कीमत']);
    const passages = splitDocument('d1', 'Price list', PRICE_LIST, 120);
    expect(passages.length).toBeGreaterThan(1);
    const index = new KnowledgeIndex([
      ...passages,
      ...splitDocument('d2', 'Directions', 'We are at 12 MG Road, next to the metro station.'),
    ]);
    expect(index.search('haircut price')[0]!.text).toContain('Haircut: 300 rupees');
    expect(index.search('when are you open on sunday')[0]!.text).toContain('Closed on Sunday');
    expect(index.search('where is the salon metro')[0]!.title).toBe('Directions');
    expect(index.search('कीमत')[0]!.text).toContain('300 रुपये');
    expect(index.search('haircuts')[0]!.text).toContain('Haircut'); // inflection
    expect(index.search('quantum physics')).toEqual([]);
  });
});

describe('AI providers', () => {
  it('stores keys encrypted, shows only hints, and environment keys win', async () => {
    let status: Array<{ id: string; configured: boolean; source: string; hint: string }> = (
      await app.inject({ method: 'GET', url: '/api/ai/providers', headers: H() })
    ).json().data;
    expect(status.every((p) => !p.configured)).toBe(true);

    status = await setKeys({ anthropic: 'sk-ant-test-key-1234', openai: 'sk-openai-key-9876' });
    expect(status.find((p) => p.id === 'anthropic')).toMatchObject({
      configured: true,
      source: 'settings',
      hint: '…1234',
    });
    const stored = await prisma.setting.findUniqueOrThrow({ where: { key: 'ai.providers' } });
    expect(JSON.stringify(stored.value)).not.toContain('sk-ant-test-key-1234');
    expect(JSON.stringify(status)).not.toContain('sk-ant-test-key-1234');

    status = await setKeys({ openai: null });
    expect(status.find((p) => p.id === 'openai')!.configured).toBe(false);

    const withEnv = await createTestApp(
      { ...fake.env, DATA_DIR: dataDir, DEEPGRAM_API_KEY: 'dg-built-in-key-5555' },
      { media },
    );
    const envStatus = (
      await withEnv.inject({ method: 'GET', url: '/api/ai/providers', headers: H() })
    ).json().data;
    expect(envStatus.find((p: { id: string }) => p.id === 'deepgram')).toMatchObject({
      source: 'env',
      hint: '…5555',
    });
    await withEnv.close();
  });
});

describe('agents', () => {
  it('creates agents with defaults, validates tools, manages knowledge', async () => {
    const agent = await createAgent();
    const full = (
      await app.inject({ method: 'GET', url: `/api/agents/${agent.id}`, headers: H() })
    ).json();
    expect(full).toMatchObject({
      engine: 'realtime',
      voice: { llm: { provider: 'anthropic', model: '' }, stt: { provider: 'openai' } },
      tools: {
        knowledge: true,
        transfer: true,
        endCall: true,
        whatsappMessage: true,
        workflows: [],
      },
      notify: { summary: true, whatsappTo: '' },
      documents: [{ title: 'Price list' }],
      missingProviders: ['openai'],
    });
    const search = await app.inject({
      method: 'GET',
      url: `/api/agents/${agent.id}/search?q=beard`,
      headers: H(),
    });
    expect(search.json().data[0].text).toContain('Beard trim: 150');

    const badTool = await app.inject({
      method: 'PUT',
      url: `/api/agents/${agent.id}`,
      headers: H(),
      payload: {
        name: 'x',
        tools: { workflows: [{ workflowId: 'nope', name: 'book_it', description: 'Book a slot' }] },
      },
    });
    expect(badTool.statusCode).toBe(400);
    expect(badTool.json().message).toContain('does not exist');
    const badName = await app.inject({
      method: 'PUT',
      url: `/api/agents/${agent.id}`,
      headers: H(),
      payload: {
        name: 'x',
        tools: { workflows: [{ workflowId: 'w', name: 'Book It!', description: 'Book' }] },
      },
    });
    expect(badName.statusCode).toBe(400);

    const docId = full.documents[0].id;
    await app.inject({
      method: 'DELETE',
      url: `/api/agents/${agent.id}/documents/${docId}`,
      headers: H(),
    });
    const empty = await app.inject({
      method: 'GET',
      url: `/api/agents/${agent.id}/search?q=beard`,
      headers: H(),
    });
    expect(empty.json().data).toEqual([]);
  });

  it('test chat with Claude: looks things up, passes thinking back, uses fallbacks and low effort', async () => {
    await setKeys({ anthropic: 'sk-ant-test-key-1234' });
    const agent = await createAgent({ engine: 'pipeline' });
    const res = await app.inject({
      method: 'POST',
      url: `/api/agents/${agent.id}/chat`,
      headers: H(),
      payload: { messages: [{ role: 'caller', text: 'What is the price of a haircut?' }] },
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.model).toBe('anthropic/claude-opus-5-5');
    expect(body.actions).toEqual([
      expect.objectContaining({ tool: 'search_knowledge', input: { query: 'haircut price' } }),
    ]);
    expect(body.reply).toContain('Let me check that for you.');
    expect(body.reply).toContain('Haircut: 300 rupees');

    const calls = fake.requests.filter((r) => r.path === '/v1/messages');
    expect(calls).toHaveLength(2);
    const [first, second] = calls;
    expect(first!.body).toMatchObject({
      model: 'claude-opus-5-5',
      stream: true,
      fallbacks: 'default',
      output_config: { effort: 'low' },
    });
    expect(first!.body.thinking).toBeUndefined();
    expect(first!.headers['anthropic-beta']).toContain('server-side-fallback-2026-07-01');
    expect(first!.body.tools.map((t: { name: string }) => t.name)).toEqual([
      'search_knowledge',
      'transfer_to_human',
      'end_call',
      'send_whatsapp_message',
    ]);
    expect(first!.body.tools[0]).toMatchObject({
      strict: true,
      eager_input_streaming: true,
      input_schema: { additionalProperties: false, required: ['query'] },
    });
    expect(first!.body.system).toContain('You answer calls for Shine Salon.');
    expect(first!.body.system).toContain('Hinglish');
    // The assistant turn (with its signed thinking block) goes back unchanged, then the tool result.
    expect(second!.body.messages[1]).toMatchObject({
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'Look up the price.', signature: 'sig-123' },
        { type: 'text' },
        { type: 'tool_use', name: 'search_knowledge' },
      ],
    });
    expect(second!.body.messages[2].content[0]).toMatchObject({ type: 'tool_result' });

    // A wrong key says so.
    await setKeys({ anthropic: 'bad-key-0000000000' });
    const bad = await app.inject({
      method: 'POST',
      url: `/api/agents/${agent.id}/chat`,
      headers: H(),
      payload: { messages: [{ role: 'caller', text: 'hello' }] },
    });
    expect(bad.statusCode).toBe(502);
    expect(bad.json().message).toContain('rejected the API key');
  });

  it('test chat with an OpenAI model runs a workflow as a tool', async () => {
    await setKeys({ openai: 'sk-openai-key-9876' });
    const workflow = await app.inject({
      method: 'POST',
      url: '/api/workflows',
      headers: H(),
      payload: {
        name: 'Book appointment',
        nodes: [
          {
            id: 'T',
            name: 'T',
            type: 'flowforge.executeWorkflowTrigger',
            typeVersion: 1,
            position: [0, 0],
            parameters: {},
          },
          {
            id: 'Book',
            name: 'Book',
            type: 'flowforge.code',
            typeVersion: 1,
            position: [200, 0],
            parameters: {
              jsCode:
                "const i = $input.first().json; return [{ json: { booking: 'B-42', day: i.day, service: i.service, caller: i.caller.name } }];",
            },
          },
        ],
        connections: [{ source: 'T', sourceOutput: 0, target: 'Book', targetInput: 0 }],
      },
    });
    expect(workflow.statusCode, workflow.body).toBe(201);
    const options = (
      await app.inject({ method: 'GET', url: '/api/agents/options', headers: H() })
    ).json();
    expect(options.workflows).toEqual([{ id: workflow.json().id, name: 'Book appointment' }]);

    const agent = await createAgent({
      engine: 'pipeline',
      voice: { llm: { provider: 'openai' } },
      tools: {
        workflows: [
          {
            workflowId: workflow.json().id,
            name: 'book_appointment',
            description: 'Book an appointment',
            parameters: [{ name: 'day' }, { name: 'service' }],
          },
        ],
      },
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/agents/${agent.id}/chat`,
      headers: H(),
      payload: { messages: [{ role: 'caller', text: 'Please book me a haircut' }] },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().model).toBe('openai/gpt-4o-mini');
    const action = res.json().actions[0];
    expect(action.tool).toBe('book_appointment');
    expect(JSON.parse(action.output)).toEqual([
      { booking: 'B-42', day: 'tomorrow', service: 'haircut', caller: 'Owner' },
    ]);
    expect(res.json().reply).toContain('B-42');
    const chat = fake.requests.find((r) => r.path === '/v1/chat/completions')!;
    expect(chat.body.tools.at(-1)).toMatchObject({
      type: 'function',
      function: {
        name: 'book_appointment',
        strict: true,
        parameters: { required: ['day', 'service'] },
      },
    });
  });
});

describe('Groq', () => {
  it('runs the agent and speech-to-text with a Groq key and Groq models', async () => {
    const providers = await setKeys({ groq: 'gsk_groq-key-4321' });
    expect(providers.find((p) => p.id === 'groq')).toMatchObject({
      configured: true,
      hint: '…4321',
    });
    const options = (
      await app.inject({ method: 'GET', url: '/api/agents/options', headers: H() })
    ).json();
    expect(options.llmProviders).toContain('groq');
    expect(options.sttProviders).toContain('groq');

    const agent = await createAgent({ engine: 'pipeline', voice: { llm: { provider: 'groq' } } });
    const res = await app.inject({
      method: 'POST',
      url: `/api/agents/${agent.id}/chat`,
      headers: H(),
      payload: { messages: [{ role: 'caller', text: 'What does a haircut cost?' }] },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().model).toBe('groq/llama-3.3-70b-versatile');
    const chat = fake.requests.find((r) => r.path === '/v1/chat/completions')!;
    expect(chat.headers.authorization).toBe('Bearer gsk_groq-key-4321');
    expect(chat.body.model).toBe('llama-3.3-70b-versatile');

    const { transcribe } = await import('../src/agent/speech');
    const { agentVoiceSchema } = await import('../src/agent/config');
    fake.requests.length = 0;
    await transcribe(
      app.aiProviders,
      agentVoiceSchema.parse({ stt: { provider: 'groq' } }),
      new Int16Array(4800),
    );
    const stt = fake.requests.find((r) => r.path === '/v1/audio/transcriptions')!;
    expect(stt.headers.authorization).toBe('Bearer gsk_groq-key-4321');
  });
});

describe('AI voice calls', () => {
  it('pipeline: greets, answers from knowledge, hangs up, summarizes and tells the owner', async () => {
    await setKeys({ openai: 'sk-openai-key-9876', anthropic: 'sk-ant-test-key-1234' });
    const agent = await createAgent({
      engine: 'pipeline',
      notify: { summary: true, whatsappTo: '+91 99999 00000' },
    });
    const accountId = await aiNumber(agent.id);
    const calling = (
      await app.inject({
        method: 'GET',
        url: `/api/whatsapp/accounts/${accountId}/calling`,
        headers: H(),
      })
    ).json();
    expect(calling.aiAvailable).toBe(true);

    const started = Date.now();
    const { caller, loudSince } = await call(accountId);
    await eventually(async () => (await latestCall()).status === 'answered');
    expect(await eventually(() => loudSince(started) > 10)).toBe(true); // the greeting
    expect(fake.spoken[0]).toBe('Hello, Shine Salon, how can I help?');

    await sleep(1500);
    await say(caller, 400); // "What is the price of a haircut?"
    const answer = await eventually(
      () => fake.spoken.find((text) => text.includes('300 rupees')) ?? null,
      8000,
    );
    expect(answer).toContain('Haircut: 300 rupees');
    await sleep(2500); // let the answer play

    await say(caller, 1000); // "Thanks, bye."
    const ended = await eventually(async () => {
      const row = await latestCall();
      return row.status === 'ended' ? row : null;
    }, 15_000);
    expect(ended).toMatchObject({
      handledBy: 'ai',
      agentId: agent.id,
      endReason: 'The agent ended the call',
    });
    const transcript = ended.transcript as Array<{ role: string; text: string }>;
    expect(transcript.map((l) => l.role)).toEqual(['agent', 'caller', 'agent', 'caller', 'agent']);
    expect(transcript[1]!.text).toBe('What is the price of a haircut?');
    expect(transcript[2]!.text).toContain('300 rupees');
    expect(transcript[4]!.text).toBe('Thank you for calling, goodbye!');
    expect(ended.summary).toBe('The caller asked about haircut prices and the agent helped.');

    // The owner got the summary on WhatsApp.
    const note = await eventually(() =>
      prisma.whatsAppMessage.findFirst({
        where: { contact: '919999900000', direction: 'outbound' },
      }),
    );
    expect(note!.text).toContain('haircut prices');

    // Speech went through the configured providers.
    const stt = fake.requests.filter((r) => r.path === '/v1/audio/transcriptions');
    expect(stt.length).toBeGreaterThanOrEqual(2);
    const tts = fake.requests.find((r) => r.path === '/v1/audio/speech')!;
    expect(tts.body).toMatchObject({
      model: 'gpt-4o-mini-tts',
      voice: 'alloy',
      response_format: 'pcm',
    });

    // Next time Ravi calls, the agent knows him.
    const context = await app.agents.callerContext(accountId, '919876543210', 'Ravi');
    expect(context).toContain('Returning contact');
    expect(context).toContain('haircut prices');
  });

  it('realtime: speech-to-speech with tools, barge-in truncates what was not heard', async () => {
    await setKeys({ openai: 'sk-openai-key-9876', anthropic: 'sk-ant-test-key-1234' });
    const agent = await createAgent({
      engine: 'realtime',
      voice: { realtime: { voice: 'verse' }, language: 'hi-IN' },
    });
    const accountId = await aiNumber(agent.id);
    const { caller, loudSince } = await call(accountId);
    const started = Date.now();
    expect(await eventually(() => loudSince(started) > 10)).toBe(true);
    const update = fake.realtimeEvents.find((e) => e.type === 'session.update');
    expect(update.url).toContain('model=gpt-realtime');
    expect(update.session).toMatchObject({
      type: 'realtime',
      audio: {
        input: { format: { type: 'audio/pcm', rate: 24000 }, transcription: { language: 'hi' } },
        output: { voice: 'verse' },
      },
    });
    expect(update.session.tools.map((t: { name: string }) => t.name)).toContain('search_knowledge');
    await sleep(1500);

    await say(caller, 400); // price → function call → answer
    const output = await eventually(
      () => fake.realtimeEvents.find((e) => e.type === 'conversation.item.create') ?? null,
      8000,
    );
    expect(output.item.output).toContain('Haircut: 300 rupees');
    await sleep(3500);

    await say(caller, 1300); // "Tell me a long story." → a long answer...
    await eventually(
      () => fake.realtimeEvents.filter((e) => e.type === 'response.create').length >= 2 || null,
    );
    await sleep(2500);
    await say(caller, 1000); // ...interrupted by "Thanks, bye."
    const truncate = await eventually(
      () => fake.realtimeEvents.find((e) => e.type === 'conversation.item.truncate') ?? null,
      8000,
    );
    expect(truncate.audio_end_ms).toBeGreaterThan(0);
    expect(truncate.audio_end_ms).toBeLessThan(6000);

    const ended = await eventually(async () => {
      const row = await latestCall();
      return row.status === 'ended' ? row : null;
    }, 15_000);
    expect(ended).toMatchObject({ handledBy: 'ai', endReason: 'The agent ended the call' });
    const transcript = ended.transcript as Array<{ role: string; text: string }>;
    expect(transcript[0]).toMatchObject({
      role: 'agent',
      text: 'Hello, Shine Salon, how can I help?',
    });
    expect(transcript).toContainEqual(
      expect.objectContaining({ role: 'caller', text: 'What is the price of a haircut?' }),
    );
    expect(transcript).toContainEqual(
      expect.objectContaining({ role: 'caller', text: 'Thanks, bye.' }),
    );
    expect(ended.summary).toContain('haircut prices');
  }, 40_000);

  it('transfer: the agent rings the team and a person takes over the call', async () => {
    await setKeys({ openai: 'sk-openai-key-9876', anthropic: 'sk-ant-test-key-1234' });
    const agent = await createAgent({ engine: 'pipeline', notify: { summary: false } });
    const accountId = await aiNumber(agent.id, { ringSeconds: 20 });
    const { caller } = await call(accountId);
    await eventually(async () => (await latestCall()).status === 'answered');
    await sleep(1500);
    await say(caller, 700); // "Can I talk to a human please?"
    const ringing = await eventually(async () => {
      const { data } = (
        await app.inject({ method: 'GET', url: '/api/calls/active', headers: H() })
      ).json();
      return data.find((c: { ringing: boolean }) => c.ringing) ?? null;
    }, 10_000);
    expect(fake.spoken).toContain('Sure, connecting you to the team now.');

    const person = peer();
    const answer = await app.inject({
      method: 'POST',
      url: `/api/calls/${ringing.id}/answer`,
      headers: H(),
      payload: { sdp: await person.offer() },
    });
    expect(answer.statusCode, answer.body).toBe(200);
    await person.acceptAnswer(answer.json().sdp);
    await person.connected();
    const row = await eventually(async () => {
      const c = await latestCall();
      return c.handledBy === 'ai+person' ? c : null;
    });
    expect(row.answeredById).toBeTruthy();

    // The person and the caller hear each other; the agent is quiet now.
    const spokenBefore = fake.spoken.length;
    const personHeard: number[] = [];
    person.onAudio((f) => personHeard.push(rms(f)));
    await caller.play(tone(600, 600, 0.3));
    await sleep(900);
    expect(Math.max(...personHeard)).toBeGreaterThan(0.05);
    expect(fake.spoken.length).toBe(spokenBefore);

    await app.inject({ method: 'POST', url: `/api/calls/${ringing.id}/hangup`, headers: H() });
    const ended = await eventually(async () => {
      const c = await latestCall();
      return c.status === 'ended' ? c : null;
    });
    expect(ended.summary).toBeNull(); // summaries switched off for this agent
  }, 30_000);

  it('falls back to voicemail when the agent cannot work (no keys)', async () => {
    const agent = await createAgent({ engine: 'pipeline' });
    const accountId = await aiNumber(agent.id);
    const calling = (
      await app.inject({
        method: 'GET',
        url: `/api/whatsapp/accounts/${accountId}/calling`,
        headers: H(),
      })
    ).json();
    expect(calling.aiAvailable).toBe(false);
    await call(accountId);
    const row = await eventually(async () => {
      const c = await latestCall();
      return c.handledBy ? c : null;
    });
    expect(row.handledBy).toBe('voicemail');
  });
});
