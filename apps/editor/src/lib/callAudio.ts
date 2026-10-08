/**
 * The app's side of a call: microphone in, caller's voice out, over WebRTC to the FlowForge server
 * (which bridges it to WhatsApp). Used to answer calls and to call test numbers.
 */
export class BrowserCallLeg {
  private constructor(
    readonly pc: RTCPeerConnection,
    readonly microphone: MediaStream,
    private readonly audio: HTMLAudioElement,
  ) {}

  /** Ask for the microphone and prepare an offer (complete, no trickle ICE). */
  static async create(): Promise<{ leg: BrowserCallLeg; offer: string }> {
    let microphone: MediaStream;
    try {
      microphone = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch {
      throw new Error(
        'Microphone access is needed for calls. Allow it in your browser and try again.',
      );
    }
    const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    microphone.getTracks().forEach((track) => pc.addTrack(track, microphone));
    const audio = new Audio();
    audio.autoplay = true;
    pc.ontrack = (event) => {
      audio.srcObject = event.streams[0] ?? new MediaStream([event.track]);
      void audio.play().catch(() => undefined);
    };
    await pc.setLocalDescription(await pc.createOffer());
    await waitForCandidates(pc);
    return { leg: new BrowserCallLeg(pc, microphone, audio), offer: pc.localDescription!.sdp };
  }

  async connect(answer: string) {
    await this.pc.setRemoteDescription({ type: 'answer', sdp: answer });
  }

  set muted(value: boolean) {
    this.microphone.getAudioTracks().forEach((track) => (track.enabled = !value));
  }

  get muted(): boolean {
    return !this.microphone.getAudioTracks().some((track) => track.enabled);
  }

  onStateChange(listener: (state: RTCPeerConnectionState) => void) {
    this.pc.addEventListener('connectionstatechange', () => listener(this.pc.connectionState));
  }

  close() {
    this.microphone.getTracks().forEach((track) => track.stop());
    this.audio.srcObject = null;
    this.pc.close();
  }
}

/** Gather candidates for up to 2 s (STUN may be slow or blocked; host candidates come first). */
function waitForCandidates(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 2_000);
    pc.addEventListener('icegatheringstatechange', () => {
      if (pc.iceGatheringState === 'complete') {
        clearTimeout(timer);
        resolve();
      }
    });
  });
}

/** A soft two-tone ring while a call waits, until stopped. */
export function startRingtone(): () => void {
  let context: AudioContext | null = null;
  try {
    context = new AudioContext();
  } catch {
    return () => undefined;
  }
  const ctx = context;
  const ring = () => {
    const now = ctx.currentTime;
    for (const [offset, frequency] of [
      [0, 880],
      [0.25, 660],
    ] as const) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = frequency;
      gain.gain.setValueAtTime(0, now + offset);
      gain.gain.linearRampToValueAtTime(0.08, now + offset + 0.02);
      gain.gain.linearRampToValueAtTime(0, now + offset + 0.22);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now + offset);
      osc.stop(now + offset + 0.25);
    }
  };
  ring();
  const timer = setInterval(ring, 2_000);
  return () => {
    clearInterval(timer);
    void ctx.close();
  };
}
