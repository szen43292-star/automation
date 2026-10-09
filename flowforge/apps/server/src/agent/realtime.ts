import WebSocket from 'ws';
import { resample, SAMPLE_RATE } from '@flowforge/media';
import type { ProviderAccess } from '../ai/providers';
import { AudioOut, drained, runToolCalls, type EngineContext } from './engine';
import { pcmFromBytes, pcmToBytes } from './speech';

const RATE = 24_000;

/**
 * Realtime engine: one speech-to-speech model (OpenAI Realtime API) listens, thinks and talks.
 * Lowest latency; the server detects turns, and when the caller talks over the agent we stop
 * playback and tell the model how much of its reply was actually heard.
 */
export async function runRealtime(
  ctx: EngineContext,
  access: ProviderAccess,
  options: { model: string; voice: string; instructions: string; language: string },
): Promise<void> {
  const { session, signal, logger } = ctx;
  const url = `${access.baseUrl.replace(/^http/, 'ws')}/realtime?model=${encodeURIComponent(options.model)}`;
  const ws = new WebSocket(url, { headers: { authorization: `Bearer ${access.apiKey}` } });
  const out = new AudioOut(session);
  const send = (event: Record<string, unknown>) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(event));
  };

  // The reply being played: its item id and how much audio was queued for it.
  let currentItem: string | null = null;
  let currentItemMs = 0;
  let pendingCalls: Array<{ id: string; name: string; input: unknown }> = [];
  let ending = false;

  const finished = new Promise<void>((resolve, reject) => {
    ws.on('open', () => {
      send({
        type: 'session.update',
        session: {
          type: 'realtime',
          instructions: options.instructions,
          output_modalities: ['audio'],
          audio: {
            input: {
              format: { type: 'audio/pcm', rate: RATE },
              transcription: {
                model: 'gpt-4o-mini-transcribe',
                ...(options.language ? { language: options.language.split('-')[0] } : {}),
              },
              turn_detection: {
                type: 'server_vad',
                silence_duration_ms: 550,
                create_response: true,
                interrupt_response: true,
              },
            },
            output: { format: { type: 'audio/pcm', rate: RATE }, voice: options.voice },
          },
          tools: ctx.tools.map((t) => ({
            type: 'function',
            name: t.name,
            description: t.description,
            parameters: t.parameters,
          })),
          tool_choice: 'auto',
        },
      });
      send({
        type: 'response.create',
        response: {
          instructions: ctx.greeting
            ? `Greet the caller now by saying exactly: "${ctx.greeting}"`
            : (ctx.opening ?? 'Start the conversation.'),
        },
      });
    });

    ws.on('message', (raw) => {
      let event: any;
      try {
        event = JSON.parse(raw.toString());
      } catch {
        return;
      }
      switch (event.type) {
        case 'response.output_audio.delta':
        case 'response.audio.delta': {
          if (event.item_id !== currentItem) {
            currentItem = event.item_id;
            currentItemMs = 0;
          }
          const pcm = pcmFromBytes(Buffer.from(event.delta, 'base64'));
          currentItemMs += (pcm.length / RATE) * 1000;
          out.write(resample(pcm, RATE, SAMPLE_RATE));
          break;
        }
        case 'response.output_audio.done':
        case 'response.audio.done':
          out.flush();
          break;
        case 'response.output_audio_transcript.done':
        case 'response.audio_transcript.done':
          if (event.transcript) ctx.transcript('agent', event.transcript);
          break;
        case 'conversation.item.input_audio_transcription.completed':
          if (event.transcript?.trim()) ctx.transcript('caller', event.transcript.trim());
          break;
        case 'input_audio_buffer.speech_started':
          // Barge-in: stop talking and keep only what the caller actually heard.
          if (session.playing && currentItem) {
            const heard = Math.max(0, Math.round(currentItemMs - session.queuedMs));
            session.interrupt();
            out.clear();
            send({
              type: 'conversation.item.truncate',
              item_id: currentItem,
              content_index: 0,
              audio_end_ms: heard,
            });
          }
          break;
        case 'response.function_call_arguments.done': {
          let input: unknown = null;
          try {
            input = JSON.parse(event.arguments || '{}');
          } catch {
            input = null;
          }
          pendingCalls.push({ id: event.call_id, name: event.name, input });
          break;
        }
        case 'response.done': {
          const calls = pendingCalls;
          pendingCalls = [];
          const status = event.response?.status;
          if (calls.length && status !== 'cancelled') {
            void runToolCalls(ctx.tools, calls, logger).then((results) => {
              if (signal.aborted) return;
              for (const r of results) {
                send({
                  type: 'conversation.item.create',
                  item: { type: 'function_call_output', call_id: r.id, output: r.output },
                });
              }
              send({ type: 'response.create' });
            });
          } else if (ctx.endRequested() && !ending) {
            ending = true;
            void drained(session, signal).then(() => {
              if (!signal.aborted) void ctx.hangup('The agent ended the call');
            });
          }
          break;
        }
        case 'error': {
          const message = event.error?.message ?? 'Realtime API error';
          logger.warn({ error: event.error }, 'Realtime API error');
          if (/api key|auth|unauthori|quota|billing/i.test(message)) reject(new Error(message));
          break;
        }
      }
    });

    ws.on('unexpected-response', (_req, res) => {
      reject(
        new Error(
          res.statusCode === 401 || res.statusCode === 403
            ? 'OpenAI rejected the API key - check it in Settings → AI providers'
            : `OpenAI Realtime refused the connection (HTTP ${res.statusCode})`,
        ),
      );
    });
    ws.on('error', (error) => reject(error));
    ws.on('close', () => {
      if (signal.aborted) resolve();
      else reject(new Error('The realtime voice connection closed'));
    });
    signal.addEventListener('abort', () => resolve());
  });

  const off = session.onAudio((frame) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    const pcm = resample(frame, SAMPLE_RATE, RATE);
    send({ type: 'input_audio_buffer.append', audio: pcmToBytes(pcm).toString('base64') });
  });

  try {
    await finished;
  } finally {
    off();
    ws.removeAllListeners('close');
    ws.on('error', () => undefined);
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.terminate();
  }
}
