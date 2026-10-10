import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import { parseWav, tone } from '@flowforge/media';

/**
 * Fake AI providers for tests: Anthropic Messages (streaming with thinking + tool use),
 * OpenAI chat completions / transcriptions / speech, Deepgram, and the OpenAI Realtime API.
 *
 * "Speech" is encoded as tone pitch: the caller plays a tone and the fake speech-to-text maps
 * its frequency to a sentence. Synthesized speech is a 500 Hz tone.
 */
export const PHRASES: Array<{ hz: number; text: string }> = [
  { hz: 400, text: 'What is the price of a haircut?' },
  { hz: 700, text: 'Can I talk to a human please?' },
  { hz: 1000, text: 'Thanks, bye.' },
  { hz: 1300, text: 'Tell me a long story.' },
];

export function phraseFor(samples: Int16Array, sampleRate: number): string {
  // Pitch from zero crossings inside the loud 20 ms windows.
  const window = Math.round(sampleRate / 50);
  let crossings = 0;
  let loud = 0;
  for (let start = 0; start + window <= samples.length; start += window) {
    let sum = 0;
    for (let i = start; i < start + window; i++) sum += samples[i]! * samples[i]!;
    if (Math.sqrt(sum / window) < 1500) continue;
    loud += window;
    for (let i = start + 1; i < start + window; i++)
      if (samples[i - 1]! < 0 !== samples[i]! < 0) crossings++;
  }
  if (loud < sampleRate * 0.1) return '';
  const hz = (crossings / 2) * (sampleRate / loud);
  let best = PHRASES[0]!;
  for (const p of PHRASES) if (Math.abs(p.hz - hz) < Math.abs(best.hz - hz)) best = p;
  return best.text;
}

export interface FakeRequest {
  path: string;
  headers: IncomingMessage['headers'];
  body: any;
}

type Reply = {
  thinking?: string;
  text?: string;
  tool?: { name: string; input: Record<string, string> };
};

/** The scripted "model": what to answer to the conversation so far. */
function decide(lastUserText: string, lastToolResult: string | null, toolNames: string[]): Reply {
  if (lastToolResult !== null) {
    if (/Nobody/.test(lastToolResult))
      return { text: 'Sorry, nobody is free right now. I can take a message.' };
    if (/call will end/i.test(lastToolResult)) return { text: 'Goodbye!' };
    if (/Sent/.test(lastToolResult)) return { text: 'I sent it to you on WhatsApp.' };
    const firstLine = lastToolResult.split('\n').find((l) => /\d/.test(l)) ?? lastToolResult;
    return { text: `Here is what I found. ${firstLine.trim()}` };
  }
  const has = (name: string) => toolNames.includes(name);
  if (/price/i.test(lastUserText) && has('search_knowledge'))
    return {
      thinking: 'Look up the price.',
      text: 'Let me check that for you.',
      tool: { name: 'search_knowledge', input: { query: 'haircut price' } },
    };
  if (/human|person/i.test(lastUserText) && has('transfer_to_human'))
    return {
      text: 'Sure, connecting you to the team now.',
      tool: { name: 'transfer_to_human', input: { reason: 'Caller asked for a person' } },
    };
  if (/bye/i.test(lastUserText) && has('end_call'))
    return {
      text: 'Thank you for calling, goodbye!',
      tool: { name: 'end_call', input: { reason: 'Caller said bye' } },
    };
  if (/book/i.test(lastUserText) && has('book_appointment'))
    return {
      text: 'Booking that.',
      tool: { name: 'book_appointment', input: { day: 'tomorrow', service: 'haircut' } },
    };
  if (/whatsapp/i.test(lastUserText) && has('send_whatsapp_message'))
    return { tool: { name: 'send_whatsapp_message', input: { text: 'Our address: 12 MG Road' } } };
  if (/long story/i.test(lastUserText))
    return {
      text: 'Once upon a time there was a small salon. It grew and grew over many long years. Everyone in town came to it. This story goes on for a while longer still. The end is far away.',
    };
  return { text: `You said: ${lastUserText}` };
}

export async function startFakeAi(port = 0) {
  const requests: FakeRequest[] = [];
  const realtimeEvents: any[] = [];
  /** Sentences sent to text-to-speech. */
  const spoken: string[] = [];

  const readBody = (req: IncomingMessage) =>
    new Promise<Buffer>((resolve) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => resolve(Buffer.concat(chunks)));
    });

  const sse = (res: ServerResponse, events: Array<{ event?: string; data: unknown }>) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const e of events) {
      if (e.event) res.write(`event: ${e.event}\n`);
      res.write(`data: ${JSON.stringify(e.data)}\n\n`);
    }
    res.end();
  };

  const server: Server = createServer(async (req, res) => {
    const raw = await readBody(req);
    const path = (req.url ?? '').split('?')[0]!;
    const isJson = (req.headers['content-type'] ?? '').includes('json');
    const body = isJson && raw.length ? JSON.parse(raw.toString()) : null;
    requests.push({ path, headers: req.headers, body });
    const auth =
      req.headers.authorization ??
      req.headers['x-api-key'] ??
      req.headers['xi-api-key'] ??
      req.headers['api-subscription-key'];
    if (String(auth).includes('bad-key')) {
      res.writeHead(401, { 'content-type': 'application/json' });
      return res.end(
        JSON.stringify({
          type: 'error',
          error: { type: 'authentication_error', message: 'invalid x-api-key' },
        }),
      );
    }

    // ---- Model lists: a Groq key (gsk_…) that cannot use llama-3.3-70b-versatile ----
    if (path === '/v1/models') {
      if (!String(auth).includes('gsk_')) {
        res.writeHead(404, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'not listed here' } }));
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(
        JSON.stringify({
          object: 'list',
          data: [
            { id: 'meta-llama/llama-guard-4-12b' },
            { id: 'openai/gpt-oss-120b' },
            { id: 'llama-3.1-8b-instant' },
            { id: 'whisper-large-v3' },
          ],
        }),
      );
    }

    // ---- Anthropic Messages ----
    if (path === '/v1/messages') {
      const system = typeof body.system === 'string' ? body.system : '';
      const lastUser = [...body.messages].reverse().find((m: any) => m.role === 'user');
      const blocks =
        typeof lastUser.content === 'string'
          ? [{ type: 'text', text: lastUser.content }]
          : lastUser.content;
      const toolResult = blocks.find((b: any) => b.type === 'tool_result');
      const userText = blocks
        .filter((b: any) => b.type === 'text')
        .map((b: any) => b.text)
        .join(' ');
      const reply: Reply = /call notes/.test(system)
        ? {
            text: `${/price/i.test(userText) ? 'The caller asked about haircut prices' : 'The caller called'} and the agent helped.`,
          }
        : decide(
            userText,
            toolResult ? String(toolResult.content) : null,
            (body.tools ?? []).map((t: any) => t.name),
          );
      const content: any[] = [];
      if (reply.thinking)
        content.push({ type: 'thinking', thinking: reply.thinking, signature: 'sig-123' });
      if (reply.text) content.push({ type: 'text', text: reply.text });
      if (reply.tool)
        content.push({
          type: 'tool_use',
          id: `toolu_${requests.length}`,
          name: reply.tool.name,
          input: reply.tool.input,
        });
      const stopReason = reply.tool ? 'tool_use' : 'end_turn';
      const message = {
        id: `msg_${requests.length}`,
        type: 'message',
        role: 'assistant',
        model: body.model,
        content,
        stop_reason: stopReason,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 10 },
      };
      if (!body.stream) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify(message));
      }
      const events: Array<{ event: string; data: unknown }> = [
        {
          event: 'message_start',
          data: { type: 'message_start', message: { ...message, content: [], stop_reason: null } },
        },
      ];
      content.forEach((block, index) => {
        if (block.type === 'thinking') {
          events.push({
            event: 'content_block_start',
            data: {
              type: 'content_block_start',
              index,
              content_block: { type: 'thinking', thinking: '', signature: '' },
            },
          });
          events.push({
            event: 'content_block_delta',
            data: {
              type: 'content_block_delta',
              index,
              delta: { type: 'thinking_delta', thinking: block.thinking },
            },
          });
          events.push({
            event: 'content_block_delta',
            data: {
              type: 'content_block_delta',
              index,
              delta: { type: 'signature_delta', signature: block.signature },
            },
          });
        } else if (block.type === 'text') {
          events.push({
            event: 'content_block_start',
            data: { type: 'content_block_start', index, content_block: { type: 'text', text: '' } },
          });
          for (const word of block.text.match(/\S+\s*/g) ?? [])
            events.push({
              event: 'content_block_delta',
              data: {
                type: 'content_block_delta',
                index,
                delta: { type: 'text_delta', text: word },
              },
            });
        } else {
          events.push({
            event: 'content_block_start',
            data: {
              type: 'content_block_start',
              index,
              content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} },
            },
          });
          events.push({
            event: 'content_block_delta',
            data: {
              type: 'content_block_delta',
              index,
              delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) },
            },
          });
        }
        events.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index } });
      });
      events.push({
        event: 'message_delta',
        data: {
          type: 'message_delta',
          delta: { stop_reason: stopReason, stop_sequence: null },
          usage: { output_tokens: 10 },
        },
      });
      events.push({ event: 'message_stop', data: { type: 'message_stop' } });
      return sse(res, events);
    }

    // ---- OpenAI chat completions ----
    if (path === '/v1/chat/completions') {
      const system = body.messages[0]?.content ?? '';
      const last = body.messages.at(-1);
      const lastUser = [...body.messages].reverse().find((m: any) => m.role === 'user');
      const reply: Reply = /call notes/.test(system)
        ? { text: 'The caller called and the agent helped.' }
        : decide(
            lastUser?.content ?? '',
            last.role === 'tool' ? last.content : null,
            (body.tools ?? []).map((t: any) => t.function.name),
          );
      if (!body.stream) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(
          JSON.stringify({
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: reply.text ?? '' },
                finish_reason: 'stop',
              },
            ],
          }),
        );
      }
      const chunks: unknown[] = [];
      for (const word of reply.text?.match(/\S+\s*/g) ?? [])
        chunks.push({ choices: [{ index: 0, delta: { content: word } }] });
      if (reply.tool) {
        const args = JSON.stringify(reply.tool.input);
        chunks.push({
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: `call_${requests.length}`,
                    type: 'function',
                    function: { name: reply.tool.name, arguments: args.slice(0, 5) },
                  },
                ],
              },
            },
          ],
        });
        chunks.push({
          choices: [
            {
              index: 0,
              delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(5) } }] },
            },
          ],
        });
      }
      chunks.push({
        choices: [{ index: 0, delta: {}, finish_reason: reply.tool ? 'tool_calls' : 'stop' }],
      });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
      res.write('data: [DONE]\n\n');
      return res.end();
    }

    // ---- Speech-to-text (OpenAI multipart, Deepgram raw WAV) ----
    if (
      path === '/v1/audio/transcriptions' ||
      path === '/v1/listen' ||
      path === '/speech-to-text'
    ) {
      let wav = raw;
      if (path !== '/v1/listen') {
        const start = raw.indexOf('RIFF');
        wav = raw.subarray(start);
      }
      const decoded = parseWav(wav);
      const text = phraseFor(decoded.samples, decoded.sampleRate);
      res.writeHead(200, { 'content-type': 'application/json' });
      if (path === '/v1/listen')
        return res.end(
          JSON.stringify({ results: { channels: [{ alternatives: [{ transcript: text }] }] } }),
        );
      if (path === '/speech-to-text') return res.end(JSON.stringify({ transcript: text }));
      return res.end(JSON.stringify({ text }));
    }

    // ---- Text-to-speech: 24 kHz PCM tone ----
    if (path === '/v1/audio/speech' || path.startsWith('/v1/text-to-speech/')) {
      const text: string = body.input ?? body.text;
      spoken.push(text);
      const ms = Math.min(4000, 250 + text.length * 25);
      const pcm = tone(500, ms, 0.4, 24_000);
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      return res.end(Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength));
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `Fake AI: no route ${path}` } }));
  });

  // ---- OpenAI Realtime (WebSocket) ----
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    if (!(req.url ?? '').startsWith('/v1/realtime')) return socket.destroy();
    if (String(req.headers.authorization).includes('bad-key')) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => realtimeSession(ws, req.url ?? ''));
  });

  function realtimeSession(ws: WebSocket, url: string) {
    const send = (e: Record<string, unknown>) => ws.send(JSON.stringify(e));
    let tools: string[] = [];
    let responseId = 0;
    let item = 0;
    let voiced = 0;
    let quiet = 0;
    let speaking = false;
    let utterance: Int16Array[] = [];
    let lastUserText = '';
    let lastToolOutput: string | null = null;
    let streaming: NodeJS.Timeout | null = null;

    const respond = (reply: Reply) => {
      const id = `resp_${++responseId}`;
      if (reply.tool) {
        send({
          type: 'response.function_call_arguments.done',
          response_id: id,
          call_id: `call_${id}`,
          name: reply.tool.name,
          arguments: JSON.stringify(reply.tool.input),
        });
        send({ type: 'response.done', response: { id, status: 'completed' } });
        return;
      }
      const itemId = `item_${++item}`;
      const text = reply.text ?? '';
      const pcm = tone(500, Math.min(6000, 300 + text.length * 30), 0.4, 24_000);
      // Stream 100 ms chunks a little faster than real time.
      let offset = 0;
      const step = 2400;
      const tick = () => {
        if (offset >= pcm.length) {
          streaming = null;
          send({ type: 'response.output_audio.done', item_id: itemId });
          send({
            type: 'response.output_audio_transcript.done',
            item_id: itemId,
            transcript: text,
          });
          send({ type: 'response.done', response: { id, status: 'completed' } });
          return;
        }
        const chunk = pcm.subarray(offset, offset + step);
        offset += step;
        send({
          type: 'response.output_audio.delta',
          item_id: itemId,
          delta: Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).toString('base64'),
        });
        streaming = setTimeout(tick, 50);
      };
      tick();
    };

    ws.on('message', (data) => {
      const event = JSON.parse(data.toString());
      if (event.type !== 'input_audio_buffer.append') realtimeEvents.push({ ...event, url });
      switch (event.type) {
        case 'session.update':
          tools = (event.session.tools ?? []).map((t: any) => t.name);
          send({ type: 'session.updated', session: event.session });
          break;
        case 'response.create': {
          const instructions: string = event.response?.instructions ?? '';
          const greeting = instructions.match(/"(.*)"/)?.[1];
          if (greeting) respond({ text: greeting });
          else respond(decide(lastUserText, lastToolOutput, tools));
          lastToolOutput = null;
          break;
        }
        case 'conversation.item.create':
          if (event.item?.type === 'function_call_output') lastToolOutput = event.item.output;
          break;
        case 'input_audio_buffer.append': {
          const bytes = Buffer.from(event.audio, 'base64');
          const pcm = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.length / 2);
          let sum = 0;
          for (const s of pcm) sum += s * s;
          const isVoice = Math.sqrt(sum / pcm.length) > 1500;
          if (!speaking) {
            voiced = isVoice ? voiced + 1 : 0;
            if (voiced >= 3) {
              speaking = true;
              quiet = 0;
              utterance = [];
              send({
                type: 'input_audio_buffer.speech_started',
                audio_start_ms: 0,
                item_id: `item_${++item}`,
              });
              if (streaming) {
                clearTimeout(streaming);
                streaming = null;
                send({
                  type: 'response.done',
                  response: { id: `resp_${responseId}`, status: 'cancelled' },
                });
              }
            }
          }
          if (speaking) {
            utterance.push(Int16Array.from(pcm));
            if (isVoice) quiet = 0;
            else if (++quiet >= 20) {
              speaking = false;
              voiced = 0;
              send({ type: 'input_audio_buffer.speech_stopped' });
              const all = new Int16Array(utterance.reduce((n, u) => n + u.length, 0));
              let at = 0;
              for (const u of utterance) {
                all.set(u, at);
                at += u.length;
              }
              lastUserText = phraseFor(all, 24_000);
              send({
                type: 'conversation.item.input_audio_transcription.completed',
                transcript: lastUserText,
              });
              respond(decide(lastUserText, null, tools));
            }
          }
          break;
        }
      }
    });
    ws.on('close', () => {
      if (streaming) clearTimeout(streaming);
    });
  }

  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base,
    requests,
    realtimeEvents,
    spoken,
    env: {
      OPENAI_BASE_URL: `${base}/v1`,
      ANTHROPIC_BASE_URL: base,
      GEMINI_BASE_URL: `${base}/v1`,
      DEEPGRAM_BASE_URL: base,
      ELEVENLABS_BASE_URL: base,
      SARVAM_BASE_URL: base,
      GROQ_BASE_URL: `${base}/v1`,
    },
    close: async () => {
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
