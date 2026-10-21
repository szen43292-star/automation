import { expect, test } from '@playwright/test';
import { getToken, signIn } from './helpers';

/** Phase 6 - dashboard, templates, team, API keys, outbound calls. */
let token: string;
test.beforeAll(async ({ request }) => {
  token = await getToken(request);
});

const H = () => ({ authorization: `Bearer ${token}` });

test('dashboard and templates', async ({ page }) => {
  await signIn(page, token);
  await page.goto('/');
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  await expect(page.getByTestId('kpis')).toContainText('Calls');
  await page.getByRole('button', { name: '30 days' }).click();
  await expect(page.getByRole('button', { name: '30 days' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  await page.getByRole('link', { name: 'Templates' }).click();
  const card = page.getByTestId('template').filter({ hasText: 'Missed call → WhatsApp follow-up' });
  await card.getByRole('button', { name: 'Use template' }).click();
  await expect(page).toHaveURL(/\/workflow\/\w+/);
  await expect(page.getByText('Send follow-up')).toBeVisible();
});

test('invite a teammate who joins with their own password; API keys work', async ({
  page,
  browser,
  request,
}) => {
  await signIn(page, token);
  await page.goto('/settings');
  await page.getByRole('button', { name: 'Invite' }).click();
  const dialog = page.getByRole('dialog');
  const email = `meera.${Date.now()}@example.com`;
  await dialog.getByLabel('Name').fill('Meera');
  await dialog.getByLabel('Email').fill(email);
  await dialog.getByRole('button', { name: 'Create invitation' }).click();
  const link = await dialog.getByLabel('Invitation link').inputValue();
  expect(link).toMatch(/\/invite\/[\w-]+$/);
  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByTestId('team')).toContainText('Meera');

  // Meera opens the link in her own browser.
  const meera = await browser.newContext();
  const meeraPage = await meera.newPage();
  await meeraPage.goto(new URL(link).pathname);
  await expect(meeraPage.getByText('You were invited as member')).toBeVisible();
  await meeraPage.getByLabel('Password').fill('Meera-Passw0rd');
  await meeraPage.getByRole('button', { name: 'Join' }).click();
  await expect(meeraPage.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  await meera.close();

  // API key: shown once, works with X-API-Key.
  await page.getByRole('tab', { name: 'API keys' }).click();
  await page.getByLabel('Key name').fill('E2E key');
  await page.getByRole('button', { name: 'Create key' }).click();
  const key = await page.getByLabel('New API key').inputValue();
  expect(key).toMatch(/^ff_/);
  const res = await request.get('/api/workflows', { headers: { 'x-api-key': key } });
  expect(res.ok()).toBe(true);
  await expect(page.getByTestId('api-keys')).toContainText('E2E key');
});

test('call a customer: ask permission, they allow it, you call them and they answer', async ({
  browser,
  request,
}) => {
  const account = await (
    await request.post('/api/whatsapp/accounts/simulator', {
      headers: H(),
      data: { name: `Out ${Date.now()}` },
    })
  ).json();
  const customer = '919812345678';
  await request.post(`/api/whatsapp/accounts/${account.id}/simulate`, {
    headers: H(),
    data: { from: customer, name: 'Kiran', text: 'Please call me back' },
  });

  // The business (desk) and the test customer's "phone" (the simulator) in two browsers.
  const business = await browser.newContext({ permissions: ['microphone'] });
  const desk = await business.newPage();
  await signIn(desk, token);
  const customerContext = await browser.newContext({ permissions: ['microphone'] });
  const phone = await customerContext.newPage();
  await signIn(phone, token);

  for (const p of [desk, phone]) {
    await p.goto('/whatsapp');
    await p
      .getByTestId('whatsapp-account')
      .filter({ hasText: account.displayPhoneNumber })
      .getByRole('button', { name: 'Open simulator' })
      .click();
    await p.getByText('Kiran').first().click();
  }

  // Ask permission.
  await desk.getByRole('button', { name: 'Call customer' }).click();
  const dialog = desk.getByRole('dialog');
  await expect(dialog.getByTestId('call-permission')).toContainText('Not asked yet');
  await dialog.getByRole('button', { name: 'Ask permission to call' }).click();
  await expect(dialog.getByTestId('call-permission')).toContainText('waiting');

  // The customer taps "Allow calls".
  await phone.getByRole('button', { name: 'Allow calls' }).click();
  await expect(dialog.getByTestId('call-permission')).toContainText('Allowed calls');

  // Call them from the desk; their phone rings and they answer.
  await dialog.getByRole('button', { name: 'Call from this device' }).click();
  const ringing = phone.getByTestId('incoming-call').filter({ hasText: 'is being called' });
  await expect(ringing).toBeVisible();
  await ringing.getByRole('button', { name: 'Answer' }).click();
  await expect(phone.getByTestId('current-call')).toBeVisible();
  await expect(desk.getByTestId('call-timer')).toHaveText(/00:0[2-9]/, { timeout: 15_000 });

  await desk.getByRole('button', { name: 'Hang up' }).click();
  await expect(phone.getByTestId('current-call')).toHaveCount(0, { timeout: 10_000 });
  // The phone clears the call before the server has saved it as ended.
  await expect
    .poll(
      async () =>
        (await (await request.get(`/api/calls?accountId=${account.id}`, { headers: H() })).json())
          .data[0],
      { timeout: 10_000 },
    )
    .toMatchObject({ direction: 'outbound', status: 'ended', handledBy: 'person' });

  await business.close();
  await customerContext.close();
});
