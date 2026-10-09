import { devices, expect, test } from '@playwright/test';
import { getToken, signIn } from './helpers';

/** Phase 7 - the phone layout (what the Android / iPhone app shows). */
let token: string;
test.beforeAll(async ({ request }) => {
  token = await getToken(request);
});

test.use({ ...devices['Pixel 7'], permissions: ['microphone'] });

test('phone layout: bottom tabs, More menu, and pages fit the screen', async ({ page }) => {
  await signIn(page, token);
  await page.goto('/');
  const tabs = page.getByRole('navigation', { name: 'Main' });
  await expect(tabs).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();

  await tabs.getByRole('link', { name: 'Calls' }).click();
  await expect(page.getByRole('heading', { name: 'Calls' })).toBeVisible();
  await tabs.getByRole('link', { name: 'Agents' }).click();
  await expect(page.getByRole('heading', { name: 'AI agents' })).toBeVisible();

  await tabs.getByRole('button', { name: 'More' }).click();
  await page.getByRole('link', { name: 'Settings' }).click();
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();

  // Nothing is wider than the phone.
  for (const path of ['/dashboard', '/calls', '/whatsapp', '/agents', '/settings', '/templates']) {
    await page.goto(path);
    await page.waitForLoadState('networkidle');
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow, path).toBeLessThanOrEqual(1);
  }
});
