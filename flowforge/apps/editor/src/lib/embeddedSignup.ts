/**
 * Meta "Embedded Signup": the customer logs in with Facebook in Meta's own popup, picks or creates
 * their WhatsApp Business account and number, and we get back a one-time code. The server swaps the
 * code for a token - nobody types or sees an API key.
 */

interface FacebookSdk {
  init(options: {
    appId: string;
    autoLogAppEvents: boolean;
    xfbml: boolean;
    version: string;
  }): void;
  login(
    callback: (response: { authResponse?: { code?: string } | null; status?: string }) => void,
    options: Record<string, unknown>,
  ): void;
}

declare global {
  interface Window {
    FB?: FacebookSdk;
    fbAsyncInit?: () => void;
  }
}

let sdk: Promise<FacebookSdk> | null = null;

function loadSdk(appId: string, version: string): Promise<FacebookSdk> {
  sdk ??= new Promise<FacebookSdk>((resolve, reject) => {
    window.fbAsyncInit = () => {
      window.FB!.init({ appId, autoLogAppEvents: true, xfbml: false, version });
      resolve(window.FB!);
    };
    const script = document.createElement('script');
    script.src = 'https://connect.facebook.net/en_US/sdk.js';
    script.async = true;
    script.crossOrigin = 'anonymous';
    script.onerror = () => {
      sdk = null;
      reject(
        new Error('Could not load Facebook login. Check your internet connection or ad blocker.'),
      );
    };
    document.body.appendChild(script);
  });
  return sdk;
}

export interface EmbeddedSignupResult {
  code: string;
  wabaId: string;
  phoneNumberId: string;
}

export async function runEmbeddedSignup(options: {
  appId: string;
  configId: string;
  graphVersion: string;
}): Promise<EmbeddedSignupResult> {
  const FB = await loadSdk(options.appId, options.graphVersion);
  return new Promise<EmbeddedSignupResult>((resolve, reject) => {
    let session: { wabaId?: string; phoneNumberId?: string } = {};
    let code: string | null = null;
    const finish = () => {
      if (!code || !session.wabaId || !session.phoneNumberId) return;
      window.removeEventListener('message', onMessage);
      resolve({ code, wabaId: session.wabaId, phoneNumberId: session.phoneNumberId });
    };
    // The popup reports which account and number were chosen.
    const onMessage = (event: MessageEvent) => {
      if (!/^https:\/\/([\w-]+\.)?facebook\.com$/.test(event.origin)) return;
      let data: {
        type?: string;
        event?: string;
        data?: { waba_id?: string; phone_number_id?: string; current_step?: string };
      };
      try {
        data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
      } catch {
        return;
      }
      if (data?.type !== 'WA_EMBEDDED_SIGNUP') return;
      if (data.event === 'FINISH' || data.event === 'FINISH_ONLY_WABA') {
        session = { wabaId: data.data?.waba_id, phoneNumberId: data.data?.phone_number_id };
        if (!session.phoneNumberId) {
          window.removeEventListener('message', onMessage);
          reject(
            new Error('No phone number was added. Run "Connect WhatsApp" again and add a number.'),
          );
          return;
        }
        finish();
      } else if (data.event === 'CANCEL') {
        window.removeEventListener('message', onMessage);
        reject(
          new Error(
            `Connection cancelled${data.data?.current_step ? ` at "${data.data.current_step}"` : ''}.`,
          ),
        );
      }
    };
    window.addEventListener('message', onMessage);
    FB.login(
      (response) => {
        if (!response.authResponse?.code) {
          window.removeEventListener('message', onMessage);
          reject(new Error('Facebook login was closed before finishing.'));
          return;
        }
        code = response.authResponse.code;
        finish();
        // FINISH normally arrives first; give it a moment if not.
        setTimeout(() => {
          if (!session.phoneNumberId) {
            window.removeEventListener('message', onMessage);
            reject(new Error('Meta did not report the chosen number. Please try again.'));
          }
        }, 15_000);
      },
      {
        config_id: options.configId,
        response_type: 'code',
        override_default_response_type: true,
        extras: { setup: {}, featureType: '', sessionInfoVersion: '3' },
      },
    );
  });
}
