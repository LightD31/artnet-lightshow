// The first-run setup: offered on a fresh install, walked through step by
// step, and not offered again once finished or skipped.

import { test, expect } from '@playwright/test';
import { open, reset, state, until } from './helpers.js';

const setupDone = (request, completed) => request.put('/api/settings', { data: { setup: { completed } } });
const settings = async (request) => (await (await request.get('/api/settings')).json()).settings;

test.beforeEach(async ({ request }) => { await reset(request); });
test.afterEach(async ({ request }) => { await setupDone(request, true); });

test('a fresh install is walked from outputs to the pre-show check', async ({ page, request }) => {
  test.setTimeout(90_000);
  const before = await state(request);
  await setupDone(request, false);
  await page.goto('/#manual');
  const dialog = page.getByRole('dialog', { name: /Set up the rig/ });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Skip setup' })).toBeFocused();

  await dialog.getByRole('button', { name: 'Start' }).click();
  await expect(dialog.locator('#wizard-title')).toContainText('Outputs');
  await expect(dialog.getByText('only WLEDs and Hue lamps')).toBeVisible();
  await dialog.getByRole('button', { name: 'Next' }).click();

  await expect(dialog.locator('#wizard-title')).toContainText('Fixtures');
  const form = dialog.getByRole('form', { name: 'Add fixtures' });
  await form.getByRole('spinbutton', { name: 'How many' }).fill('2');
  await form.getByRole('spinbutton', { name: 'Universe' }).fill('9');
  await form.getByRole('textbox', { name: 'Name' }).fill('Wizard');
  await form.getByRole('button', { name: 'Add' }).click();
  await until(request, (s) => s.fixtures.length === before.fixtures.length + 2);
  await expect(dialog.getByText('In the patch (' + (before.fixtures.length + 2) + ')')).toBeVisible();
  await dialog.getByRole('button', { name: 'Next' }).click();

  await expect(dialog.locator('#wizard-title')).toContainText('Placement');
  await dialog.getByRole('button', { name: /all in a row/ }).click();
  await until(request, (s) => s.fixtures.every((f) => f.position));
  await dialog.getByRole('button', { name: 'Next' }).click();

  await expect(dialog.locator('#wizard-title')).toContainText('Music');
  await dialog.getByRole('textbox', { name: 'Client ID' }).fill('e2e-client-id');
  await dialog.getByRole('button', { name: 'Next' }).click();
  await expect.poll(async () => (await settings(request)).spotify.clientId).toBe('e2e-client-id');

  await expect(dialog.locator('#wizard-title')).toContainText('Check');
  await expect(dialog.locator('.preflight-summary')).toBeVisible({ timeout: 45_000 });
  await dialog.getByRole('button', { name: 'Finish' }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(async () => (await settings(request)).setup.completed).toBe(true);

  // Not offered again.
  await page.reload();
  await page.locator('#panel-manual').waitFor();
  await expect(page.getByRole('dialog', { name: /Set up the rig/ })).toHaveCount(0);

  await request.put('/api/settings', { data: { spotify: { clientId: '' } } });
  for (const f of (await state(request)).fixtures) {
    if (!before.fixtures.some((b) => b.id === f.id)) await request.delete(`/api/fixtures/${f.id}`);
  }
});

test('the setup can be left, keeps what was done, and is there again in Settings', async ({ page, request }) => {
  await setupDone(request, false);
  await page.goto('/#manual');
  const dialog = page.getByRole('dialog', { name: /Set up the rig/ });
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog.getByText('Leave the setup?')).toBeVisible();
  await dialog.getByRole('button', { name: 'Keep going' }).click();
  await dialog.getByRole('button', { name: 'Skip setup' }).click();
  await dialog.getByRole('button', { name: 'Leave the setup' }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(async () => (await settings(request)).setup.completed).toBe(true);

  await open(page, 'settings');
  await page.getByRole('button', { name: 'Run the setup again' }).click();
  await expect(page.getByRole('dialog', { name: /Set up the rig/ })).toBeVisible();
});
