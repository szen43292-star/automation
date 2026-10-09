import type { PrismaClient } from '@prisma/client';
import type { Config } from '../config';
import type { Cipher } from '../credentials/cipher';

const KEY = 'ai.providers';

export const PROVIDERS = [
  'openai',
  'anthropic',
  'gemini',
  'deepgram',
  'elevenlabs',
  'sarvam',
] as const;
export type ProviderId = (typeof PROVIDERS)[number];

export const PROVIDER_INFO: Record<ProviderId, { name: string; usedFor: string; keyUrl: string }> =
  {
    openai: {
      name: 'OpenAI',
      usedFor: 'Realtime voice (speech-to-speech), speech-to-text, text-to-speech, LLM',
      keyUrl: 'https://platform.openai.com/api-keys',
    },
    anthropic: {
      name: 'Anthropic (Claude)',
      usedFor: 'LLM for the agent, call summaries',
      keyUrl: 'https://platform.claude.com/settings/keys',
    },
    gemini: {
      name: 'Google Gemini',
      usedFor: 'LLM',
      keyUrl: 'https://aistudio.google.com/apikey',
    },
    deepgram: {
      name: 'Deepgram',
      usedFor: 'Speech-to-text (many languages incl. Hindi)',
      keyUrl: 'https://console.deepgram.com',
    },
    elevenlabs: {
      name: 'ElevenLabs',
      usedFor: 'Natural text-to-speech voices',
      keyUrl: 'https://elevenlabs.io/app/settings/api-keys',
    },
    sarvam: {
      name: 'Sarvam AI',
      usedFor: 'Speech-to-text and voices for Indian languages',
      keyUrl: 'https://dashboard.sarvam.ai',
    },
  };

const ENV: Record<ProviderId, { key: keyof Config; url: keyof Config }> = {
  openai: { key: 'OPENAI_API_KEY', url: 'OPENAI_BASE_URL' },
  anthropic: { key: 'ANTHROPIC_API_KEY', url: 'ANTHROPIC_BASE_URL' },
  gemini: { key: 'GEMINI_API_KEY', url: 'GEMINI_BASE_URL' },
  deepgram: { key: 'DEEPGRAM_API_KEY', url: 'DEEPGRAM_BASE_URL' },
  elevenlabs: { key: 'ELEVENLABS_API_KEY', url: 'ELEVENLABS_BASE_URL' },
  sarvam: { key: 'SARVAM_API_KEY', url: 'SARVAM_BASE_URL' },
};

export interface ProviderAccess {
  apiKey: string;
  baseUrl: string;
}

export interface ProviderStatus {
  id: ProviderId;
  name: string;
  usedFor: string;
  keyUrl: string;
  configured: boolean;
  /** env = server environment / built into the app; settings = entered in FlowForge. */
  source: 'env' | 'settings' | null;
  /** Last 4 characters, so the owner can tell keys apart. */
  hint: string | null;
}

type Stored = Partial<Record<ProviderId, string>>; // encrypted keys

/**
 * API keys of the AI providers. They stay on the server: apps and browsers only ever see whether a
 * provider is configured. Environment variables (also how private app builds bring their keys)
 * win over keys entered in Settings.
 */
export class AiProviders {
  private cache: Map<ProviderId, { apiKey: string; source: 'env' | 'settings' }> | null = null;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly cipher: Cipher,
    private readonly config: Config,
  ) {}

  private async stored(): Promise<Stored> {
    const row = await this.prisma.setting.findUnique({ where: { key: KEY } });
    return (row?.value as Stored | undefined) ?? {};
  }

  private async keys() {
    if (this.cache) return this.cache;
    const stored = await this.stored();
    const keys = new Map<ProviderId, { apiKey: string; source: 'env' | 'settings' }>();
    for (const id of PROVIDERS) {
      const fromEnv = this.config[ENV[id].key] as string | undefined;
      if (fromEnv) {
        keys.set(id, { apiKey: fromEnv, source: 'env' });
        continue;
      }
      const encrypted = stored[id];
      if (!encrypted) continue;
      try {
        keys.set(id, { apiKey: this.cipher.decrypt(encrypted), source: 'settings' });
      } catch {
        // Undecryptable (ENCRYPTION_KEY changed): treat as not configured.
      }
    }
    this.cache = keys;
    return keys;
  }

  async get(id: ProviderId): Promise<ProviderAccess | null> {
    const entry = (await this.keys()).get(id);
    if (!entry) return null;
    return {
      apiKey: entry.apiKey,
      baseUrl: (this.config[ENV[id].url] as string).replace(/\/+$/, ''),
    };
  }

  async require(id: ProviderId): Promise<ProviderAccess> {
    const access = await this.get(id);
    if (!access) {
      throw new Error(
        `${PROVIDER_INFO[id].name} is not set up - add its API key in Settings → AI providers`,
      );
    }
    return access;
  }

  async configured(): Promise<Set<ProviderId>> {
    return new Set((await this.keys()).keys());
  }

  async status(): Promise<ProviderStatus[]> {
    const keys = await this.keys();
    return PROVIDERS.map((id) => {
      const entry = keys.get(id);
      return {
        id,
        ...PROVIDER_INFO[id],
        configured: Boolean(entry),
        source: entry?.source ?? null,
        hint: entry ? `…${entry.apiKey.slice(-4)}` : null,
      };
    });
  }

  /** Owner-only. A key of null removes the saved key (keys from the environment stay). */
  async save(input: Partial<Record<ProviderId, string | null>>) {
    const stored = await this.stored();
    for (const id of PROVIDERS) {
      const value = input[id];
      if (value === undefined) continue;
      if (value === null || value.trim() === '') delete stored[id];
      else stored[id] = this.cipher.encrypt(value.trim());
    }
    await this.prisma.setting.upsert({
      where: { key: KEY },
      create: { key: KEY, value: stored as object },
      update: { value: stored as object },
    });
    this.cache = null;
  }

  invalidate() {
    this.cache = null;
  }
}
