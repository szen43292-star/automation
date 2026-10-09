import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const here = dirname(fileURLToPath(import.meta.url));

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  DATABASE_URL: z.string().url({ message: 'DATABASE_URL must be a postgres connection URL' }),
  PORT: z.coerce.number().int().positive().default(5678),
  HOST: z.string().default('0.0.0.0'),
  PUBLIC_URL: z.string().url().default('http://localhost:5678'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_EXPIRES_IN: z.string().default('7d'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  CORS_ORIGINS: z.string().default(''),
  /** Directory with the built editor (served at /). */
  EDITOR_DIST: z.string().optional(),
  /**
   * Path of the editor on PUBLIC_URL when it is served separately (Vercel: "/app"). Used for
   * links the server sends out: invitations, error notifications.
   */
  EDITOR_BASE_PATH: z
    .string()
    .regex(/^(\/[\w-]+)*$/, 'EDITOR_BASE_PATH looks like /app')
    .default(''),
  DEFAULT_TIMEZONE: z.string().default('UTC'),
  /** Max wall-clock time of a single Code node run (ms). */
  CODE_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  CODE_MEMORY_MB: z.coerce.number().int().positive().default(128),
  /** Max sign-in / setup attempts per IP per minute. */
  AUTH_RATE_LIMIT: z.coerce.number().int().positive().default(10),
  /** Key for encrypting credentials (64 hex chars or any long passphrase). Required in production. */
  ENCRYPTION_KEY: z.string().min(16, 'ENCRYPTION_KEY must be at least 16 characters').optional(),
  /** regular = run everything in this process; queue = production executions go through BullMQ workers. */
  EXECUTIONS_MODE: z.enum(['regular', 'queue']).default('regular'),
  REDIS_URL: z.string().optional(),
  /** Parallel executions per worker process (queue mode). */
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(10),
  /** How long a webhook waits for "When Last Node Finishes" responses. */
  WEBHOOK_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  /** Maximum webhook request body size. */
  WEBHOOK_MAX_BODY_MB: z.coerce.number().positive().default(16),
  /**
   * WhatsApp Business platform (your Meta app). Optional here: the owner can also enter them on the
   * WhatsApp page. They stay on the server - never in the editor, desktop or mobile apps.
   */
  META_APP_ID: z.string().regex(/^\d+$/, 'META_APP_ID is the numeric App ID').optional(),
  META_APP_SECRET: z.string().min(16).optional(),
  /** "Embedded Signup" configuration id (Facebook Login for Business). */
  META_EMBEDDED_SIGNUP_CONFIG_ID: z.string().regex(/^\d+$/).optional(),
  /** Verify token for the webhook in the Meta app (generated automatically when not set). */
  WHATSAPP_WEBHOOK_VERIFY_TOKEN: z.string().min(8).optional(),
  META_GRAPH_URL: z.string().url().default('https://graph.facebook.com'),
  META_GRAPH_VERSION: z
    .string()
    .regex(/^v\d+\.\d+$/)
    .default('v23.0'),
  /** Folder for call recordings and greetings (default: ./data). */
  DATA_DIR: z.string().optional(),
  /** UDP ports for call audio, e.g. "40000-40199" - open them in the firewall. Default: any. */
  MEDIA_PORT_RANGE: z
    .string()
    .regex(/^\d+-\d+$/, 'MEDIA_PORT_RANGE looks like 40000-40199')
    .optional(),
  /** Public IP to announce for call audio (servers behind 1:1 NAT, e.g. cloud VMs). */
  MEDIA_PUBLIC_IP: z.ipv4().optional(),
  /** Comma-separated STUN/TURN URLs used to find the public address. */
  MEDIA_ICE_SERVERS: z.string().default('stun:stun.l.google.com:19302'),
  /**
   * AI providers for the voice agent. Optional here: the owner can also enter keys in Settings →
   * AI providers (stored encrypted). Private app builds bring them built in.
   */
  OPENAI_API_KEY: z.string().min(10).optional(),
  OPENAI_BASE_URL: z.string().url().default('https://api.openai.com/v1'),
  ANTHROPIC_API_KEY: z.string().min(10).optional(),
  ANTHROPIC_BASE_URL: z.string().url().default('https://api.anthropic.com'),
  GEMINI_API_KEY: z.string().min(10).optional(),
  GEMINI_BASE_URL: z
    .string()
    .url()
    .default('https://generativelanguage.googleapis.com/v1beta/openai'),
  DEEPGRAM_API_KEY: z.string().min(10).optional(),
  DEEPGRAM_BASE_URL: z.string().url().default('https://api.deepgram.com'),
  ELEVENLABS_API_KEY: z.string().min(10).optional(),
  ELEVENLABS_BASE_URL: z.string().url().default('https://api.elevenlabs.io'),
  SARVAM_API_KEY: z.string().min(10).optional(),
  SARVAM_BASE_URL: z.string().url().default('https://api.sarvam.ai'),
  /**
   * Phone notifications (incoming / missed calls) for the Android and iOS apps: a Firebase
   * service account JSON (or base64 of it). Optional.
   */
  FCM_SERVICE_ACCOUNT: z.string().min(20).optional(),
  FCM_API_URL: z.string().url().default('https://fcm.googleapis.com'),
});

export type Config = z.infer<typeof envSchema> & {
  editorDist: string | null;
  /** Where people open the editor, e.g. https://flow.example.com/app */
  editorUrl: string;
  dataDir: string;
  corsOrigins: string[];
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Empty values (e.g. `KEY=` in .env or `${KEY:-}` in compose) mean "not set".
  const values = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== ''));
  // On Vercel the production domain is known: use it when PUBLIC_URL is not set.
  if (!values.PUBLIC_URL && values.VERCEL_PROJECT_PRODUCTION_URL)
    values.PUBLIC_URL = `https://${values.VERCEL_PROJECT_PRODUCTION_URL}`;
  const parsed = envSchema.safeParse(values);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(
      `Invalid server configuration:\n${problems}\nSee .env.example for all options.`,
    );
  }
  const cfg = parsed.data;
  if (cfg.EXECUTIONS_MODE === 'queue' && !cfg.REDIS_URL) {
    throw new Error(
      'Invalid server configuration:\n  - REDIS_URL is required when EXECUTIONS_MODE=queue',
    );
  }
  if (!cfg.ENCRYPTION_KEY) {
    if (cfg.NODE_ENV === 'production') {
      throw new Error(
        'Invalid server configuration:\n  - ENCRYPTION_KEY is required in production (generate one with: openssl rand -hex 32).\n' +
          '    Keep it safe: credentials cannot be decrypted without it.',
      );
    }
    // Development/test fallback, derived from the JWT secret.
    cfg.ENCRYPTION_KEY = `dev:${cfg.JWT_SECRET}`;
  }
  const candidates = [
    cfg.EDITOR_DIST,
    resolve(here, '../../editor/dist'),
    resolve(here, '../editor'),
  ].filter((p): p is string => Boolean(p));
  const editorDist = candidates.find((p) => existsSync(resolve(p, 'index.html'))) ?? null;
  return {
    ...cfg,
    editorDist,
    editorUrl: `${cfg.PUBLIC_URL.replace(/\/+$/, '')}${cfg.EDITOR_BASE_PATH}`,
    dataDir: resolve(cfg.DATA_DIR ?? 'data'),
    corsOrigins: cfg.CORS_ORIGINS.split(',')
      .map((o) => o.trim())
      .filter(Boolean),
  };
}
