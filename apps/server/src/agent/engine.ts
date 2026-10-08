import type { FastifyBaseLogger } from 'fastify';
import { FRAME_SAMPLES, type CallMediaSession } from '@flowforge/media';
import type { Brain } from './llm';
import { runTool, type AgentTool } from './tools';

/** What both engines get for one call. */
export interface EngineContext {
  session: CallMediaSession;
  /** Aborted when the call ends or a person takes over. */
  signal: AbortSignal;
  /** Fixed first sentence (incoming calls). */
  greeting: string | null;
  /** Instead of a greeting: let the model start (outbound calls), prompted with this text. */
  opening: string | null;
  tools: AgentTool[];
  transcript(role: 'caller' | 'agent', text: string): void;
  /** end_call was requested: hang up once the goodbye is spoken. */
  endRequested(): boolean;
  hangup(reason: string): Promise<void>;
  logger: FastifyBaseLogger;
}

export const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    });
  });

/** Wait until queued audio has been sent. */
export async function drained(session: CallMediaSession, signal: AbortSignal) {
  while (session.playing && !signal.aborted) await sleep(40, signal);
}

/** Streams audio into the call in whole 20 ms frames (so chunks don't get padded with silence). */
export class AudioOut {
  private rest = new Int16Array(0);

  constructor(private readonly session: CallMediaSession) {}

  write(samples: Int16Array) {
    const all = new Int16Array(this.rest.length + samples.length);
    all.set(this.rest);
    all.set(samples, this.rest.length);
    const whole = all.length - (all.length % FRAME_SAMPLES);
    if (whole) void this.session.play(all.subarray(0, whole));
    this.rest = all.slice(whole);
  }

  flush() {
    if (this.rest.length) void this.session.play(this.rest);
    this.rest = new Int16Array(0);
  }

  clear() {
    this.rest = new Int16Array(0);
  }
}

/** Splits streamed text into speakable sentences. */
export class SentenceSplitter {
  private buffer = '';

  push(delta: string): string[] {
    this.buffer += delta;
    const out: string[] = [];
    // Sentence end (also Hindi "।") followed by whitespace; skip tiny fragments like "Dr."
    const re = /[.!?।]+["')\]]*\s+|\n+/g;
    let start = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(this.buffer))) {
      const end = match.index + match[0].length;
      const sentence = this.buffer.slice(start, end).trim();
      if (sentence.length >= 12 || /\n/.test(match[0])) {
        if (sentence) out.push(sentence);
        start = end;
      }
    }
    this.buffer = this.buffer.slice(start);
    return out;
  }

  flush(): string[] {
    const rest = this.buffer.trim();
    this.buffer = '';
    return rest ? [rest] : [];
  }
}

/** Run a turn's tool calls, in order. */
export async function runToolCalls(
  tools: AgentTool[],
  calls: Array<{ id: string; name: string; input: unknown }>,
  logger: FastifyBaseLogger,
) {
  const results: Array<{ id: string; output: string; isError: boolean }> = [];
  for (const call of calls) {
    const result = await runTool(tools, call.name, call.input);
    if (result.isError) logger.warn({ tool: call.name, output: result.output }, 'Agent tool error');
    results.push({ id: call.id, ...result });
  }
  return results;
}

/** Voice activity on 20 ms frames: when the caller starts and stops talking. */
export class VoiceDetector {
  private voiced = 0;
  private quiet = 0;
  private speaking = false;
  private noiseFloor = 300;
  private buffer: Int16Array[] = [];
  private preRoll: Int16Array[] = [];

  constructor(
    private readonly events: {
      onSpeechStart(): void;
      onSpeechEnd(utterance: Int16Array): void;
    },
    private readonly options = { startFrames: 4, endFrames: 35, minVoicedFrames: 10 },
  ) {}

  private voicedFrames = 0;

  push(frame: Int16Array) {
    let sum = 0;
    for (let i = 0; i < frame.length; i++) sum += frame[i]! * frame[i]!;
    const level = Math.sqrt(sum / frame.length);
    const threshold = Math.max(500, this.noiseFloor * 3);
    const isVoice = level > threshold;
    if (!isVoice && !this.speaking) {
      // Slowly follow the background noise.
      this.noiseFloor = this.noiseFloor * 0.98 + level * 0.02;
    }
    if (!this.speaking) {
      this.preRoll.push(frame);
      if (this.preRoll.length > 15) this.preRoll.shift();
      this.voiced = isVoice ? this.voiced + 1 : 0;
      if (this.voiced >= this.options.startFrames) {
        this.speaking = true;
        this.quiet = 0;
        this.voicedFrames = this.voiced;
        this.buffer = [...this.preRoll];
        this.preRoll = [];
        this.events.onSpeechStart();
      }
      return;
    }
    this.buffer.push(frame);
    if (isVoice) {
      this.quiet = 0;
      this.voicedFrames++;
    } else if (++this.quiet >= this.options.endFrames) {
      this.speaking = false;
      this.voiced = 0;
      const frames = this.buffer;
      this.buffer = [];
      if (this.voicedFrames < this.options.minVoicedFrames) return; // a cough or a click
      const utterance = new Int16Array(frames.length * FRAME_SAMPLES);
      frames.forEach((f, i) => utterance.set(f, i * FRAME_SAMPLES));
      this.events.onSpeechEnd(utterance);
    }
  }

  get isSpeaking() {
    return this.speaking;
  }
}

/**
 * Pipeline engine: the caller's speech → speech-to-text → LLM (with tools) → text-to-speech.
 * Replies are spoken sentence by sentence while the LLM is still writing; when the caller talks
 * over the agent, playback stops at once and the unfinished reply is dropped (barge-in).
 */
export async function runPipeline(
  ctx: EngineContext,
  brain: Brain,
  speech: {
    transcribe(samples: Int16Array, signal: AbortSignal): Promise<string>;
    synthesize(text: string, signal: AbortSignal): Promise<Int16Array>;
  },
): Promise<void> {
  const { session, signal, logger } = ctx;
  let turn: AbortController | null = null;
  let turnRunning = false;
  let failures = 0;

  /** A turn: the caller's utterance (or, for the opening, a prompt that is not in the transcript). */
  const respond = async (input: Int16Array | { prompt: string }) => {
    turn?.abort();
    const controller = new AbortController();
    turn = controller;
    const turnSignal = AbortSignal.any([signal, controller.signal]);
    turnRunning = true;
    try {
      if (input instanceof Int16Array) {
        const text = await speech.transcribe(input, turnSignal);
        if (!text || turnSignal.aborted) return;
        ctx.transcript('caller', text);
        brain.addUser(text);
      } else {
        brain.addUser(input.prompt);
      }
      const spoken: string[] = [];
      for (let step = 0; step < 5 && !turnSignal.aborted; step++) {
        const splitter = new SentenceSplitter();
        let speaking = Promise.resolve();
        const queue = (sentences: string[]) => {
          if (!sentences.length) return;
          spoken.push(...sentences);
          // Synthesize right away (in parallel), play in order.
          const audio = sentences.map((t) => speech.synthesize(t, turnSignal));
          audio.forEach((p) => p.catch(() => undefined));
          speaking = speaking.then(async () => {
            for (const pending of audio) {
              const samples = await pending;
              if (turnSignal.aborted) return;
              void session.play(samples);
            }
          });
        };
        const result = await brain.generate((delta) => queue(splitter.push(delta)), turnSignal);
        queue(splitter.flush());
        await speaking;
        if (!result.toolCalls.length) break;
        const results = await runToolCalls(ctx.tools, result.toolCalls, logger);
        if (turnSignal.aborted) return;
        brain.addToolResults(results);
        // Goodbye already said with end_call: no need for another reply.
        if (result.text.trim() && result.toolCalls.every((c) => c.name === 'end_call')) break;
      }
      if (spoken.length) ctx.transcript('agent', spoken.join(' '));
      failures = 0;
      await drained(session, turnSignal);
      if (!turnSignal.aborted && ctx.endRequested()) await ctx.hangup('The agent ended the call');
    } catch (error) {
      if (turnSignal.aborted) return;
      logger.error({ err: error }, 'Agent turn failed');
      if (++failures >= 3) await ctx.hangup(`The AI agent stopped: ${(error as Error).message}`);
      else {
        const sorry = await speech
          .synthesize('Sorry, could you say that again?', signal)
          .catch(() => null);
        if (sorry) void session.play(sorry);
      }
    } finally {
      if (turn === controller) {
        turn = null;
        turnRunning = false;
      }
    }
  };

  const detector = new VoiceDetector({
    onSpeechStart: () => {
      // Barge-in: the caller talks over the agent.
      if (session.playing || turnRunning) {
        session.interrupt();
        turn?.abort();
      }
    },
    onSpeechEnd: (utterance) => void respond(utterance),
  });
  const off = session.onAudio((frame) => detector.push(frame));

  try {
    if (ctx.greeting) {
      const greeting = await speech.synthesize(ctx.greeting, signal);
      if (!signal.aborted) {
        void session.play(greeting);
        ctx.transcript('agent', ctx.greeting);
      }
    } else if (ctx.opening) {
      void respond({ prompt: ctx.opening });
    }
    await new Promise<void>((resolve) => {
      if (signal.aborted) resolve();
      signal.addEventListener('abort', () => resolve());
    });
  } finally {
    off();
    (turn as AbortController | null)?.abort();
  }
}
