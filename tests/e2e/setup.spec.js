// The setup views: the Rig view's plan, patch and inspector, pixel mapping a
// bar by drawing it, identify, the stored settings and their secrets, the
// pre-show check, and the old settings page's links.

import { test, expect } from '@playwright/test';
import { open, reset, state, until } from './helpers.js';

const BAR = { id: 'e2e-bar-8', name: 'E2E Bar', cells: 8, firstChannel: 3, order: 'RGB', dimmer: 1, strobe: 2 };

test.beforeEach(async ({ request }) => { await reset(request); });

/** Put the patch back to what it was: remove whatever a test added. */
async function restorePatch(request, before) {
  const keep = new Set(before.fixtures.map((f) => f.id));
  for (const f of (await state(request)).fixtures) {
    if (!keep.has(f.id)) await request.delete(`/api/fixtures/${f.id}`);
  }
}

async function settings(request) {
  return (await (await request.get('/api/settings')).json());
}

test('selecting a fixture on the plan selects its row and shows it in the inspector', async ({ page, request }) => {
  await open(page, 'rig');
  await expect(page.getByRole('tab', { name: 'Plan & patch' })).toHaveAttribute('aria-selected', 'true');
  const s = await state(request);
  const second = s.fixtures[1];
  await page.locator(`.plan-surface [data-fixture="${second.id}"]`).click();
  await expect(page.locator('.inspector .panel-title')).toHaveText('Fixture 2');
  await expect(page.locator('.patch-table tbody tr').nth(1)).toHaveClass(/selected/);
  await expect(page.getByRole('checkbox', { name: `Select ${second.label}` })).toBeChecked();
});

test('dragging a fixture on the plan moves it on the server', async ({ page, request }) => {
  const before = await state(request);
  await open(page, 'rig');
  const lamp = page.locator(`.plan-surface [data-fixture="${before.fixtures[0].id}"]`);
  const box = await lamp.boundingBox();
  const surface = await page.locator('.plan-surface').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + 17);
  await page.mouse.down();
  await page.mouse.move(surface.x + surface.width * 0.2, surface.y + surface.height * 0.8, { steps: 8 });
  await page.mouse.up();
  const after = await until(request, (st) => st.fixtures[0].position && st.fixtures[0].position.y > 60);
  expect(after.fixtures[0].position.x).toBeLessThan(30);
  // Snapping is on: the grid is 2.5%.
  expect(after.fixtures[0].position.x % 2.5).toBeCloseTo(0, 5);
  // The drag selected it; the inspector puts it back where it was.
  await page.locator('.inspector').getByRole('button', { name: 'Reset place' }).click();
  await until(request, (st) => st.fixtures[0].position === null);
});

test('the patch table renames, adds a run of fixtures, and removes one with undo', async ({ page, request }) => {
  const before = await state(request);
  await open(page, 'rig');
  const label = page.getByRole('textbox', { name: 'Label of fixture 1' });
  await label.fill('Stage left');
  await label.press('Enter');
  await until(request, (s) => s.fixtures[0].label === 'Stage left');

  const form = page.getByRole('form', { name: 'Add fixtures' });
  await form.getByRole('spinbutton', { name: 'How many' }).fill('3');
  await form.getByRole('spinbutton', { name: 'Universe' }).fill('5');
  await form.getByRole('textbox', { name: 'Name' }).fill('Floor');
  await form.getByRole('button', { name: 'Add' }).click();
  const added = await until(request, (s) => s.fixtures.length === before.fixtures.length + 3);
  const floor = added.fixtures.filter((f) => f.label.startsWith('Floor'));
  expect(floor.map((f) => [f.label, f.universe, f.address])).toEqual([['Floor 1', 5, 1], ['Floor 2', 5, 13], ['Floor 3', 5, 25]]);
  await expect(page.locator('.patch-table tbody tr.selected')).toHaveCount(3);

  await page.getByRole('button', { name: 'Remove Floor 2' }).click();
  await until(request, (s) => !s.fixtures.some((f) => f.label === 'Floor 2'));
  await page.getByRole('button', { name: 'Undo' }).click();
  await until(request, (s) => s.fixtures.some((f) => f.label === 'Floor 2'));

  await label.fill(before.fixtures[0].label);
  await label.press('Enter');
  await until(request, (s) => s.fixtures[0].label === before.fixtures[0].label);
  await restorePatch(request, before);
});

test('identify flashes a fixture and every page is told', async ({ page, request }) => {
  const { fixtures } = await state(request);
  await open(page, 'rig');
  await page.getByRole('button', { name: `Identify ${fixtures[2].label}` }).click();
  await until(request, (s) => s.identify && s.identify.ids.includes(fixtures[2].id));
  await expect(page.locator(`.plan-surface [data-fixture="${fixtures[2].id}"]`)).toHaveClass(/identifying/);
  await request.post('/api/identify/stop', { data: {} });
  await until(request, (s) => s.identify && s.identify.ids.length === 0);
});

test('a bar is mapped by drawing it, first cell to last, and the next bar is lit', async ({ page, request }) => {
  const before = await state(request);
  expect((await request.post('/api/profiles/bar', { data: BAR })).ok()).toBeTruthy();
  const add = await (await request.post('/api/fixtures', { data: { profileId: BAR.id, count: 2, universe: 7, label: 'Truss' } })).json();
  expect(add.ok).toBeTruthy();
  const [first, second] = add.fixtures;
  await open(page, 'rig');
  await page.locator(`.plan-surface [data-fixture="${first}"]`).click();
  await page.getByRole('button', { name: 'Draw bar' }).click();
  await expect(page.locator('.plan-hint')).toContainText('Truss 1');
  await until(request, (s) => s.identify.ids.includes(first));

  // From the right of the stage to the left: this bar hangs backwards.
  const surface = await page.locator('.plan-surface').boundingBox();
  await page.mouse.move(surface.x + surface.width * 0.7, surface.y + surface.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(surface.x + surface.width * 0.3, surface.y + surface.height * 0.3, { steps: 10 });
  await page.mouse.up();
  const drawn = await until(request, (s) => s.fixtures.find((f) => f.id === first).geometry);
  const bar = drawn.fixtures.find((f) => f.id === first);
  expect(Math.abs(bar.geometry.angle)).toBe(180);
  expect(bar.position.x).toBeGreaterThan(40);
  expect(bar.position.x).toBeLessThan(60);

  await expect(page.locator('.plan-hint')).toContainText('Truss 2');
  await until(request, (s) => s.identify.ids.includes(second));
  await page.keyboard.press('Escape');
  await expect(page.locator('.plan-hint')).toHaveCount(0);
  await until(request, (s) => s.identify.ids.length === 0);

  await restorePatch(request, before);
  await request.delete(`/api/profiles/${BAR.id}`);
});

test('a setting is applied, and a secret is set and cleared without ever being shown', async ({ page, request }) => {
  await open(page, 'settings');
  const section = page.locator('[data-section="show"]');
  const flash = section.getByRole('checkbox', { name: 'Flash Limit' });
  const was = await flash.isChecked();
  await flash.setChecked(!was);
  await expect(section.getByText('Not applied yet')).toBeVisible();
  await section.getByRole('button', { name: 'Apply' }).click();
  await expect(section.getByRole('status')).toHaveText('Saved');
  expect((await settings(request)).settings.safety.flashLimit).toBe(!was);
  await flash.setChecked(was);
  await section.getByRole('button', { name: 'Apply' }).click();

  await page.getByRole('tab', { name: /Sources/ }).click();
  const deezer = page.locator('[data-section="deezer"]');
  const arl = deezer.getByRole('textbox', { name: 'ARL Cookie' });
  await arl.fill('a-secret-cookie');
  await deezer.getByRole('button', { name: 'Apply' }).click();
  await expect(deezer.getByRole('status')).toHaveText('Saved');
  const stored = await settings(request);
  expect(stored.secrets['deezer.arl']).toBe(true);
  expect(stored.settings.deezer.arl).toBe('');
  await expect(arl).toHaveValue('');
  await expect(arl).toHaveAttribute('placeholder', /leave blank to keep/);
  await deezer.getByRole('button', { name: 'Clear ARL Cookie' }).click();
  await expect.poll(async () => (await settings(request)).secrets['deezer.arl']).toBe(false);
});

test('the pre-show check runs and says what it found', async ({ page }) => {
  test.setTimeout(60_000);
  await open(page, 'preflight');
  await page.getByRole('button', { name: 'Run the check' }).click();
  await expect(page.locator('.preflight-summary')).toBeVisible({ timeout: 45_000 });
  await expect(page.locator('.preflight-row').first()).toBeVisible();
  // Kept when looking elsewhere and coming back.
  await page.getByRole('tab', { name: /Rig/ }).click();
  await page.getByRole('tab', { name: /Preflight/ }).click();
  await expect(page.locator('.preflight-summary')).toBeVisible();
});

test('the old settings page\'s links land on the views that hold them now', async ({ page }) => {
  await page.goto('/settings.html#music');
  await expect(page).toHaveURL(/\/#sources$/);
  await page.locator('#panel-sources').waitFor();
  await page.goto('/settings.html#output');
  await expect(page.locator('#panel-rig')).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Outputs' })).toHaveAttribute('aria-selected', 'true');
  await expect(page).toHaveURL(/#rig\/outputs$/);
  await page.goto('/settings.html#check');
  await expect(page.locator('#panel-preflight')).toBeVisible();
});

test('a view\'s own tabs follow the arrow keys and the address', async ({ page }) => {
  await open(page, 'rig');
  await page.getByRole('tab', { name: 'Plan & patch' }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'Profiles' })).toBeFocused();
  await expect(page).toHaveURL(/#rig\/profiles$/);
  await expect(page.getByRole('heading', { name: 'Fixture profiles' })).toBeVisible();
  await page.goto('/#rig/outputs');
  await expect(page.getByRole('heading', { name: 'Art-Net' })).toBeVisible();
  await page.locator('body').press('6');
  await expect(page.locator('#panel-rig')).toBeVisible();
});
