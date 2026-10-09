import type { APIRequestContext, Page } from '@playwright/test';

export const USER = {
  name: 'E2E Owner',
  email: process.env.E2E_EMAIL ?? 'e2e-owner@example.com',
  password: process.env.E2E_PASSWORD ?? 'E2e-Passw0rd!',
};

/** Set up the owner on a fresh instance, or sign in on an existing one. Returns a JWT. */
export async function getToken(request: APIRequestContext): Promise<string> {
  const status = await (await request.get('/api/auth/status')).json();
  const response = status.setupRequired
    ? await request.post('/api/auth/setup', { data: USER })
    : await request.post('/api/auth/login', {
        data: { email: USER.email, password: USER.password },
      });
  if (!response.ok())
    throw new Error(`Authentication failed (${response.status()}): ${await response.text()}`);
  return (await response.json()).token;
}

export async function signIn(page: Page, token: string) {
  await page.addInitScript((t) => localStorage.setItem('ff.token', t), token);
}

export async function createWorkflow(
  request: APIRequestContext,
  token: string,
  body: Record<string, unknown>,
) {
  const response = await request.post('/api/workflows', {
    data: body,
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok()) throw new Error(await response.text());
  return response.json() as Promise<{ id: string; name: string }>;
}

export const manualTrigger = {
  id: 'trigger',
  name: 'Manual Trigger',
  type: 'flowforge.manualTrigger',
  typeVersion: 1,
  position: [0, 0],
  parameters: {},
};

/** Fire a synthetic clipboard event (works without clipboard permissions). */
export async function copySelection(page: Page): Promise<string> {
  return page.evaluate(() => {
    const dt = new DataTransfer();
    document.dispatchEvent(new ClipboardEvent('copy', { clipboardData: dt, bubbles: true }));
    return dt.getData('text/plain');
  });
}

export async function pasteText(page: Page, text: string) {
  await page.evaluate((t) => {
    const dt = new DataTransfer();
    dt.setData('text/plain', t);
    document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }));
  }, text);
}
