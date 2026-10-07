// The Rig view's plot: placing a lamp from its chip by tap or drag, nudging
// it, and auto-place's proposal, apply and undo.
// Each test puts the positions back the way it found them.

import { test, expect } from '@playwright/test';
import { open, reset, state, until } from './helpers.js';

const positionOf = (s, id) => s.fixtures.find((f) => f.id === id).position;

// Lamps unplaced when a test starts are unplaced again after it, even when it fails.
let unplacedAtStart = [];
test.beforeEach(async ({ request }) => {
  await reset(request);
  unplacedAtStart = (await state(request)).fixtures.filter((f) => !f.position).map((f) => f.id);
});
test.afterEach(async ({ page, request }) => {
  const now = await state(request);
  const left = unplacedAtStart.filter((id) => now.fixtures.some((f) => f.id === id && f.position));
  if (!left.length) return;
  await open(page, 'rig');
  for (const id of left) {
    await page.locator(`.plan-surface [data-fixture="${id}"]`).click();
    await resetPlace(page, request, id);
  }
});

/** Wait until the plot draws the lamp where the server has it: a nudge moves it from there. */
async function drawnAt(page, id, { x, y }) {
  const label = new RegExp(`, position ${Math.round(x)}, ${Math.round(y)}\\.`);
  await expect(page.locator(`.plan-surface [data-fixture="${id}"]`)).toHaveAttribute('aria-label', label);
}

/** The selected lamp back to unplaced with the toolbar's Reset, its chip back beside the plot. */
async function resetPlace(page, request, id) {
  await expect(page.locator(`.plan-surface [data-fixture="${id}"]`)).toHaveAttribute('aria-pressed', 'true');
  await page.locator('.plan-tools').getByRole('button', { name: 'Reset', exact: true }).click();
  await until(request, (s) => positionOf(s, id) === null);
  await expect(page.locator(`.plan-chip[data-chip="${id}"]`)).toBeVisible();
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
  await drawnAt(page, first.id, placed);
  await lamp.focus();
  await page.keyboard.press('ArrowRight');
  await until(request, (s) => positionOf(s, first.id).x === placed.x + 2.5);
  await page.keyboard.press('ArrowDown');
  await until(request, (s) => positionOf(s, first.id).y === placed.y + 2.5);
  await resetPlace(page, request, first.id);

  // Measured again: the chips beside the plot changed when the first was placed.
  const plot = await page.locator('.plan-surface').boundingBox();
  const box = await page.locator(`.plan-chip[data-chip="${second.id}"]`).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(plot.x + plot.width * 0.7, plot.y + plot.height * 0.75, { steps: 8 });
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
  // After an edit of the operator's own, there is no undo to offer.
  await page.getByRole('button', { name: `Auto-place ${unplaced.length}` }).click();
  await page.locator('.plan-proposal').getByRole('button', { name: 'Apply' }).click();
  await until(request, (s) => unplaced.every((u) => !!positionOf(s, u.id)));
  const nudged = unplaced[0].id;
  const at = positionOf(await state(request), nudged);
  await drawnAt(page, nudged, at);
  await page.locator(`.plan-surface [data-fixture="${nudged}"]`).focus();
  await page.keyboard.press('ArrowUp');
  await until(request, (s) => positionOf(s, nudged).y === at.y - 2.5);
  await expect(page.getByRole('button', { name: 'Undo auto-place' })).toHaveCount(0);
  for (const u of unplaced) {
    await page.locator(`.plan-surface [data-fixture="${u.id}"]`).click();
    await resetPlace(page, request, u.id);
  }
  await expect(page.locator('.plan-chip')).toHaveCount(unplaced.length);
});
