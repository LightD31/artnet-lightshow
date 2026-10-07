// The bugs of audit A7.26, pinned where a browser is needed to see them.

import { test, expect } from '@playwright/test';
import { open, reset, until, state } from './helpers.js';

test.beforeEach(async ({ request }) => { await reset(request); });

test('Space taps tempo without retriggering a clicked button', async ({ page, request }) => {
  const taps = [];
  page.on('websocket', (socket) => socket.on('framesent', ({ payload }) => {
    if (typeof payload !== 'string' || !payload.startsWith('42')) return;
    const [event] = JSON.parse(payload.slice(2));
    if (event === 'tap') taps.push(event);
  }));
  await open(page, 'effects');
  await page.locator('.cb-blackout').click();
  await until(request, (s) => s.masterBlackout === true);
  // Clicked again, so focus is left on the button, as a click leaves it.
  await page.locator('.cb-blackout').click();
  await until(request, (s) => s.masterBlackout === false);
  for (let i = 0; i < 4; i++) await page.keyboard.press('Space');
  await expect.poll(() => taps.length).toBe(4);
  expect((await state(request)).masterBlackout).toBe(false);
});

test('a tempo can be typed, to a tenth', async ({ page, request }) => {
  await open(page, 'effects');
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
  await open(page, 'effects');
  await page.getByRole('button', { name: '1/16', exact: true }).click();
  await until(request, (s) => s.beatDivision === 16);
});

test('the view is where the operator left it after a reload', async ({ page }) => {
  await open(page, 'auto');
  await page.getByRole('tab', { name: /Perform/ }).click();
  await page.goto('/');
  await expect(page.getByRole('tab', { name: /Perform/ })).toHaveAttribute('aria-selected', 'true');
});
