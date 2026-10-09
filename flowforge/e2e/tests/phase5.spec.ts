import { expect, test } from '@playwright/test';
import { getToken, signIn } from './helpers';

/**
 * Phase 5 - AI agents. The server runs against fake AI providers
 * (apps/server/test/fake-ai-server.ts; see README "Phase 5").
 */
let token: string;
test.beforeAll(async ({ request }) => {
  token = await getToken(request);
});

const H = () => ({ authorization: `Bearer ${token}` });

test('add a provider key, build an agent with knowledge and chat with it', async ({ page }) => {
  await signIn(page, token);
  await page.goto('/agents');
  await expect(page.getByRole('heading', { name: 'AI agents' })).toBeVisible();

  // Keys go to the server; the page only shows a hint.
  await page.getByRole('button', { name: /AI providers/ }).click();
  const providers = page.getByRole('dialog');
  await providers.getByLabel('Anthropic (Claude) API key').fill('sk-ant-e2e-test-key-7777');
  await providers.getByLabel('OpenAI API key').fill('sk-openai-e2e-key-8888');
  await providers.getByRole('button', { name: 'Save keys' }).click();
  await expect(page.getByText('AI providers saved')).toBeVisible();

  // New agent from a template.
  await page.getByRole('button', { name: 'New agent' }).first().click();
  await page.getByRole('button', { name: /Receptionist/ }).click();
  await expect(page).toHaveURL(/\/agents\/\w+/);
  await page.getByLabel('Agent name').fill(`Salon desk ${Date.now()}`);

  // Persona builder writes the instructions.
  await page.getByRole('button', { name: 'Persona builder' }).click();
  const builder = page.getByRole('dialog');
  await builder.getByLabel('Business name').fill('Shine Salon');
  await builder.getByRole('button', { name: 'Write instructions' }).click();
  await expect(page.getByLabel('Instructions')).toHaveValue(/voice assistant of Shine Salon/);

  // Pipeline engine with Claude as the brain.
  await page.getByRole('tab', { name: 'Voice & models' }).click();
  await page.getByRole('radio', { name: /Pipeline/ }).click();
  await expect(page.getByLabel('LLM provider')).toHaveValue('anthropic');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Agent saved')).toBeVisible();

  // Knowledge.
  await page.getByRole('tab', { name: 'Knowledge' }).click();
  await page.getByRole('button', { name: 'Write', exact: true }).click();
  const doc = page.getByRole('dialog');
  await doc.getByLabel('Title').fill('Price list');
  await doc.getByLabel('Content').fill('Haircut: 300 rupees.\n\nBeard trim: 150 rupees.');
  await doc.getByRole('button', { name: 'Save document' }).click();
  await expect(page.getByTestId('documents')).toContainText('Price list');
  await page.getByLabel('Search knowledge').fill('beard');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.getByTestId('search-results')).toContainText('Beard trim: 150 rupees');

  // Test chat: the agent looks the price up.
  await page.getByLabel('Message').fill('What is the price of a haircut?');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByTestId('agent-reply').last()).toContainText('300 rupees');
  await expect(page.getByTestId('test-chat')).toContainText('search_knowledge');
});

test('a test number answered by the AI agent: call, hear it, call log has the transcript', async ({
  page,
  request,
}) => {
  // An agent (the one from the previous test or a new one) on a fresh test number.
  const agents = (await (await request.get('/api/agents', { headers: H() })).json()).data;
  const agent =
    agents[0] ??
    (await (
      await request.post('/api/agents', {
        headers: H(),
        data: { name: 'Voice test', engine: 'pipeline' },
      })
    ).json());
  await request.put(`/api/agents/${agent.id}`, {
    headers: H(),
    data: { ...agent, engine: 'pipeline', greeting: 'Hello from the AI desk!' },
  });
  await request.put('/api/ai/providers', {
    headers: H(),
    data: { openai: 'sk-openai-e2e-key-8888', anthropic: 'sk-ant-e2e-test-key-7777' },
  });
  const account = await (
    await request.post('/api/whatsapp/accounts/simulator', {
      headers: H(),
      data: { name: `AI ${Date.now()}` },
    })
  ).json();

  await signIn(page, token);
  await page.goto('/whatsapp');
  const card = page.getByTestId('whatsapp-account').filter({ hasText: account.displayPhoneNumber });
  await card.getByRole('button', { name: /^Calls/ }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('radio', { name: /AI voice agent/ }).click();
  await dialog.getByLabel('AI agent').selectOption(agent.id);
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Call settings saved')).toBeVisible();

  await card.getByRole('button', { name: 'Open simulator' }).click();
  await page.getByRole('button', { name: 'Call', exact: true }).click();
  await expect(page.getByTestId('current-call')).toContainText('Test call to');
  await expect(page.getByTestId('call-timer')).toHaveText(/00:0[3-9]/, { timeout: 15_000 });
  await page.getByRole('button', { name: 'Hang up' }).click();

  await page.goto('/calls');
  const row = page.getByTestId('call-row').first();
  await expect(row).toHaveAttribute('data-status', 'ended', { timeout: 15_000 });
  await expect(row).toContainText('AI agent');
  await row.getByRole('button').first().click();
  await expect(row).toContainText('Hello from the AI desk!');
});
