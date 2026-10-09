import { expect, test } from '@playwright/test';
import { createWorkflow, getToken, manualTrigger, signIn } from './helpers';

let token: string;
test.beforeAll(async ({ request }) => {
  token = await getToken(request);
});
test.beforeEach(async ({ page }) => {
  await signIn(page, token);
});

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

test('JavaScript expressions: sandboxed preview and autocomplete', async ({ page, request }) => {
  const wf = await createWorkflow(request, token, {
    name: 'Expressions',
    nodes: [
      manualTrigger,
      node('Data', 'flowforge.code', [220, 0], {
        jsCode: "return [{ json: { name: 'asha', price: 10, qty: 3 } }];",
      }),
      node('Set', 'flowforge.set', [440, 0], {
        mode: 'manual',
        includeOtherFields: false,
        options: {},
        assignments: {
          assignments: [
            {
              id: 'a',
              name: 'total',
              value: '={{ $json.price * $json.qty }} for {{ $json.name.toUpperCase() }}',
              type: 'string',
            },
          ],
        },
      }),
    ],
    connections: [
      { source: 'trigger', sourceOutput: 0, target: 'Data', targetInput: 0 },
      { source: 'Data', sourceOutput: 0, target: 'Set', targetInput: 0 },
    ],
  });
  await page.goto(`/workflow/${wf.id}`);
  await page.getByRole('button', { name: 'Execute workflow' }).click();
  await expect(page.getByText('Succeeded')).toBeVisible();
  await page.locator('.react-flow__node').nth(2).dblclick();

  const preview = page.getByTestId('expression-preview').first();
  await expect(preview).toContainText('30 for ASHA');

  // Type into the expression editor and use autocomplete.
  const editor = page.locator('.ff-expression-editor .cm-content').first();
  await editor.click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('{{ $json.');
  await expect(page.locator('.cm-tooltip-autocomplete')).toContainText('price');
  await page.keyboard.press('Escape');
  await page.keyboard.type('qty }}');
  await expect(preview).toContainText('Result: 3');

  // The preview sandbox has no access to the editor's storage or network, and stops runaway code.
  await editor.click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('{{ typeof localStorage + "/" + typeof fetch }}');
  await expect(preview).toContainText('undefined/');
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('{{ (() => { while (true) {} })() }}');
  await expect(preview).toContainText('took longer than 1 second', { timeout: 5_000 });
});

test('credentials: create, mask secrets, use in a node', async ({ page }) => {
  await page.goto('/credentials');
  await page.getByRole('button', { name: 'Add credential' }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.locator('select').first().selectOption('httpHeaderAuth');
  await dialog.locator('input').nth(0).fill('E2E Shop API');
  await dialog.getByPlaceholder('X-API-Key').fill('X-Api-Key');
  await dialog.locator('input[type="password"]').fill('super-secret');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Credential saved')).toBeVisible();
  await dialog.getByRole('button', { name: 'Close', exact: true }).last().click();
  await expect(page.getByText('E2E Shop API').first()).toBeVisible();

  // Re-open: the secret is masked, never sent back to the browser.
  await page.getByText('E2E Shop API').first().click();
  const secret = page.getByRole('dialog').locator('input[type="password"]');
  await expect(secret).toHaveValue('__flowforge_secret__');
});

test('webhook: URLs, listen for a test event, and activation', async ({
  page,
  request,
  baseURL,
}) => {
  const path = `e2e-${Date.now()}`;
  const wf = await createWorkflow(request, token, {
    name: 'Webhook E2E',
    nodes: [
      node('Hook', 'flowforge.webhook', [0, 0], {
        httpMethod: 'POST',
        path,
        responseMode: 'onReceived',
      }),
      node('Next', 'flowforge.noOp', [220, 0]),
    ],
    connections: [{ source: 'Hook', sourceOutput: 0, target: 'Next', targetInput: 0 }],
  });
  await page.goto(`/workflow/${wf.id}`);
  await page.locator('.react-flow__node').first().dblclick();
  await expect(page.getByTestId('webhook-url')).toContainText(`/webhook-test/${path}`);
  await page.getByRole('button', { name: 'Listen for test event' }).click();
  await expect(page.getByText('Waiting for a request')).toBeVisible();

  const response = await request.post(`${baseURL}/webhook-test/${path}`, {
    data: { hello: 'from e2e' },
  });
  expect(response.ok()).toBe(true);
  await expect(page.getByText('Test event received')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByText('Succeeded')).toBeVisible();

  // Activate from the header toggle; the production URL now works.
  await page.getByRole('switch', { name: 'Active' }).click();
  await expect(page.getByText('Workflow activated')).toBeVisible();
  const prod = await request.post(`${baseURL}/webhook/${path}`, { data: { n: 1 } });
  expect(prod.status()).toBe(200);
  expect((await prod.json()).message).toBe('Workflow was started');
});

test('switch: outputs follow the routing rules', async ({ page, request }) => {
  const rule = (value: string, rename?: string) => ({
    conditions: {
      combinator: 'and',
      conditions: [
        {
          id: '1',
          leftValue: '={{ $json.intent }}',
          rightValue: value,
          operator: { type: 'string', operation: 'equals' },
        },
      ],
    },
    renameOutput: Boolean(rename),
    outputKey: rename ?? '',
  });
  const wf = await createWorkflow(request, token, {
    name: 'Switch E2E',
    nodes: [
      manualTrigger,
      node('Intent', 'flowforge.code', [220, 0], {
        jsCode: "return [{ json: { intent: 'sales' } }, { json: { intent: 'other' } }];",
      }),
      node('Route', 'flowforge.switch', [440, 0], {
        mode: 'rules',
        rules: { values: [rule('sales', 'Sales'), rule('support')] },
        options: { fallbackOutput: 'extra' },
      }),
    ],
    connections: [
      { source: 'trigger', sourceOutput: 0, target: 'Intent', targetInput: 0 },
      { source: 'Intent', sourceOutput: 0, target: 'Route', targetInput: 0 },
    ],
  });
  await page.goto(`/workflow/${wf.id}`);
  const route = page.locator('.react-flow__node').nth(2);
  await expect(route).toContainText('Sales');
  await expect(route).toContainText('Fallback');
  await page.getByRole('button', { name: 'Execute workflow' }).click();
  await expect(page.getByText('Succeeded')).toBeVisible();
  await expect(route).toContainText('Sales · 1 item');
  await expect(route).toContainText('Fallback · 1 item');
});
