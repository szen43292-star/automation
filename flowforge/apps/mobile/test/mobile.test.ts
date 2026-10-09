import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error - plain .mjs build script
import { serverUrlFrom } from '../scripts/build-web.mjs';

const root = join(__dirname, '..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');

describe('mobile app', () => {
  it('takes the server address from MOBILE_SERVER_URL or the private build PUBLIC_URL', () => {
    expect(serverUrlFrom({})).toBe('');
    expect(serverUrlFrom({ BUNDLE_PUBLIC_URL: 'https://flow.example.com/' })).toBe(
      'https://flow.example.com',
    );
    expect(
      serverUrlFrom({
        MOBILE_SERVER_URL: 'http://192.168.1.20:5678',
        BUNDLE_PUBLIC_URL: 'https://x.com',
      }),
    ).toBe('http://192.168.1.20:5678');
    expect(() => serverUrlFrom({ MOBILE_SERVER_URL: 'ftp://x' })).toThrow(/https/);
    expect(() => serverUrlFrom({ MOBILE_SERVER_URL: 'not a url' })).toThrow(/not a URL/);
  });

  it('Android asks for the microphone and notifications, and signs releases from keystore.properties', () => {
    const manifest = read('android/app/src/main/AndroidManifest.xml');
    for (const permission of [
      'RECORD_AUDIO',
      'MODIFY_AUDIO_SETTINGS',
      'POST_NOTIFICATIONS',
      'INTERNET',
    ])
      expect(manifest).toContain(`android.permission.${permission}`);
    const gradle = read('android/app/build.gradle');
    expect(gradle).toContain("System.getenv('MOBILE_VERSION')");
    expect(gradle).toContain('keystore.properties');
  });

  it('iOS explains the microphone and keeps call audio in the background', () => {
    const plist = read('ios/App/App/Info.plist');
    expect(plist).toContain('NSMicrophoneUsageDescription');
    expect(plist).toMatch(/UIBackgroundModes[\s\S]*<string>audio<\/string>/);
  });
});
