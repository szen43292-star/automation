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
  DEFAULT_TIMEZONE: z.string().default('UTC'),
  /** Max wall-clock time of a single Code node run (ms). */
  CODE_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  CODE_MEMORY_MB: z.coerce.number().int().positive().default(128),
  /** Max sign-in / setup attempts per IP per minute. */
  AUTH_RATE_LIMIT: z.coerce.number().int().positive().default(10),
});

export type Config = z.infer<typeof envSchema> & {
  editorDist: string | null;
  corsOrigins: string[];
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(
      `Invalid server configuration:\n${problems}\nSee .env.example for all options.`,
    );
  }
  const cfg = parsed.data;
  const candidates = [
    cfg.EDITOR_DIST,
    resolve(here, '../../editor/dist'),
    resolve(here, '../editor'),
  ].filter((p): p is string => Boolean(p));
  const editorDist = candidates.find((p) => existsSync(resolve(p, 'index.html'))) ?? null;
  return {
    ...cfg,
    editorDist,
    corsOrigins: cfg.CORS_ORIGINS.split(',')
      .map((o) => o.trim())
      .filter(Boolean),
  };
}
