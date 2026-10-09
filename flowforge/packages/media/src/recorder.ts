import { SAMPLE_RATE, encodeWav, resample } from './audio';

/**
 * Records both sides of a call into a stereo WAV: the caller on the left, our side (AI, prompt or
 * the person who answered) on the right. Stored at 16 kHz to keep files small.
 */
export class CallRecorder {
  private readonly left: Int16Array[] = [];
  private readonly right: Int16Array[] = [];
  private readonly startedAt = Date.now();
  private stopped = false;

  constructor(
    private readonly outputRate = 16_000,
    private readonly maxSeconds = 60 * 60,
  ) {}

  /** Both sides are continuous 20 ms streams (silence included), so they stay aligned. */
  private add(track: Int16Array[], frame: Int16Array) {
    if (this.stopped || (Date.now() - this.startedAt) / 1000 > this.maxSeconds) return;
    track.push(frame);
  }

  caller(frame: Int16Array) {
    this.add(this.left, frame);
  }

  agent(frame: Int16Array) {
    this.add(this.right, frame);
  }

  get seconds(): number {
    return (Date.now() - this.startedAt) / 1000;
  }

  /** The finished recording as WAV bytes. */
  finish(): Buffer {
    this.stopped = true;
    const join = (parts: Int16Array[]) => {
      const out = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
      let offset = 0;
      for (const p of parts) {
        out.set(p, offset);
        offset += p.length;
      }
      return resample(out, SAMPLE_RATE, this.outputRate);
    };
    return encodeWav([join(this.left), join(this.right)], this.outputRate);
  }
}
