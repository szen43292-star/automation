import { api } from './api';

/**
 * Native features when the editor runs inside the Android / iOS app (Capacitor). Plugins are
 * reached through the bridge (window.Capacitor), so the web build has no native dependencies.
 */
interface CapacitorBridge {
  isNativePlatform(): boolean;
  getPlatform(): 'android' | 'ios' | 'web';
  Plugins: Record<string, any>;
}

const capacitor = (): CapacitorBridge | null => {
  const cap = (window as unknown as { Capacitor?: CapacitorBridge }).Capacitor;
  return cap?.isNativePlatform?.() ? cap : null;
};

export const isNativeApp = () => capacitor() !== null;

let started = false;

/** Call once after sign-in. `navigate` opens a page when a notification is tapped. */
export async function startNative(navigate: (path: string) => void) {
  const cap = capacitor();
  if (!cap || started) return;
  started = true;
  const { App, PushNotifications, StatusBar } = cap.Plugins;

  // Android back button: go back, or leave the app from the home screen.
  App?.addListener('backButton', ({ canGoBack }: { canGoBack: boolean }) => {
    if (canGoBack && window.location.hash.replace(/^#/, '') !== '/dashboard') window.history.back();
    else void App.minimizeApp?.();
  });
  StatusBar?.setOverlaysWebView?.({ overlay: false }).catch?.(() => undefined);

  if (!PushNotifications) return;
  const status = await api<{ enabled: boolean }>('/api/devices/status').catch(() => null);
  if (!status?.enabled) return; // the server has no Firebase account configured

  await PushNotifications.createChannel?.({
    id: 'calls',
    name: 'Calls',
    description: 'Incoming WhatsApp calls',
    importance: 5,
    vibration: true,
  }).catch(() => undefined);
  PushNotifications.addListener('registration', ({ value }: { value: string }) => {
    void api('/api/devices', { body: { token: value, platform: cap.getPlatform() } }).catch(
      () => undefined,
    );
  });
  PushNotifications.addListener(
    'pushNotificationActionPerformed',
    ({ notification }: { notification: { data?: { url?: string } } }) => {
      navigate(notification.data?.url ?? '/calls');
    },
  );
  const permission = await PushNotifications.requestPermissions();
  if (permission.receive === 'granted') await PushNotifications.register();
}
