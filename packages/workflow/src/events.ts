import type { IEventSubscription } from './nodeTypes';

/** An event that can start workflows, e.g. a WhatsApp message on one connected number. */
export interface ITriggerEvent {
  source: string;
  /** Usually the account id the event belongs to. */
  scope: string;
  name: string;
  /** Values matched against the subscription's `filter`, e.g. `{ type: 'text' }`. */
  attributes?: Record<string, string>;
}

/**
 * An event matches when its name is in `events` and, for every `filter` key with values that the
 * event carries, its attribute is one of them (a message-type filter doesn't block status events).
 */
export function matchesSubscription(subscription: IEventSubscription, event: ITriggerEvent): boolean {
  if (subscription.source !== event.source) return false;
  if (subscription.scope !== '*' && subscription.scope !== event.scope) return false;
  if (!subscription.events.includes(event.name)) return false;
  for (const [key, allowed] of Object.entries(subscription.filter ?? {})) {
    if (!allowed.length) continue;
    const value = event.attributes?.[key];
    if (value !== undefined && !allowed.includes(value)) return false;
  }
  return true;
}
