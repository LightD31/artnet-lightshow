// The bugs of audit A7.26, pinned where a browser is needed to see them.

import { test, expect } from '@playwright/test';
import { open, reset, until, state } from './helpers.js';

test.beforeEach(async ({ request }) => { await reset(request); });

test('Space taps the tempo after clicking a button, instead of pressing it again', async ({ page, request }) => {
  await open(page, 'manual');
  await page.locator('.cb-blackout').click();
  await until(request, (s) => s.masterBlackout === true);
  // Clicked again, so focus is left on the button, as a click leaves it.
  await page.locator('.cb-blackout').click();
  await until(request, (s) => s.masterBlackout === false);
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press('Space');
    await page.waitForTimeout(400);
  }
  const s = await state(request);
  expect(s.masterBlackout, 'the button was not pressed again').toBe(false);
  // Taps 400 ms apart, plus the time the key presses take: about 150 BPM,
  // and nowhere near the 120 it was.
  expect(s.bpm).toBeGreaterThan(130);
  expect(s.bpm).toBeLessThan(156);
});

test('a tempo can be typed, to a tenth', async ({ page, request }) => {
  await open(page, 'manual');
  await page.getByRole('button', { name: /Press to type a tempo/ }).click();
  const field = page.getByRole('spinbutton', { name: 'Tempo, BPM' });
  await field.fill('128.5');
  await field.press('Enter');
  await until(request, (s) => s.bpm === 128.5);
  await page.getByRole('button', { name: /Press to type a tempo/ }).click();
  await page.getByRole('spinbutton', { name: 'Tempo, BPM' }).fill('999');
  await page.keyboard.press('Escape');
  expect((await state(request)).bpm).toBe(128.5);
});

test('the division row goes to 1/16', async ({ page, request }) => {
  await open(page, 'manual');
  await page.getByRole('button', { name: '1/16', exact: true }).click();
  await until(request, (s) => s.beatDivision === 16);
});

test('the view is where the operator left it after a reload', async ({ page }) => {
  await open(page, 'auto');
  await page.getByRole('tab', { name: /Perform/ }).click();
  await page.goto('/');
  await expect(page.getByRole('tab', { name: /Perform/ })).toHaveAttribute('aria-selected', 'true');
});
