import type { AiProviders, ProviderId } from './providers';

/**
 * Which models an API key can use, asked from the provider itself (`GET /models`), so agents work
 * with whatever the key has - no model names to type. When an agent leaves the model empty, or
 * names one the key cannot use, the best available model is picked automatically.
 */
export type ModelPurpose = 'llm' | 'stt';

/** Tried in order when picking automatically; anything else suitable comes after. */
const PREFERRED: Record<ModelPurpose, Partial<Record<ProviderId, string[]>>> = {
  llm: {
    anthropic: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'],
    openai: ['gpt-4o-mini', 'gpt-4.1-mini', 'gpt-4o', 'gpt-4.1'],
    gemini: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash'],
    groq: [
      'llama-3.3-70b-versatile',
      'openai/gpt-oss-120b',
      'moonshotai/kimi-k2-instruct',
      'openai/gpt-oss-20b',
      'qwen/qwen3-32b',
      'meta-llama/llama-4-scout-17b-16e-instruct',
      'llama-3.1-8b-instant',
    ],
  },
  stt: {
    openai: ['gpt-4o-mini-transcribe', 'gpt-4o-transcribe', 'whisper-1'],
    groq: ['whisper-large-v3-turbo', 'whisper-large-v3'],
  },
};

const SPEECH = /whisper|transcri/i;
/** Models that are not for chatting (speech, images, embeddings, safety classifiers, ...). */
const NOT_CHAT =
  /whisper|transcri|tts|speech|audio|realtime|embed|guard|moderation|dall-e|image|imagen|veo|playai|orpheus|search|computer-use|aqa|learnlm|distil/i;

export function suitable(purpose: ModelPurpose, model: string): boolean {
  return purpose === 'stt' ? SPEECH.test(model) : !NOT_CHAT.test(model);
}

/** Providers whose API lists models; the others keep their documented default model. */
export const LISTS_MODELS: ProviderId[] = ['openai', 'anthropic', 'gemini', 'groq'];

/** Model ids from a provider's model list response (OpenAI-style `data` or Anthropic's). */
export function parseModelList(body: unknown): string[] {
  const data = (body as { data?: Array<{ id?: unknown }> } | null)?.data;
  if (!Array.isArray(data)) return [];
  return data
    .map((m) => (typeof m.id === 'string' ? m.id.replace(/^models\//, '') : ''))
    .filter(Boolean);
}

/**
 * The model to use: the requested one when the key has it, otherwise the provider's default,
 * then the preferred list, then any suitable model. Without a model list (provider down, or one
 * that does not list models) the request goes through as asked.
 */
export function pickModel(
  purpose: ModelPurpose,
  provider: ProviderId,
  available: string[] | null,
  requested: string,
  fallback: string,
): string {
  const wanted = requested.trim();
  if (!available?.length) return wanted || fallback;
  if (wanted && available.includes(wanted)) return wanted;
  const usable = available.filter((m) => suitable(purpose, m));
  for (const model of [fallback, ...(PREFERRED[purpose][provider] ?? [])]) {
    if (usable.includes(model)) return model;
  }
  return [...usable].sort()[0] ?? (wanted || fallback);
}

export async function chooseModel(
  providers: AiProviders,
  provider: ProviderId,
  purpose: ModelPurpose,
  requested: string,
  fallback: string,
): Promise<string> {
  const available = LISTS_MODELS.includes(provider)
    ? await providers.models(provider).catch(() => null)
    : null;
  return pickModel(purpose, provider, available, requested, fallback);
}
