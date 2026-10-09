import { expect, test, type APIRequestContext } from '@playwright/test';
import { createWorkflow, getToken, signIn } from './helpers';

let token: string;
test.beforeAll(async ({ request }) => {
  token = await getToken(request);
});
test.beforeEach(async ({ page }) => {
  await signIn(page, token);
});

const H = () => ({ authorization: `Bearer ${token}` });
const node = (
  id: string,
  type: string,
  position: [number, number],
  parameters: Record<string, unknown> = {},
) => ({
  id,
  name: id,
  type,
  typeVersion: 1,
  position,
  parameters,
});

async function testNumber(request: APIRequestContext, name: string) {
  const res = await request.post('/api/whatsapp/accounts/simulator', {
    headers: H(),
    data: { name },
  });
  expect(res.ok()).toBe(true);
  return (await res.json()) as { id: string; displayPhoneNumber: string };
}

test('WhatsApp page: checklist, add a test number', async ({ page }) => {
  await page.goto('/whatsapp');
  await expect(page.getByRole('heading', { name: 'WhatsApp', exact: true })).toBeVisible();
  await expect(page.getByText('Setup checklist')).toBeVisible();
  await expect(page.getByTestId('step-calls')).toBeVisible();
  const before = await page.getByTestId('whatsapp-account').count();
  await page.getByRole('button', { name: 'Add test number' }).click();
  await expect(page.getByText('Test number added')).toBeVisible();
  await expect(page.getByTestId('whatsapp-account')).toHaveCount(before + 1);
});

test('simulator: a workflow answers with buttons and the customer taps one', async ({
  page,
  request,
}) => {
  const account = await testNumber(request, `Bakery ${Date.now()}`);
  const wf = await createWorkflow(request, token, {
    name: 'WhatsApp auto-reply',
    nodes: [
      node('Incoming', 'flowforge.whatsAppTrigger', [0, 0], {
        account: account.id,
        events: ['message'],
        messageTypes: ['text'],
      }),
      node('Ask', 'flowforge.whatsApp', [240, 0], {
        account: account.id,
        operation: 'sendButtons',
        to: '={{ $json.from }}',
        bodyText: '=Hi {{ $json.contactName }}! Would you like to order?',
        buttons: {
          button: [
            { title: 'Yes please', id: 'yes' },
            { title: 'No thanks', id: 'no' },
          ],
        },
      }),
    ],
    connections: [{ source: 'Incoming', sourceOutput: 0, target: 'Ask', targetInput: 0 }],
  });
  const activated = await request.patch(`/api/workflows/${wf.id}`, {
    headers: H(),
    data: { active: true },
  });
  expect(activated.ok()).toBe(true);

  await page.goto('/whatsapp');
  const card = page.getByTestId('whatsapp-account').filter({ hasText: account.displayPhoneNumber });
  await card.getByRole('button', { name: 'Open simulator' }).click();
  const input = page.getByLabel('Message as customer');
  await input.fill('Hi there');
  await input.press('Enter');

  const thread = page.getByTestId('chat-thread');
  await expect(thread.getByTestId('bubble-in').filter({ hasText: 'Hi there' })).toBeVisible();
  await expect(
    thread
      .getByTestId('bubble-out')
      .filter({ hasText: 'Hi Test customer! Would you like to order?' }),
  ).toBeVisible();
  await expect(thread.getByLabel('read')).toBeVisible({ timeout: 10_000 });
  await thread.getByRole('button', { name: 'Yes please' }).click();
  await expect(thread.getByTestId('bubble-in').filter({ hasText: 'Yes please' })).toBeVisible();
});

test('WhatsApp node: templates load for the chosen number; trigger listens for a test message', async ({
  page,
  request,
}) => {
  const account = await testNumber(request, `Clinic ${Date.now()}`);
  const wf = await createWorkflow(request, token, {
    name: 'WhatsApp editor',
    nodes: [
      node('WhatsApp Trigger', 'flowforge.whatsAppTrigger', [0, 0], {
        account: account.id,
        events: ['message'],
      }),
      node('Remind', 'flowforge.whatsApp', [240, 0], {
        account: account.id,
        operation: 'sendTemplate',
        to: '={{ $json.from }}',
      }),
    ],
    connections: [
      { source: 'WhatsApp Trigger', sourceOutput: 0, target: 'Remind', targetInput: 0 },
    ],
  });
  await page.goto(`/workflow/${wf.id}`);

  await page.locator('.react-flow__node').nth(1).dblclick();
  const template = page.locator('select').filter({ hasText: 'hello_world' });
  await expect(template).toBeVisible();
  await template.selectOption('appointment_reminder');
  await page.keyboard.press('Escape');

  await page.locator('.react-flow__node').first().dblclick();
  await page.getByRole('button', { name: 'Listen for test event' }).click();
  await expect(page.getByText('Waiting for a WhatsApp message')).toBeVisible();
  await page.getByLabel('Test message').fill('Can I book for Monday?');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByText('Test message received')).toBeVisible();
  await expect(page.getByText('Can I book for Monday?').first()).toBeVisible();
});
