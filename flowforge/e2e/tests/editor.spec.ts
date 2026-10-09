import { expect, test } from '@playwright/test';
import {
  copySelection,
  createWorkflow,
  getToken,
  manualTrigger,
  pasteText,
  signIn,
} from './helpers';

let token: string;

test.beforeAll(async ({ request }) => {
  token = await getToken(request);
});

test.beforeEach(async ({ page }) => {
  await signIn(page, token);
});

test('build, run and inspect a workflow', async ({ page }) => {
  await page.goto('/workflow/new');
  await page.getByText('Add first step').click();
  await page.getByPlaceholder('Search nodes…').fill('manual');
  await page.keyboard.press('Enter');

  // Trigger → Code (via the "+" stub)
  await page.getByTitle('Add node').first().click();
  await page.getByPlaceholder('Search nodes…').fill('code');
  await page.keyboard.press('Enter');
  await expect(page.getByText('Back to canvas')).toBeVisible();
  await page.getByText('Back to canvas').click();

  // Code → If with an expression condition
  await page.getByTitle('Add node').first().click();
  await page.getByPlaceholder('Search nodes…').fill('if');
  await page.keyboard.press('Enter');
  await page.locator('input[placeholder^="value1"]').first().fill('={{ $json.myNewField }}');
  await page
    .locator('select')
    .filter({ hasText: 'String: is equal to' })
    .first()
    .selectOption('number:equals');
  await page.locator('input[placeholder="value2"]').first().fill('1');
  await page.getByText('Back to canvas').click();

  await page.getByRole('button', { name: 'Execute workflow' }).click();
  await expect(page.getByText('Succeeded')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.react-flow__edgelabel-renderer')).toContainText('1 item');

  // Inspect the If node: input, output and the expression preview.
  await page.locator('.react-flow__node').nth(2).dblclick();
  await expect(page.getByText('Result:')).toBeVisible();
  await expect(page.getByRole('button', { name: 'true' })).toBeVisible();
  await page.keyboard.press('Escape');

  // Save with the keyboard while the name field has focus.
  await page.getByLabel('Workflow name').fill('E2E demo');
  await page.keyboard.press('Control+s');
  await expect(page.getByRole('button', { name: 'Saved' })).toBeVisible();

  // Execution history for this workflow.
  await page.locator('header').getByRole('link', { name: 'Executions' }).click();
  await expect(page.getByText('Debug in editor')).toBeVisible();
  await expect(page.locator('.react-flow__node')).toHaveCount(3);

  // Load that run's data back into the editor.
  await page.getByRole('button', { name: 'Debug in editor' }).click();
  await expect(page.getByRole('button', { name: 'Execute workflow' })).toBeVisible();
  await expect(page.locator('.react-flow__edgelabel-renderer')).toContainText('1 item');
});

test('drag a field from INPUT into a parameter', async ({ page, request }) => {
  const wf = await createWorkflow(request, token, {
    name: 'Mapping',
    nodes: [
      manualTrigger,
      {
        id: 'code',
        name: 'Code',
        type: 'flowforge.code',
        typeVersion: 1,
        position: [220, 0],
        parameters: {
          mode: 'runOnceForAllItems',
          jsCode: "return [{ json: { customer: { name: 'Asha' } } }];",
        },
      },
      {
        id: 'set',
        name: 'Edit Fields',
        type: 'flowforge.set',
        typeVersion: 1,
        position: [440, 0],
        parameters: {
          mode: 'manual',
          assignments: { assignments: [] },
          includeOtherFields: false,
          options: {},
        },
      },
    ],
    connections: [
      { source: 'trigger', sourceOutput: 0, target: 'code', targetInput: 0 },
      { source: 'code', sourceOutput: 0, target: 'set', targetInput: 0 },
    ],
  });
  await page.goto(`/workflow/${wf.id}`);
  await page.getByRole('button', { name: 'Execute workflow' }).click();
  await expect(page.getByText('Succeeded')).toBeVisible();
  await page.locator('.react-flow__node').nth(2).dblclick();

  // INPUT → Schema view → drag "name" onto the field list.
  await page.locator('section').first().getByTitle('Schema').click();
  const field = page.locator('section').first().locator('[draggable="true"]', { hasText: 'name' });
  await field.dragTo(page.getByText('Drag input fields here, or add a field'));
  await expect(page.locator('input[placeholder="name"]')).toHaveValue('customer.name');
  await expect(page.getByText('Result:').locator('..')).toContainText('Asha');

  await page.getByRole('button', { name: 'Execute step' }).click();
  await expect(page.getByText('{"name":"Asha"}')).toBeVisible();
});

test('canvas editing: undo/redo, copy/paste, delete, sticky notes', async ({ page, request }) => {
  const wf = await createWorkflow(request, token, {
    name: 'Canvas editing',
    nodes: [manualTrigger],
  });
  await page.goto(`/workflow/${wf.id}`);
  const nodes = page.locator('.react-flow__node');
  await expect(nodes).toHaveCount(1);

  await nodes.first().click();
  await page.keyboard.press('Tab');
  await page.getByPlaceholder('Search nodes…').fill('edit fields');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
  await expect(nodes).toHaveCount(2);

  await page.locator('.react-flow__pane').click({ position: { x: 40, y: 40 } });
  await page.keyboard.press('Control+z');
  await expect(nodes).toHaveCount(1);
  await page.keyboard.press('Control+Shift+z');
  await expect(nodes).toHaveCount(2);

  await page.keyboard.press('Control+a');
  const copied = await copySelection(page);
  expect(JSON.parse(copied).nodes).toHaveLength(2);
  await pasteText(page, copied);
  await expect(nodes).toHaveCount(3); // the trigger allows only one instance
  await expect(page.getByText('Edit Fields1')).toBeVisible();

  await page.keyboard.press('Delete');
  await expect(nodes).toHaveCount(2);

  await page.mouse.move(700, 250);
  await page.keyboard.press('Shift+S');
  await expect(page.locator('.react-flow__node-sticky')).toHaveCount(1);
});

test('renders and runs a 250-node workflow', async ({ page, request }) => {
  const nodes: Array<Record<string, unknown>> = [manualTrigger];
  const connections: Array<Record<string, unknown>> = [];
  for (let i = 0; i < 249; i++) {
    nodes.push({
      id: `n${i}`,
      name: `Set ${i}`,
      type: 'flowforge.set',
      typeVersion: 1,
      position: [220 * ((i % 25) + 1), 160 * Math.floor(i / 25)],
      parameters: {
        mode: 'manual',
        includeOtherFields: true,
        assignments: {
          assignments: [{ id: 'a', name: `f${i}`, value: String(i), type: 'string' }],
        },
        options: {},
      },
    });
    connections.push({
      source: i === 0 ? 'trigger' : `n${i - 1}`,
      sourceOutput: 0,
      target: `n${i}`,
      targetInput: 0,
    });
  }
  const wf = await createWorkflow(request, token, { name: 'Perf 250', nodes, connections });
  const started = Date.now();
  await page.goto(`/workflow/${wf.id}`);
  await page.locator('.react-flow__node').first().waitFor();
  expect(Date.now() - started).toBeLessThan(5_000);
  await page.getByRole('button', { name: 'Execute workflow' }).click();
  await expect(page.getByText('Succeeded')).toBeVisible({ timeout: 30_000 });
});
