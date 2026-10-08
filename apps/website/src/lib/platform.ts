export type Platform = 'windows' | 'macos' | 'linux' | 'android' | 'ios' | 'unknown';

/** Detects the visitor's OS from the user agent (and userAgentData.platform when available). */
export function detectPlatform(userAgent: string, uaPlatform = '', maxTouchPoints = 0): Platform {
  const ua = userAgent.toLowerCase();
  const hint = uaPlatform.toLowerCase();
  if (/android/.test(ua) || hint === 'android') return 'android';
  if (/iphone|ipad|ipod/.test(ua) || hint === 'ios') return 'ios';
  // iPadOS 13+ reports itself as a Mac; touch support gives it away.
  if (/macintosh/.test(ua) && maxTouchPoints > 1) return 'ios';
  if (/windows/.test(ua) || hint === 'windows') return 'windows';
  if (/macintosh|mac os x/.test(ua) || hint === 'macos') return 'macos';
  if (/linux|x11|cros/.test(ua) || hint === 'linux' || hint === 'chrome os') return 'linux';
  return 'unknown';
}

export const platformNames: Record<Platform, string> = {
  windows: 'Windows',
  macos: 'macOS',
  linux: 'Linux',
  android: 'Android',
  ios: 'iPhone / iPad',
  unknown: 'your device',
};
