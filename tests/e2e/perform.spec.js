// The Perform view, on a desktop and on a touch tablet: pads that hold,
// latch, and let go; blackout; palettes; the faders.

import { test, expect } from '@playwright/test';
import { open, reset, until } from './helpers.js';

test.beforeEach(async ({ request, page }) => {
  await reset(request);
  await page.addInitScript(() => { try { localStorage.removeItem('lightshow.perform.latch'); } catch { /* */ } });
});

async function hold(page, locator) {
  const box = await locator.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
}

test('a pad runs its effect while held, and stops when let go', async ({ page, request }) => {
  await open(page, 'perform');
  const blinder = page.locator('.pad-blinder');
  await blinder.scrollIntoViewIfNeeded();
  await hold(page, blinder);
  await until(request, (s) => s.energyOverride === 'blinder');
  await expect(blinder).toHaveAttribute('aria-pressed', 'true');
  await page.mouse.up();
  await until(request, (s) => s.energyOverride === null);
});

test('latched, a tap starts an effect and the next tap stops it', async ({ page, request }) => {
  await open(page, 'perform');
  await page.getByLabel('Latch effects').check();
  const uv = page.locator('.pad-uv-wash');
  await uv.scrollIntoViewIfNeeded();
  await uv.click();
  await until(request, (s) => s.energyOverride === 'uv-wash');
  await page.waitForTimeout(700);
  await until(request, (s) => s.energyOverride === 'uv-wash', { timeout: 500 });
  await uv.click();
  await until(request, (s) => s.energyOverride === null);
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
