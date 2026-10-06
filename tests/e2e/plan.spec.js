// The Rig view's plot: placing a lamp from its chip by tap or drag, nudging
// it, auto-place's proposal, apply and undo, and a height that survives a reload.
// Each test puts the positions back the way it found them.

import { test, expect } from '@playwright/test';
import { open, reset, state, until } from './helpers.js';

test.beforeEach(async ({ request }) => { await reset(request); });

const positionOf = (s, id) => s.fixtures.find((f) => f.id === id).position;

/** Placing a lamp selects it: the toolbar's Reset puts it back unplaced. */
async function resetPlace(page, request, id) {
  await expect(page.locator(`.plan-surface [data-fixture="${id}"]`)).toHaveAttribute('aria-pressed', 'true');
  await page.locator('.plan-tools').getByRole('button', { name: 'Reset', exact: true }).click();
  await until(request, (s) => positionOf(s, id) === null);
}

test('a chip tapped then the plot tapped places the lamp; arrow keys nudge it; a chip dragged onto the plot lands there', async ({ page, request }) => {
  const before = await state(request);
  const [first, second] = before.fixtures.filter((f) => !f.position);
  await open(page, 'rig');
  const chip = page.locator(`.plan-chip[data-chip="${first.id}"]`);
  await chip.click();
  await expect(chip).toHaveAttribute('aria-pressed', 'true');
  const surface = await page.locator('.plan-surface').boundingBox();
  await page.mouse.click(surface.x + surface.width * 0.25, surface.y + surface.height * 0.3);
  const placed = positionOf(await until(request, (s) => !!positionOf(s, first.id)), first.id);
  expect(placed.x).toBeLessThan(40);
  expect(placed.y).toBeLessThan(50);
  expect(placed.x % 2.5).toBeCloseTo(0, 5);
  await expect(chip).toHaveCount(0);

  const lamp = page.locator(`.plan-surface [data-fixture="${first.id}"]`);
  await expect(lamp).toHaveAttribute('aria-pressed', 'true');
  await lamp.focus();
  await page.keyboard.press('ArrowRight');
  await until(request, (s) => positionOf(s, first.id).x === placed.x + 2.5);
  await page.keyboard.press('ArrowDown');
  await until(request, (s) => positionOf(s, first.id).y === placed.y + 2.5);
  await resetPlace(page, request, first.id);

  const box = await page.locator(`.plan-chip[data-chip="${second.id}"]`).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(surface.x + surface.width * 0.7, surface.y + surface.height * 0.75, { steps: 8 });
  await page.mouse.up();
  const dropped = positionOf(await until(request, (s) => !!positionOf(s, second.id)), second.id);
  expect(dropped.x).toBeGreaterThan(55);
  expect(dropped.y).toBeGreaterThan(55);
  await resetPlace(page, request, second.id);
});

test('auto-place shows its proposal, applies it in one tap and undoes it in one tap', async ({ page, request }) => {
  const before = await state(request);
  const unplaced = before.fixtures.filter((f) => !f.position);
  expect(unplaced.length).toBeGreaterThan(1);
  await open(page, 'rig');
  await page.getByRole('button', { name: `Auto-place ${unplaced.length}` }).click();
  await expect(page.locator('.plan-ghost')).toHaveCount(unplaced.length);
  await expect(page.locator('.plan-proposal')).toContainText(`Proposed places for ${unplaced.length} lamps`);
  // Shown, not applied.
  expect((await state(request)).fixtures.filter((f) => !f.position)).toHaveLength(unplaced.length);

  await page.locator('.plan-proposal').getByRole('button', { name: 'Apply' }).click();
  const applied = await until(request, (s) => unplaced.every((u) => !!positionOf(s, u.id)));
  await expect(page.locator('.plan-ghost')).toHaveCount(0);
  await expect(page.locator('.plan-chip')).toHaveCount(0);
  for (const f of before.fixtures.filter((x) => x.position)) {
    expect(positionOf(applied, f.id), 'a placed lamp is left where it is').toEqual(f.position);
  }

  await page.getByRole('button', { name: 'Undo auto-place' }).click();
  await until(request, (s) => unplaced.every((u) => positionOf(s, u.id) === null));
  await expect(page.locator('.plan-chip')).toHaveCount(unplaced.length);
});

test('the height set on the plot persists after a reload', async ({ page, request }) => {
  const before = await state(request);
  const target = before.fixtures.find((f) => !f.position);
  await open(page, 'rig');
  await page.locator(`.plan-surface [data-fixture="${target.id}"]`).click();
  const raise = page.getByRole('button', { name: `Raise ${target.label}` });
  await raise.click();
  await until(request, (s) => positionOf(s, target.id)?.height === 55);
  await raise.click();
  await until(request, (s) => positionOf(s, target.id)?.height === 60);

  await page.reload();
  await page.locator('.offline-veil').waitFor({ state: 'detached' });
  const lamp = page.locator(`.plan-surface [data-fixture="${target.id}"]`);
  await expect(lamp.locator('.plan-height')).toHaveText('↑60');
  await lamp.click();
  await expect(page.getByRole('slider', { name: `Height of ${target.label}` })).toHaveValue('60');
  await page.locator('.inspector').getByRole('button', { name: 'Reset place' }).click();
  await until(request, (s) => positionOf(s, target.id) === null);
});
