import { encodeWav, loadPrompt, resample, SAMPLE_RATE } from '@flowforge/media';
import type { AiProviders } from '../ai/providers';
import { DEFAULT_MODELS, DEFAULT_VOICES, type AgentVoice } from './config';
import { httpError } from './llm';

/** Raw 16-bit little-endian PCM → samples. */
export function pcmFromBytes(bytes: Buffer): Int16Array {
  const even = bytes.length - (bytes.length % 2);
  const copy = Buffer.from(bytes.subarray(0, even)); // aligned copy
  return new Int16Array(copy.buffer, copy.byteOffset, even / 2);
}

export const pcmToBytes = (samples: Int16Array) =>
  Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);

/** "hi-IN" → "hi" (OpenAI wants ISO-639-1). */
const shortLanguage = (code: string) => code.split(/[-_]/)[0]!.toLowerCase();

/** Speech-to-text for one utterance (48 kHz call audio). */
export async function transcribe(
  providers: AiProviders,
  voice: AgentVoice,
  samples: Int16Array,
  signal?: AbortSignal,
): Promise<string> {
  const { provider } = voice.stt;
  const model = voice.stt.model || DEFAULT_MODELS.stt[provider];
  const wav = encodeWav([resample(samples, SAMPLE_RATE, 16_000)], 16_000);
  const access = await providers.require(provider);

  if (provider === 'deepgram') {
    const query = new URLSearchParams({
      model,
      smart_format: 'true',
      language: voice.language || 'multi',
    });
    const response = await fetch(`${access.baseUrl}/v1/listen?${query}`, {
      method: 'POST',
      headers: { authorization: `Token ${access.apiKey}`, 'content-type': 'audio/wav' },
      body: new Uint8Array(wav),
      signal,
    });
    if (!response.ok) throw await httpError('Deepgram', response);
    const body = (await response.json()) as {
      results?: { channels?: Array<{ alternatives?: Array<{ transcript?: string }> }> };
    };
    return body.results?.channels?.[0]?.alternatives?.[0]?.transcript?.trim() ?? '';
  }

  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'speech.wav');
  form.append('model', model);
  if (provider === 'sarvam') {
    form.append('language_code', voice.language || 'unknown');
    const response = await fetch(`${access.baseUrl}/speech-to-text`, {
      method: 'POST',
      headers: { 'api-subscription-key': access.apiKey },
      body: form,
      signal,
    });
    if (!response.ok) throw await httpError('Sarvam', response);
    const body = (await response.json()) as { transcript?: string };
    return body.transcript?.trim() ?? '';
  }

  if (voice.language) form.append('language', shortLanguage(voice.language));
  const response = await fetch(`${access.baseUrl}/audio/transcriptions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${access.apiKey}` },
    body: form,
    signal,
  });
  if (!response.ok) throw await httpError('OpenAI', response);
  const body = (await response.json()) as { text?: string };
  return body.text?.trim() ?? '';
}

/** Text-to-speech → 48 kHz call audio. */
export async function synthesize(
  providers: AiProviders,
  voice: AgentVoice,
  text: string,
  signal?: AbortSignal,
): Promise<Int16Array> {
  const { provider } = voice.tts;
  const model = voice.tts.model || DEFAULT_MODELS.tts[provider];
  const speaker = voice.tts.voice || DEFAULT_VOICES[provider];
  const access = await providers.require(provider);

  if (provider === 'elevenlabs') {
    const response = await fetch(
      `${access.baseUrl}/v1/text-to-speech/${encodeURIComponent(speaker)}?output_format=pcm_24000`,
      {
        method: 'POST',
        headers: { 'xi-api-key': access.apiKey, 'content-type': 'application/json' },
        body: JSON.stringify({ text, model_id: model }),
        signal,
      },
    );
    if (!response.ok) throw await httpError('ElevenLabs', response);
    return resample(pcmFromBytes(Buffer.from(await response.arrayBuffer())), 24_000, SAMPLE_RATE);
  }

  if (provider === 'sarvam') {
    const response = await fetch(`${access.baseUrl}/text-to-speech`, {
      method: 'POST',
      headers: { 'api-subscription-key': access.apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({
        text,
        target_language_code: voice.language || 'hi-IN',
        speaker,
        model,
        speech_sample_rate: 24_000,
      }),
      signal,
    });
    if (!response.ok) throw await httpError('Sarvam', response);
    const body = (await response.json()) as { audios?: string[] };
    const audio = body.audios?.[0];
    if (!audio) return new Int16Array(0);
    return loadPrompt(Buffer.from(audio, 'base64'));
  }

  const response = await fetch(`${access.baseUrl}/audio/speech`, {
    method: 'POST',
    headers: { authorization: `Bearer ${access.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, voice: speaker, input: text, response_format: 'pcm' }),
    signal,
  });
  if (!response.ok) throw await httpError('OpenAI', response);
  return resample(pcmFromBytes(Buffer.from(await response.arrayBuffer())), 24_000, SAMPLE_RATE);
}
