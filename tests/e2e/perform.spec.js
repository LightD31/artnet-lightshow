// The Perform view, on a desktop and on a touch tablet: pads that hold,
// loop and let go; bank switching; blackout; palettes; the faders.

import { test, expect } from '@playwright/test';
import { open, reset, state, until } from './helpers.js';

test.beforeEach(async ({ request, page }) => {
  await reset(request);
  await page.addInitScript(() => { try { localStorage.removeItem('lightshow.perform.bank'); } catch { /* */ } });
});

async function hold(page, locator) {
  const box = await locator.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
}

/** The pad that plays `id` in the default layout, and its index in `pads.lit`. */
async function padOf(request, id) {
  const s = await state(request);
  const entry = s.pads.layout.find((p) => p.content && p.content.id === id);
  return { ...entry, index: entry.bank * 8 + entry.slot };
}
const cell = (page, { bank, slot }) => page.locator(`.pad-cell[data-bank="${bank}"][data-slot="${slot}"]`);

test('a hold pad runs while held, and lets go when the window loses focus', async ({ page, request }) => {
  await open(page, 'perform');
  const blinder = await padOf(request, 'energy.blinder');
  const button = cell(page, blinder);
  await button.scrollIntoViewIfNeeded();
  await hold(page, button);
  await until(request, (s) => !!s.pads.lit[blinder.index]);
  await expect(button).toHaveAttribute('aria-pressed', 'true');
  await page.evaluate(() => window.dispatchEvent(new window.Event('blur')));
  await until(request, (s) => !s.pads.lit[blinder.index]);
  await page.mouse.up();
});

test('the bank tabs switch the eight pads shown', async ({ page, request }) => {
  await open(page, 'perform');
  const { pads } = await state(request);
  await expect(page.locator('.pad-cell[data-bank="0"]')).toHaveCount(8);
  await page.getByRole('tab', { name: 'B' }).click();
  await expect(page.locator('.pad-cell[data-bank="1"]')).toHaveCount(8);
  await expect(page.locator('.pad-cell[data-bank="0"]')).toHaveCount(0);
  const first = pads.layout.find((p) => p.bank === 1 && p.slot === 0);
  await expect(cell(page, first).locator('.pad-label')).toHaveText(first.label);
});

test('a loop pad starts on a tap and stops on the next', async ({ page, request }) => {
  await open(page, 'perform');
  const loop = (await state(request)).pads.layout.find((p) => p.launch === 'loop' && p.content);
  const index = loop.bank * 8 + loop.slot;
  if (loop.bank === 1) await page.getByRole('tab', { name: 'B' }).click();
  const button = cell(page, loop);
  await button.scrollIntoViewIfNeeded();
  await button.click();
  await until(request, (s) => !!s.pads.lit[index]);
  await page.waitForTimeout(700);
  await until(request, (s) => !!s.pads.lit[index], { timeout: 500 });
  await button.click();
  await until(request, (s) => !s.pads.lit[index]);
});

test('blackout, palettes and the master', async ({ page, request }) => {
  await open(page, 'perform');
  await page.getByRole('button', { name: /^Blackout/ }).click();
  await until(request, (s) => s.masterBlackout === true);
  await page.getByRole('button', { name: /^Blackout/ }).click();
  await until(request, (s) => s.masterBlackout === false);

  const palette = page.locator('.perform-palette').nth(2);
  await palette.scrollIntoViewIfNeeded();
  await palette.click();
  await expect(palette).toHaveAttribute('aria-pressed', 'true');
  const chosen = await until(request, (s) => !!s.palette);

  const master = page.locator('.perform-fader input').first();
  await master.scrollIntoViewIfNeeded();
  await master.focus();
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowDown');
  await until(request, (s) => s.masterDimmer === 250);
  expect(chosen.palette).toBeTruthy();
});

test('every target on the view is at least 44 px on a touch screen', async ({ page }, info) => {
  test.skip(info.project.name !== 'tablet', 'touch sizing');
  await open(page, 'perform');
  // A checkbox is as big as the label that carries it: that is what is tapped.
  const small = await page.evaluate(() => [...document.querySelectorAll('button, select, input:not([type=range]):not([type=checkbox]), label:has(input[type=checkbox]), a[href]')]
    .filter((el) => el.getClientRects().length && !el.classList.contains('skip-link'))
    .map((el) => ({ what: el.textContent.trim().slice(0, 20) || el.getAttribute('aria-label'), h: el.getBoundingClientRect().height }))
    .filter((x) => x.h < 44));
  expect(small).toEqual([]);
});

test('the strobe asks once before the acknowledgement, and never after it', async ({ page, request }) => {
  await request.put('/api/settings', { data: { safety: { photosensitivityAcknowledged: false } } });
  try {
    await open(page, 'perform');
    const strobe = page.locator('.strobe-pad .strobe-hold');
    await expect(strobe).toHaveAttribute('data-safety', 'ask');
    await strobe.click();
    const dialog = page.getByRole('alertdialog', { name: 'Rapid flashing' });
    await expect(dialog).toContainText('Strobe');
    await dialog.getByRole('button', { name: 'I understand — play it' }).click();
    await expect(dialog).toBeHidden();
    await until(request, (s) => s.safety.photosensitivityAcknowledged === true);
    await expect(strobe).not.toHaveAttribute('data-safety', 'ask');
    await strobe.click();
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
  } finally {
    await request.put('/api/settings', { data: { safety: { photosensitivityAcknowledged: false } } });
  }
});

test('the palette override goes on with one tap and comes off with Off', async ({ page, request }) => {
  await request.delete('/api/palette-override');
  await open(page, 'perform');
  const strip = page.getByRole('region', { name: 'Palette override' });
  await expect(strip.locator('[data-override="off"]')).toHaveAttribute('aria-pressed', 'true');
  const first = strip.locator('.override-pad:not([data-override="off"])').first();
  await first.click();
  await until(request, (s) => Array.isArray(s.paletteOverride));
  await expect(strip.locator('[data-override="off"]')).toHaveAttribute('aria-pressed', 'false');
  await strip.locator('[data-override="off"]').click();
  await until(request, (s) => s.paletteOverride === null);
  await expect(strip.locator('[data-override="off"]')).toHaveAttribute('aria-pressed', 'true');
});
