import type { IDataObject } from '@flowforge/workflow';

/** Shapes of the Cloud API webhook (only the fields we use). */
export interface CloudWebhook {
  object?: string;
  entry?: Array<{
    id?: string;
    changes?: Array<{ field?: string; value?: CloudChangeValue }>;
  }>;
}

export interface CloudChangeValue {
  messaging_product?: string;
  metadata?: { display_phone_number?: string; phone_number_id?: string };
  contacts?: Array<{ wa_id?: string; profile?: { name?: string } }>;
  messages?: CloudMessage[];
  statuses?: CloudStatus[];
  calls?: CloudCall[];
}

/** A voice call event (webhook field "calls"). */
export interface CloudCall {
  id: string;
  from: string;
  to: string;
  /** connect = a call arrives (with the caller's SDP offer); terminate = it ended. */
  event: 'connect' | 'terminate' | string;
  timestamp: string;
  direction?: 'USER_INITIATED' | 'BUSINESS_INITIATED' | string;
  session?: { sdp_type?: string; sdp?: string };
  status?: string;
  duration?: number;
  start_time?: string;
  end_time?: string;
}

export interface CloudMessage {
  from: string;
  id: string;
  timestamp: string;
  type: string;
  text?: { body?: string };
  image?: CloudMedia;
  video?: CloudMedia;
  audio?: CloudMedia & { voice?: boolean };
  document?: CloudMedia & { filename?: string };
  sticker?: CloudMedia & { animated?: boolean };
  location?: {
    latitude?: number;
    longitude?: number;
    name?: string;
    address?: string;
    url?: string;
  };
  contacts?: unknown[];
  interactive?: {
    type?: string;
    button_reply?: { id?: string; title?: string };
    list_reply?: { id?: string; title?: string; description?: string };
  };
  button?: { payload?: string; text?: string };
  reaction?: { message_id?: string; emoji?: string };
  context?: { from?: string; id?: string; forwarded?: boolean };
  referral?: IDataObject;
  errors?: IDataObject[];
}

interface CloudMedia {
  id?: string;
  mime_type?: string;
  sha256?: string;
  caption?: string;
}

export interface CloudStatus {
  id: string;
  status: string;
  timestamp: string;
  recipient_id: string;
  errors?: Array<{
    code?: number;
    title?: string;
    message?: string;
    error_data?: { details?: string };
  }>;
  conversation?: IDataObject;
  pricing?: IDataObject;
}

export interface AccountRef {
  id: string;
  phoneNumber: string;
  name: string;
}

const MEDIA_TYPES = ['image', 'video', 'audio', 'document', 'sticker'] as const;

export const toIso = (unixSeconds: string | undefined) => {
  const seconds = Number(unixSeconds);
  return new Date(
    Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : Date.now(),
  ).toISOString();
};

/** A received message as a workflow item: `{ from, contactName, text, type, reply, media, … }`. */
export function messageItem(
  account: AccountRef,
  message: CloudMessage,
  contactName: string | undefined,
): IDataObject {
  const item: IDataObject = {
    event: 'message',
    account,
    from: message.from,
    contactName: contactName ?? null,
    messageId: message.id,
    timestamp: toIso(message.timestamp),
    type: message.type,
    text: messageText(message),
  };
  for (const kind of MEDIA_TYPES) {
    const media = message[kind];
    if (media) {
      item.media = {
        id: media.id ?? null,
        mimeType: media.mime_type ?? null,
        sha256: media.sha256 ?? null,
        caption: media.caption ?? null,
        ...(kind === 'document'
          ? { fileName: (media as { filename?: string }).filename ?? null }
          : {}),
        ...(kind === 'audio' ? { voice: Boolean((media as { voice?: boolean }).voice) } : {}),
      };
    }
  }
  if (message.location) item.location = message.location as IDataObject;
  if (message.contacts) item.contacts = message.contacts as IDataObject[];
  if (message.interactive) {
    const reply = message.interactive.button_reply ?? message.interactive.list_reply;
    item.reply = {
      type: message.interactive.type === 'list_reply' ? 'list' : 'button',
      id: reply?.id ?? null,
      title: reply?.title ?? null,
      ...(message.interactive.list_reply?.description
        ? { description: message.interactive.list_reply.description }
        : {}),
    };
  }
  if (message.button)
    item.reply = {
      type: 'quick_reply',
      id: message.button.payload ?? null,
      title: message.button.text ?? null,
    };
  if (message.reaction)
    item.reaction = {
      messageId: message.reaction.message_id ?? null,
      emoji: message.reaction.emoji ?? '',
    };
  if (message.context?.id)
    item.replyTo = { messageId: message.context.id, from: message.context.from ?? null };
  if (message.referral) item.referral = message.referral;
  if (message.errors) item.errors = message.errors;
  item.raw = message as unknown as IDataObject;
  return item;
}

/** The readable part of a message: text, caption, chosen reply, place name or emoji. */
export function messageText(message: CloudMessage): string | null {
  if (message.text?.body !== undefined) return message.text.body;
  for (const kind of MEDIA_TYPES) {
    if (message[kind]?.caption) return message[kind]!.caption!;
  }
  if (message.interactive) {
    return message.interactive.button_reply?.title ?? message.interactive.list_reply?.title ?? null;
  }
  if (message.button?.text) return message.button.text;
  if (message.location) return message.location.name ?? message.location.address ?? null;
  if (message.reaction) return message.reaction.emoji ?? null;
  return null;
}

export function statusItem(account: AccountRef, status: CloudStatus): IDataObject {
  return {
    event: 'status',
    account,
    messageId: status.id,
    recipient: status.recipient_id,
    status: status.status,
    timestamp: toIso(status.timestamp),
    ...(status.errors?.length
      ? {
          error: {
            code: status.errors[0]?.code ?? null,
            message:
              status.errors[0]?.error_data?.details ??
              status.errors[0]?.message ??
              status.errors[0]?.title ??
              null,
          },
        }
      : {}),
    ...(status.pricing ? { pricing: status.pricing } : {}),
    ...(status.conversation ? { conversation: status.conversation } : {}),
    raw: status as unknown as IDataObject,
  };
}

/** Outgoing message objects → short preview text for the message log. */
export function outboundText(message: IDataObject): string | null {
  const type = String(message.type ?? 'text');
  const part = message[type] as IDataObject | undefined;
  if (!part) return null;
  if (type === 'text') return String(part.body ?? '');
  if (type === 'template') return `Template: ${String(part.name ?? '')}`;
  if (type === 'interactive') return String((part.body as IDataObject | undefined)?.text ?? '');
  if (type === 'reaction') return String(part.emoji ?? '');
  if (type === 'location') return String(part.name ?? part.address ?? 'Location');
  return String(part.caption ?? part.filename ?? type);
}
