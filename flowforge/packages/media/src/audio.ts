/** 16-bit PCM helpers. Call audio runs at 48 kHz mono in 20 ms frames (960 samples). */

export const SAMPLE_RATE = 48_000;
export const FRAME_MS = 20;
export const FRAME_SAMPLES = (SAMPLE_RATE * FRAME_MS) / 1000;

/** Linear-interpolation resampler (good enough for speech). */
export function resample(input: Int16Array, from: number, to: number): Int16Array {
  if (from === to || input.length === 0) return input;
  const outLength = Math.max(1, Math.round((input.length * to) / from));
  const out = new Int16Array(outLength);
  const ratio = from / to;
  for (let i = 0; i < outLength; i++) {
    const position = i * ratio;
    const index = Math.floor(position);
    const fraction = position - index;
    const a = input[index] ?? 0;
    const b = input[Math.min(index + 1, input.length - 1)] ?? a;
    out[i] = Math.round(a + (b - a) * fraction);
  }
  return out;
}

/** Root mean square level, 0…1. */
export function rms(samples: Int16Array): number {
  if (!samples.length) return 0;
  let sum = 0;
  for (const s of samples) sum += s * s;
  return Math.sqrt(sum / samples.length) / 32768;
}

/** A sine tone (e.g. a beep before voicemail). */
export function tone(frequency: number, ms: number, volume = 0.3, sampleRate = SAMPLE_RATE): Int16Array {
  const length = Math.round((sampleRate * ms) / 1000);
  const out = new Int16Array(length);
  const fade = Math.min(length / 2, sampleRate * 0.01);
  for (let i = 0; i < length; i++) {
    const envelope = Math.min(1, i / fade, (length - i) / fade);
    out[i] = Math.round(Math.sin((2 * Math.PI * frequency * i) / sampleRate) * volume * envelope * 32767);
  }
  return out;
}

export function silence(ms: number, sampleRate = SAMPLE_RATE): Int16Array {
  return new Int16Array(Math.round((sampleRate * ms) / 1000));
}

export function concat(...parts: Int16Array[]): Int16Array {
  const out = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Split audio into 20 ms frames (the last one padded with silence). */
export function frames(samples: Int16Array, frameSamples = FRAME_SAMPLES): Int16Array[] {
  const out: Int16Array[] = [];
  for (let i = 0; i < samples.length; i += frameSamples) {
    const frame = new Int16Array(frameSamples);
    frame.set(samples.subarray(i, i + frameSamples));
    out.push(frame);
  }
  return out;
}

export interface DecodedWav {
  sampleRate: number;
  channels: number;
  /** Mono samples (channels are averaged). */
  samples: Int16Array;
}

/** Read a PCM WAV file (8/16-bit, any rate, mono or stereo). */
export function parseWav(buffer: Buffer): DecodedWav {
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Not a WAV file - use a PCM .wav file');
  }
  let offset = 12;
  let format: { audioFormat: number; channels: number; sampleRate: number; bitsPerSample: number } | null = null;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ') {
      format = {
        audioFormat: buffer.readUInt16LE(body),
        channels: buffer.readUInt16LE(body + 2),
        sampleRate: buffer.readUInt32LE(body + 4),
        bitsPerSample: buffer.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      if (!format) throw new Error('WAV file has no format chunk');
      if (format.audioFormat !== 1 && format.audioFormat !== 0xfffe) throw new Error('Only uncompressed PCM WAV files are supported');
      const bytes = format.bitsPerSample / 8;
      const end = Math.min(buffer.length, body + size);
      const count = Math.floor((end - body) / (bytes * format.channels));
      const samples = new Int16Array(count);
      for (let i = 0; i < count; i++) {
        let sum = 0;
        for (let c = 0; c < format.channels; c++) {
          const at = body + (i * format.channels + c) * bytes;
          sum += format.bitsPerSample === 8 ? (buffer.readUInt8(at) - 128) << 8 : buffer.readInt16LE(at);
        }
        samples[i] = Math.round(sum / format.channels);
      }
      return { sampleRate: format.sampleRate, channels: format.channels, samples };
    }
    offset = body + size + (size % 2);
  }
  throw new Error('WAV file has no audio data');
}

/** Write 16-bit PCM WAV. `channels` are interleaved from the given arrays (same length). */
export function encodeWav(channels: Int16Array[], sampleRate: number): Buffer {
  const length = Math.max(...channels.map((c) => c.length), 0);
  const data = Buffer.alloc(length * channels.length * 2);
  for (let i = 0; i < length; i++) {
    for (let c = 0; c < channels.length; c++) data.writeInt16LE(channels[c]![i] ?? 0, (i * channels.length + c) * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels.length, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels.length * 2, 28);
  header.writeUInt16LE(channels.length * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/** Load a greeting/prompt WAV as 48 kHz mono. */
export function loadPrompt(buffer: Buffer): Int16Array {
  const wav = parseWav(buffer);
  return resample(wav.samples, wav.sampleRate, SAMPLE_RATE);
}
