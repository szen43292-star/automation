import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { startStunServer } from './stun';
import {
  CallMediaSession,
  CallRecorder,
  OpusCodec,
  SAMPLE_RATE,
  concat,
  encodeWav,
  frames,
  loadPrompt,
  parseWav,
  resample,
  rms,
  silence,
  tone,
} from '../src';

// werift always queries a STUN server; a local one keeps tests fast and offline.
let stun: Awaited<ReturnType<typeof startStunServer>>;
beforeAll(async () => {
  stun = await startStunServer();
});
afterAll(() => stun.close());

const sessions: CallMediaSession[] = [];
const session = () => {
  const s = new CallMediaSession({ iceServers: [{ urls: stun.url }], allowLoopback: true });
  sessions.push(s);
  return s;
};
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.close()));
});

/** Caller (like WhatsApp) offers, the server answers - over real WebRTC on localhost. */
async function connectPair() {
  const caller = session();
  const server = session();
  const answer = await server.answer(await caller.offer());
  await caller.acceptAnswer(answer);
  await Promise.all([caller.connected(), server.connected()]);
  return { caller, server };
}

describe('audio helpers', () => {
  it('resamples, frames, measures and round-trips WAV', () => {
    const beep = tone(440, 100);
    expect(beep).toHaveLength(4800);
    expect(rms(beep)).toBeGreaterThan(0.1);
    expect(rms(silence(100))).toBe(0);
    expect(resample(beep, SAMPLE_RATE, 16_000)).toHaveLength(1600);
    expect(frames(concat(beep, silence(5)))).toHaveLength(6);
    const wav = encodeWav([resample(beep, SAMPLE_RATE, 8000)], 8000);
    const parsed = parseWav(wav);
    expect(parsed).toMatchObject({ sampleRate: 8000, channels: 1 });
    expect(loadPrompt(wav)).toHaveLength(4800);
    expect(() => parseWav(Buffer.from('not audio'))).toThrow('Not a WAV file');
  });

  it('encodes and decodes Opus frames', () => {
    const codec = new OpusCodec();
    const frame = tone(300, 20);
    const packet = codec.encode(frame);
    expect(packet.length).toBeLessThan(400);
    const decoded = codec.decode(packet);
    expect(decoded).toHaveLength(960);
    codec.close();
  });
});

describe('call media session', () => {
  it('connects over WebRTC and carries audio from caller to server', async () => {
    const { caller, server } = await connectPair();
    const heard: number[] = [];
    server.onAudio((frame) => heard.push(rms(frame)));
    await caller.play(tone(440, 600));
    await new Promise((r) => setTimeout(r, 200));
    expect(heard.length).toBeGreaterThan(20);
    expect(Math.max(...heard)).toBeGreaterThan(0.05);
    expect(server.lastVoiceAt).toBeGreaterThan(0);
  }, 20_000);

  it('plays prompts, can be interrupted (barge-in) and records both sides', async () => {
    const { caller, server } = await connectPair();
    const recorder = new CallRecorder();
    server.onAudio((f) => recorder.caller(f));
    server.onSent((f) => recorder.agent(f));
    const long = server.play(tone(500, 5000));
    await new Promise((r) => setTimeout(r, 300));
    expect(server.playing).toBe(true);
    server.interrupt();
    await long;
    expect(server.playing).toBe(false);
    await caller.play(tone(700, 300));
    const wav = parseWav(recorder.finish());
    expect(wav.channels).toBe(2);
    expect(wav.sampleRate).toBe(16_000);
    expect(wav.samples.length).toBeGreaterThan(16_000 * 0.4);
  }, 20_000);

  it('bridges two calls so they hear each other', async () => {
    const a = await connectPair();
    const b = await connectPair();
    const unbridge = a.server.bridge(b.server);
    const heardByB: number[] = [];
    b.caller.onAudio((frame) => heardByB.push(rms(frame)));
    await a.caller.play(tone(440, 600));
    await new Promise((r) => setTimeout(r, 200));
    expect(Math.max(...heardByB)).toBeGreaterThan(0.05);
    unbridge();
  }, 30_000);
});
