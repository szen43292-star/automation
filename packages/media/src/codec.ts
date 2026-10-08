import OpusScript from 'opusscript';
import { FRAME_SAMPLES, SAMPLE_RATE } from './audio';

/** Opus at 48 kHz mono, 20 ms frames - what WhatsApp calls use. One instance per direction. */
export class OpusCodec {
  private readonly opus = new OpusScript(SAMPLE_RATE, 1, OpusScript.Application.VOIP);

  encode(frame: Int16Array): Buffer {
    const pcm = Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength);
    return Buffer.from(this.opus.encode(pcm, FRAME_SAMPLES));
  }

  decode(packet: Buffer): Int16Array {
    const pcm = this.opus.decode(packet);
    const copy = Buffer.from(pcm);
    return new Int16Array(copy.buffer, copy.byteOffset, copy.byteLength / 2);
  }

  close() {
    this.opus.delete();
  }
}
