'use client';

import { useSyncExternalStore } from 'react';
import { detectPlatform, type Platform } from '@/lib/platform';

const subscribe = () => () => undefined;

function clientPlatform(): Platform {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  return detectPlatform(nav.userAgent, nav.userAgentData?.platform ?? '', nav.maxTouchPoints ?? 0);
}

/** The visitor's OS; `null` during server rendering and hydration. */
export function usePlatform(): Platform | null {
  return useSyncExternalStore<Platform | null>(subscribe, clientPlatform, () => null);
}
