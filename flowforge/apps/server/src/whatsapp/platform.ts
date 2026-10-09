import { randomBytes } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { Config } from '../config';
import type { Cipher } from '../credentials/cipher';

const KEY = 'whatsapp.platform';

interface StoredSettings {
  appId?: string;
  /** Encrypted. */
  appSecret?: string;
  configId?: string;
  verifyToken?: string;
  webhookVerifiedAt?: string;
  lastWebhookAt?: string;
}

export interface PlatformConfig {
  appId: string | null;
  appSecret: string | null;
  configId: string | null;
  verifyToken: string;
  /** Where each value comes from: server environment variables win over the WhatsApp page. */
  sources: { appId: Source; appSecret: Source; configId: Source; verifyToken: Source };
  webhookVerifiedAt: string | null;
  lastWebhookAt: string | null;
}
type Source = 'env' | 'settings' | 'generated' | null;

/**
 * The instance's Meta app (one per FlowForge installation). Customers connect their own numbers
 * through it with "Embedded Signup" - they never see or paste a key.
 */
export class WhatsAppPlatform {
  private cache: PlatformConfig | null = null;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly cipher: Cipher,
    private readonly config: Config,
  ) {}

  private async stored(): Promise<StoredSettings> {
    const row = await this.prisma.setting.findUnique({ where: { key: KEY } });
    return (row?.value as StoredSettings | undefined) ?? {};
  }

  private async write(patch: Partial<StoredSettings>) {
    const value = { ...(await this.stored()), ...patch };
    await this.prisma.setting.upsert({
      where: { key: KEY },
      create: { key: KEY, value: value as object },
      update: { value: value as object },
    });
    this.cache = null;
  }

  async get(): Promise<PlatformConfig> {
    if (this.cache) return this.cache;
    let stored = await this.stored();
    if (!this.config.WHATSAPP_WEBHOOK_VERIFY_TOKEN && !stored.verifyToken) {
      await this.write({ verifyToken: randomBytes(18).toString('base64url') });
      stored = await this.stored();
    }
    let storedSecret: string | null = null;
    if (stored.appSecret) {
      try {
        storedSecret = this.cipher.decrypt(stored.appSecret);
      } catch {
        storedSecret = null;
      }
    }
    const env = this.config;
    this.cache = {
      appId: env.META_APP_ID ?? stored.appId ?? null,
      appSecret: env.META_APP_SECRET ?? storedSecret,
      configId: env.META_EMBEDDED_SIGNUP_CONFIG_ID ?? stored.configId ?? null,
      verifyToken: env.WHATSAPP_WEBHOOK_VERIFY_TOKEN ?? stored.verifyToken!,
      sources: {
        appId: env.META_APP_ID ? 'env' : stored.appId ? 'settings' : null,
        appSecret: env.META_APP_SECRET ? 'env' : storedSecret ? 'settings' : null,
        configId: env.META_EMBEDDED_SIGNUP_CONFIG_ID ? 'env' : stored.configId ? 'settings' : null,
        verifyToken: env.WHATSAPP_WEBHOOK_VERIFY_TOKEN ? 'env' : 'generated',
      },
      webhookVerifiedAt: stored.webhookVerifiedAt ?? null,
      lastWebhookAt: stored.lastWebhookAt ?? null,
    };
    return this.cache;
  }

  /** Owner-only. `appSecret` undefined keeps the stored one; empty string clears it. */
  async save(input: {
    appId?: string | null;
    appSecret?: string | null;
    configId?: string | null;
  }) {
    const patch: Partial<StoredSettings> = {};
    if (input.appId !== undefined) patch.appId = input.appId || undefined;
    if (input.configId !== undefined) patch.configId = input.configId || undefined;
    if (input.appSecret !== undefined) {
      patch.appSecret = input.appSecret ? this.cipher.encrypt(input.appSecret) : undefined;
    }
    await this.write(patch);
  }

  /** Forget cached values (after the settings table changed elsewhere, e.g. in tests). */
  invalidate() {
    this.cache = null;
  }

  async markWebhookVerified() {
    await this.write({ webhookVerifiedAt: new Date().toISOString() });
  }

  async markWebhookReceived() {
    // At most one write a minute - this runs for every webhook.
    const last = this.cache?.lastWebhookAt ? Date.parse(this.cache.lastWebhookAt) : 0;
    if (Date.now() - last < 60_000) return;
    await this.write({ lastWebhookAt: new Date().toISOString() });
  }

  webhookUrl(): string {
    return `${this.config.PUBLIC_URL.replace(/\/+$/, '')}/webhooks/whatsapp`;
  }
}
