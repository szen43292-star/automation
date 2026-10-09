import { expect, test, type APIRequestContext } from '@playwright/test';
import { getToken, signIn } from './helpers';

let token: string;
test.beforeAll(async ({ request }) => {
  token = await getToken(request);
});

const H = () => ({ authorization: `Bearer ${token}` });

async function testNumberWithCalls(request: APIRequestContext, settings: Record<string, unknown>) {
  const account = await (
    await request.post('/api/whatsapp/accounts/simulator', {
      headers: H(),
      data: { name: `Calls ${Date.now()}` },
    })
  ).json();
  const defaults = (
    await (
      await request.get(`/api/whatsapp/accounts/${account.id}/calling`, { headers: H() })
    ).json()
  ).settings;
  const saved = await request.put(`/api/whatsapp/accounts/${account.id}/calling`, {
    headers: H(),
    data: { ...defaults, ...settings },
  });
  expect(saved.ok()).toBe(true);
  return account as { id: string; displayPhoneNumber: string };
}

test('a call to a test number rings in the app; answer, talk, hang up; it is in the call log', async ({
  browser,
  request,
}) => {
  const account = await testNumberWithCalls(request, { mode: 'app', ringSeconds: 40 });

  // The business, with FlowForge open on the Calls page.
  const business = await browser.newContext({ permissions: ['microphone'] });
  const desk = await business.newPage();
  await signIn(desk, token);
  await desk.goto('/calls');
  await expect(desk.getByRole('heading', { name: 'Calls' })).toBeVisible();

  // The customer calls the test number from the simulator.
  const customer = await browser.newContext({ permissions: ['microphone'] });
  const phone = await customer.newPage();
  await signIn(phone, token);
  await phone.goto('/whatsapp');
  await phone
    .getByTestId('whatsapp-account')
    .filter({ hasText: account.displayPhoneNumber })
    .getByRole('button', { name: 'Open simulator' })
    .click();
  await phone.getByRole('button', { name: 'Call', exact: true }).click();
  await expect(phone.getByTestId('current-call')).toContainText('Test call to');

  // It rings for the business (and on the customer's own page too - same account in this test).
  const ringing = desk.getByTestId('incoming-call');
  await expect(ringing).toContainText('Incoming WhatsApp call');
  await expect(ringing).toContainText('+919876543210');
  await ringing.getByRole('button', { name: 'Answer' }).click();
  await expect(desk.getByTestId('current-call')).toContainText('On call with');
  await expect(desk.getByTestId('call-timer')).toHaveText(/00:0[2-9]/, { timeout: 15_000 });
  await expect(desk.getByTestId('call-row').first()).toHaveAttribute('data-status', 'answered');

  await desk.getByRole('button', { name: 'Hang up' }).click();
  await expect(desk.getByTestId('current-call')).toHaveCount(0);
  await expect(phone.getByTestId('current-call')).toHaveCount(0, { timeout: 10_000 });
  const row = desk.getByTestId('call-row').first();
  await expect(row).toHaveAttribute('data-status', 'ended');
  await expect(row).toContainText('Answered in the app');
  await row.getByRole('button', { name: 'Play recording' }).click();
  await expect(desk.getByTestId('recording-player')).toBeVisible();

  await business.close();
  await customer.close();
});

test('call settings: voicemail mode is saved from the number’s Calls dialog', async ({
  page,
  request,
}) => {
  const account = await testNumberWithCalls(request, { mode: 'app' });
  await signIn(page, token);
  await page.goto('/whatsapp');
  const card = page.getByTestId('whatsapp-account').filter({ hasText: account.displayPhoneNumber });
  await card.getByRole('button', { name: /^Calls/ }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('radio', { name: /Voicemail/ }).click();
  await dialog.getByRole('switch', { name: 'Use business hours' }).click();
  await expect(dialog.getByLabel('Opens').first()).toBeVisible();
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Call settings saved')).toBeVisible();
  const saved = await (
    await request.get(`/api/whatsapp/accounts/${account.id}/calling`, { headers: H() })
  ).json();
  expect(saved).toMatchObject({
    callingEnabled: true,
    settings: { mode: 'voicemail', businessHours: { enabled: true } },
  });
});
