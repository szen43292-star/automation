import { z } from 'zod';

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM, e.g. 09:30');

export const callModeSchema = z.enum(['app', 'voicemail', 'ai', 'reject']);
export type CallMode = z.infer<typeof callModeSchema>;
const fallbackSchema = z.enum(['voicemail', 'ai', 'reject']);

export const callSettingsSchema = z.object({
  /** app = ring in FlowForge (desktop, web, phone); voicemail; ai = AI voice agent; reject = decline and message. */
  mode: callModeSchema,
  /** How long the app rings before the fallback takes over. */
  ringSeconds: z.number().int().min(5).max(60),
  fallback: fallbackSchema,
  businessHours: z.object({
    enabled: z.boolean(),
    timezone: z.string().min(1),
    /** Open hours per weekday (0 = Sunday). Days without an entry are closed. */
    days: z
      .array(z.object({ day: z.number().int().min(0).max(6), open: time, close: time }))
      .max(14),
    outsideMode: fallbackSchema,
  }),
  voicemailMaxSeconds: z.number().int().min(15).max(600),
  /** Sent as a WhatsApp message when a call is rejected or missed. */
  rejectMessage: z.string().max(1000),
  /** Spoken greeting (AI / text-to-speech, Phase 5); voicemail without audio plays a beep. */
  greetingText: z.string().max(1000),
  record: z.boolean(),
});
export type CallSettings = z.infer<typeof callSettingsSchema>;

export const defaultCallSettings = (timezone = 'UTC'): CallSettings => ({
  mode: 'app',
  ringSeconds: 20,
  fallback: 'voicemail',
  businessHours: {
    enabled: false,
    timezone,
    days: [1, 2, 3, 4, 5].map((day) => ({ day, open: '09:00', close: '18:00' })),
    outsideMode: 'voicemail',
  },
  voicemailMaxSeconds: 120,
  rejectMessage:
    "Sorry we missed your call! Send us a message here and we'll get back to you soon.",
  greetingText: 'Hello! Please leave a message after the beep.',
  record: true,
});

/** Stored settings merged over the defaults (older rows may miss newer fields). */
export function readCallSettings(stored: unknown, timezone?: string): CallSettings {
  const defaults = defaultCallSettings(timezone);
  const value = (stored ?? {}) as Partial<CallSettings>;
  const merged = {
    ...defaults,
    ...value,
    businessHours: { ...defaults.businessHours, ...(value.businessHours ?? {}) },
  };
  const parsed = callSettingsSchema.safeParse(merged);
  return parsed.success ? parsed.data : defaults;
}

/** Local weekday and minutes since midnight in a timezone. */
function localTime(date: Date, timezone: string): { day: number; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  return { day, minutes: Number(get('hour')) * 60 + Number(get('minute')) };
}

const toMinutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

export function isOpen(settings: CallSettings, at = new Date()): boolean {
  const { businessHours } = settings;
  if (!businessHours.enabled) return true;
  let local: { day: number; minutes: number };
  try {
    local = localTime(at, businessHours.timezone);
  } catch {
    return true; // unknown timezone: treat as open rather than miss calls
  }
  return businessHours.days.some((d) => {
    const open = toMinutes(d.open);
    const close = toMinutes(d.close);
    if (close > open) return d.day === local.day && local.minutes >= open && local.minutes < close;
    // Overnight (e.g. 20:00-02:00): open from `open` until midnight, and next day until `close`.
    return (
      (d.day === local.day && local.minutes >= open) ||
      ((d.day + 1) % 7 === local.day && local.minutes < close)
    );
  });
}

/** What happens to a call arriving now. */
export function chooseMode(settings: CallSettings, at = new Date()): CallMode {
  return isOpen(settings, at) ? settings.mode : settings.businessHours.outsideMode;
}
