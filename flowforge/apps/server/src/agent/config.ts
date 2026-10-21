import { z } from 'zod';

export const STT_PROVIDERS = ['openai', 'deepgram', 'sarvam', 'groq'] as const;
export const LLM_PROVIDERS = ['anthropic', 'openai', 'gemini', 'groq'] as const;
export const TTS_PROVIDERS = ['openai', 'elevenlabs', 'sarvam'] as const;

export type SttProvider = (typeof STT_PROVIDERS)[number];
export type LlmProvider = (typeof LLM_PROVIDERS)[number];
export type TtsProvider = (typeof TTS_PROVIDERS)[number];

/** Models used when the agent leaves the model empty. */
export const DEFAULT_MODELS = {
  realtime: 'gpt-realtime',
  stt: {
    openai: 'gpt-4o-mini-transcribe',
    deepgram: 'nova-3',
    sarvam: 'saarika:v2.5',
    groq: 'whisper-large-v3-turbo',
  },
  llm: {
    anthropic: 'claude-opus-5-5',
    openai: 'gpt-4o-mini',
    gemini: 'gemini-flash-latest',
    groq: 'llama-3.3-70b-versatile',
  },
  tts: { openai: 'gpt-4o-mini-tts', elevenlabs: 'eleven_flash_v2_5', sarvam: 'bulbul:v2' },
} as const;

export const DEFAULT_VOICES: Record<TtsProvider | 'realtime', string> = {
  realtime: 'marin',
  openai: 'alloy',
  elevenlabs: '21m00Tcm4TlvDq8ikWAM',
  sarvam: 'anushka',
};

const name = z.string().trim().max(120).default('');

export const agentVoiceSchema = z.object({
  /** realtime engine: one speech-to-speech model does listening, thinking and speaking. */
  realtime: z.object({ model: name, voice: name }).prefault({}),
  /** pipeline engine: speech-to-text → LLM → text-to-speech, each from any provider. */
  stt: z.object({ provider: z.enum(STT_PROVIDERS).default('openai'), model: name }).prefault({}),
  llm: z.object({ provider: z.enum(LLM_PROVIDERS).default('anthropic'), model: name }).prefault({}),
  tts: z
    .object({ provider: z.enum(TTS_PROVIDERS).default('openai'), model: name, voice: name })
    .prefault({}),
  /** Language code for speech-to-text and Sarvam voices, e.g. "hi-IN". Empty = detect. */
  language: z.string().trim().max(20).default(''),
});

const toolName = z
  .string()
  .regex(/^[a-z][a-z0-9_]{1,40}$/, 'Use lowercase letters, digits and _ (e.g. book_appointment)');

export const workflowToolSchema = z.object({
  workflowId: z.string().min(1),
  name: toolName,
  description: z.string().trim().min(5).max(500),
  parameters: z
    .array(
      z.object({
        name: z.string().regex(/^[a-z][a-z0-9_]{0,30}$/, 'Lowercase letters, digits and _'),
        description: z.string().trim().max(200).default(''),
      }),
    )
    .max(10)
    .default([]),
});

export const agentToolsSchema = z.object({
  /** Look things up in the agent's knowledge documents. */
  knowledge: z.boolean().default(true),
  /** Ring a person in the app and hand the caller over. */
  transfer: z.boolean().default(true),
  /** Hang up when the conversation is finished. */
  endCall: z.boolean().default(true),
  /** Send the caller a WhatsApp message (links, addresses, confirmations). */
  whatsappMessage: z.boolean().default(true),
  /** Workflows the agent can run (they start at an "Execute Workflow Trigger"). */
  workflows: z.array(workflowToolSchema).max(20).default([]),
});

export const agentNotifySchema = z.object({
  /** Write a short summary of every call into the call log. */
  summary: z.boolean().default(true),
  /** WhatsApp number (with country code) that gets the summary after every call. */
  whatsappTo: z
    .string()
    .trim()
    .transform((v) => v.replace(/[^\d]/g, ''))
    .default(''),
});

export const agentInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  instructions: z.string().max(20_000).default(''),
  greeting: z.string().trim().max(500).default('Hello! How can I help you today?'),
  languages: z.array(z.string().trim().min(1).max(40)).max(10).default(['English']),
  engine: z.enum(['realtime', 'pipeline']).default('realtime'),
  voice: agentVoiceSchema.prefault({}),
  tools: agentToolsSchema.prefault({}),
  notify: agentNotifySchema.prefault({}),
});

export type AgentInput = z.infer<typeof agentInputSchema>;
export type AgentVoice = z.infer<typeof agentVoiceSchema>;
export type AgentTools = z.infer<typeof agentToolsSchema>;
export type AgentNotify = z.infer<typeof agentNotifySchema>;
export type WorkflowTool = z.infer<typeof workflowToolSchema>;

/** Stored JSON → settings with defaults (older rows, hand-edited rows). */
export const readVoice = (value: unknown): AgentVoice =>
  agentVoiceSchema.catch(agentVoiceSchema.parse({})).parse(value ?? {});
export const readTools = (value: unknown): AgentTools =>
  agentToolsSchema.catch(agentToolsSchema.parse({})).parse(value ?? {});
export const readNotify = (value: unknown): AgentNotify =>
  agentNotifySchema.catch(agentNotifySchema.parse({})).parse(value ?? {});
