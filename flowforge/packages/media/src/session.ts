import {
  MediaStreamTrack,
  RTCPeerConnection,
  RTCRtpCodecParameters,
  RtpHeader,
  RtpPacket,
  type RTCIceServer,
} from 'werift';
import { FRAME_MS, FRAME_SAMPLES, frames } from './audio';
import { OpusCodec } from './codec';

export interface MediaConfig {
  /** STUN/TURN servers used to find the public address (default: Google STUN). */
  iceServers?: RTCIceServer[];
  /** UDP ports for call media, e.g. [40000, 40100] - open these in the firewall. */
  portRange?: [number, number];
  /** Extra addresses to offer as host candidates (e.g. the server's public IP behind 1:1 NAT). */
  additionalHostAddresses?: string[];
  /** Allow loopback candidates (tests and calls on the same machine). */
  allowLoopback?: boolean;
}

export type SessionState =
  'new' | 'connecting' | 'connected' | 'disconnected' | 'failed' | 'closed';

type Listener<T> = (value: T) => void;

/**
 * One side of a call's audio: a WebRTC peer that talks Opus with WhatsApp (or a browser).
 * Incoming audio is decoded to 48 kHz PCM frames; outgoing audio is played from PCM or bridged.
 */
export class CallMediaSession {
  readonly pc: RTCPeerConnection;
  private readonly track = new MediaStreamTrack({ kind: 'audio' });
  private readonly decoder = new OpusCodec();
  private readonly encoder = new OpusCodec();
  private readonly frameListeners = new Set<Listener<Int16Array>>();
  private readonly packetListeners = new Set<Listener<Buffer>>();
  private readonly stateListeners = new Set<Listener<SessionState>>();
  private readonly sentListeners = new Set<Listener<Int16Array>>();
  private readonly silencePcm = new Int16Array(FRAME_SAMPLES);
  private queue: Int16Array[] = [];
  private queueDone: Array<() => void> = [];
  private bridged = false;
  private timer: NodeJS.Timeout | null = null;
  private sequence = Math.floor(Math.random() * 65_535);
  private timestamp = Math.floor(Math.random() * 2 ** 31);
  private payloadType = 111;
  private silenceFrame: Buffer;
  state: SessionState = 'new';
  private readonly usesStun: boolean;
  /** Last time audio louder than silence arrived (for "is the caller talking?"). */
  lastVoiceAt = 0;

  constructor(config: MediaConfig = {}) {
    const iceServers = config.iceServers ?? [{ urls: 'stun:stun.l.google.com:19302' }];
    this.usesStun = iceServers.length > 0;
    this.pc = new RTCPeerConnection({
      codecs: {
        audio: [
          new RTCRtpCodecParameters({
            mimeType: 'audio/opus',
            clockRate: 48_000,
            channels: 2,
            payloadType: 111,
          }),
        ],
      },
      iceServers,
      ...(config.portRange ? { icePortRange: config.portRange } : {}),
      iceAdditionalHostAddresses: [
        ...(config.additionalHostAddresses ?? []),
        ...(config.allowLoopback ? ['127.0.0.1'] : []),
      ],
      iceUseIpv6: false,
    });
    this.silenceFrame = this.encoder.encode(new Int16Array(FRAME_SAMPLES));
    this.pc.onTrack.subscribe((track) => {
      track.onReceiveRtp.subscribe((rtp) => this.receive(rtp));
    });
    this.pc.connectionStateChange.subscribe((state) => {
      const mapped: SessionState =
        state === 'connected'
          ? 'connected'
          : state === 'failed'
            ? 'failed'
            : state === 'closed'
              ? 'closed'
              : state === 'disconnected'
                ? 'disconnected'
                : 'connecting';
      if (mapped === 'connected' && this.state !== 'connected') this.startClock();
      this.setState(mapped);
    });
  }

  // ---- Signalling -------------------------------------------------------------------------------

  /** Answer a call offer (e.g. from a WhatsApp "connect" webhook). Returns the full answer SDP. */
  async answer(offerSdp: string): Promise<string> {
    this.setState('connecting');
    await this.pc.setRemoteDescription({ type: 'offer', sdp: offerSdp });
    const transceiver = this.pc.getTransceivers().find((t) => t.kind === 'audio');
    if (!transceiver) throw new Error('The call offer has no audio');
    transceiver.setDirection('sendrecv');
    await transceiver.sender.replaceTrack(this.track);
    this.rememberPayloadType();
    await this.pc.setLocalDescription(await this.pc.createAnswer());
    await this.gathered();
    return this.pc.localDescription!.sdp;
  }

  /** Start a call (business-initiated or a test caller). Returns the full offer SDP. */
  async offer(): Promise<string> {
    this.setState('connecting');
    this.pc.addTransceiver(this.track, { direction: 'sendrecv' });
    await this.pc.setLocalDescription(await this.pc.createOffer());
    await this.gathered();
    return this.pc.localDescription!.sdp;
  }

  async acceptAnswer(answerSdp: string): Promise<void> {
    await this.pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
    this.rememberPayloadType();
  }

  private rememberPayloadType() {
    const sdp = this.pc.remoteDescription?.sdp ?? '';
    const match = /a=rtpmap:(\d+) opus\/48000/i.exec(sdp);
    if (match) this.payloadType = Number(match[1]);
  }

  /**
   * WhatsApp exchanges complete SDPs (no trickle ICE), so candidates must be in the SDP. Host
   * candidates appear at once; with STUN we also wait for the public (srflx) one. werift only
   * reports "complete" after an internal timeout, so we don't wait for that.
   */
  private async gathered(maxMs = 2_500) {
    const deadline = Date.now() + maxMs;
    while (this.pc.iceGatheringState !== 'complete' && Date.now() < deadline) {
      const sdp = this.pc.localDescription?.sdp ?? '';
      if (/typ host/.test(sdp) && (!this.usesStun || /typ srflx/.test(sdp))) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  // ---- Receiving --------------------------------------------------------------------------------

  private receive(rtp: RtpPacket) {
    if (!rtp.payload.length) return;
    for (const listener of this.packetListeners) listener(rtp.payload);
    if (!this.frameListeners.size) return;
    let pcm: Int16Array;
    try {
      pcm = this.decoder.decode(rtp.payload);
    } catch {
      return; // corrupt packet
    }
    let peak = 0;
    for (const s of pcm) if (Math.abs(s) > peak) peak = Math.abs(s);
    if (peak > 1500) this.lastVoiceAt = Date.now();
    for (const listener of this.frameListeners) listener(pcm);
  }

  /** Decoded audio from the other side, 20 ms at 48 kHz mono. Returns an unsubscribe function. */
  onAudio(listener: Listener<Int16Array>): () => void {
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  }

  /** Every 20 ms frame this side sends (played audio or silence) - for recordings. */
  onSent(listener: Listener<Int16Array>): () => void {
    this.sentListeners.add(listener);
    return () => this.sentListeners.delete(listener);
  }

  onState(listener: Listener<SessionState>): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  /** Resolves when connected; rejects when the connection fails or times out. */
  connected(timeoutMs = 20_000): Promise<void> {
    if (this.state === 'connected') return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error('Call audio did not connect'));
      }, timeoutMs);
      const off = this.onState((state) => {
        if (state === 'connected') {
          clearTimeout(timer);
          off();
          resolve();
        } else if (state === 'failed' || state === 'closed') {
          clearTimeout(timer);
          off();
          reject(new Error(`Call audio ${state}`));
        }
      });
    });
  }

  // ---- Sending ----------------------------------------------------------------------------------

  /** Queue audio to play to the other side. Resolves when it has been played (or interrupted). */
  play(samples: Int16Array): Promise<void> {
    this.queue.push(...frames(samples));
    return new Promise((resolve) => this.queueDone.push(resolve));
  }

  /** Stop what is playing now (e.g. the caller started talking: barge-in). */
  interrupt() {
    this.queue = [];
    this.flushDone();
  }

  get playing(): boolean {
    return this.queue.length > 0;
  }

  /** Milliseconds of queued audio not played yet. */
  get queuedMs(): number {
    return this.queue.length * FRAME_MS;
  }

  /** Forward audio packets both ways between two sessions without re-encoding. */
  bridge(other: CallMediaSession): () => void {
    this.interrupt();
    other.interrupt();
    this.bridged = other.bridged = true;
    const forward = (to: CallMediaSession) => (payload: Buffer) => to.sendPacket(payload);
    const a = forward(other);
    const b = forward(this);
    this.packetListeners.add(a);
    other.packetListeners.add(b);
    return () => {
      this.packetListeners.delete(a);
      other.packetListeners.delete(b);
      this.bridged = other.bridged = false;
    };
  }

  private flushDone() {
    const done = this.queueDone;
    this.queueDone = [];
    done.forEach((resolve) => resolve());
  }

  private sendPacket(payload: Buffer) {
    if (this.state !== 'connected') return;
    const header = new RtpHeader({
      payloadType: this.payloadType,
      sequenceNumber: this.sequence,
      timestamp: this.timestamp >>> 0,
      marker: false,
    });
    this.sequence = (this.sequence + 1) & 0xffff;
    this.timestamp = (this.timestamp + FRAME_SAMPLES) % 2 ** 32;
    this.track.writeRtp(new RtpPacket(header, payload));
  }

  /** A steady 20 ms clock: queued audio, or silence, so the far end hears a continuous stream. */
  private startClock() {
    if (this.timer) return;
    const started = Date.now();
    let tick = 0;
    const step = () => {
      tick++;
      if (!this.bridged) {
        const frame = this.queue.shift();
        this.sendPacket(frame ? this.encoder.encode(frame) : this.silenceFrame);
        for (const listener of this.sentListeners) listener(frame ?? this.silencePcm);
        if (frame && this.queue.length === 0) this.flushDone();
      }
      // Drift-corrected: the next tick is scheduled against the start time.
      const next = started + (tick + 1) * FRAME_MS - Date.now();
      this.timer = setTimeout(step, Math.max(0, next));
    };
    this.timer = setTimeout(step, FRAME_MS);
  }

  private setState(state: SessionState) {
    if (this.state === state || this.state === 'closed') return;
    this.state = state;
    for (const listener of this.stateListeners) listener(state);
  }

  async close() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.flushDone();
    this.setState('closed');
    this.frameListeners.clear();
    this.packetListeners.clear();
    this.sentListeners.clear();
    await this.pc.close().catch(() => undefined);
    this.decoder.close();
    this.encoder.close();
  }
}
