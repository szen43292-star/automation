import type { CapacitorConfig } from '@capacitor/cli';

/**
 * The FlowForge app for Android and iOS: the editor (built by scripts/build-web.mjs into www/)
 * in a native shell, connected to your FlowForge server. Keys stay on the server.
 */
const config: CapacitorConfig = {
  appId: process.env.MOBILE_APP_ID || 'com.flowforge.app',
  appName: process.env.MOBILE_APP_NAME || 'FlowForge',
  webDir: 'www',
  server: { androidScheme: 'https' },
  android: {
    // Lets the app talk to a server on your local network over plain http (e.g. the Windows app).
    allowMixedContent: true,
  },
  ios: { contentInset: 'always' },
  plugins: {
    PushNotifications: { presentationOptions: ['badge', 'sound', 'alert'] },
  },
};

export default config;
