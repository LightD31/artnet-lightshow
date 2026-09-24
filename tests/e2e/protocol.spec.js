// Protocol v2 as the page sees it: a snapshot, then patches with only what
// changed, and DMX as bytes only while something on screen shows it.

import { test, expect } from '@playwright/test';
import { open, reset, set, until } from './helpers.js';

test.beforeEach(async ({ request }) => { await reset(request); });

function watch(page) {
  const seen = { patches: [], snapshot: 0, frames: 0, state: 0 };
  page.on('websocket', (ws) => ws.on('framereceived', ({ payload }) => {
    if (typeof payload !== 'string') return;
    if (payload.includes('"patch"')) {
      const at = payload.indexOf('[');
      try { seen.patches.push(JSON.parse(payload.slice(at))[1]); } catch { /* not a plain event */ }
    }
    if (payload.startsWith('42["snapshot"')) seen.snapshot++;
    if (payload.startsWith('42["state"')) seen.state++;
    if (payload.includes('"dmx-frame"')) seen.frames++;
  }));
  return seen;
}

test('a change reaches the page as that key alone', async ({ page, request }) => {
  const seen = watch(page);
  await open(page, 'manual');
  expect(seen.snapshot).toBe(1);
  expect(seen.state).toBe(0);
  await set(request, { masterDimmer: 90 });
  await expect(page.locator('.cb-master-val')).toHaveText('35%');
  const look = seen.patches.find((p) => p && p.d === 'look' && 'masterDimmer' in p.set);
  expect(look).toBeTruthy();
  expect(Object.keys(look.set)).toEqual(['masterDimmer']);
});

test('DMX flows only while a view that draws it is on screen', async ({ page }) => {
  const seen = watch(page);
  await open(page, 'perform');
  await page.waitForTimeout(600);
  expect(seen.frames, 'Perform draws no DMX').toBe(0);
  await page.getByRole('tab', { name: /Manual/ }).click();
  await expect.poll(() => seen.frames, { timeout: 3000 }).toBeGreaterThan(0);
});

test('a fader drag goes out as the latest value, and the fader does not jump back', async ({ page, request }) => {
  await open(page, 'manual');
  const fader = page.getByRole('slider', { name: 'Master dimmer' });
  await fader.focus();
  for (let i = 0; i < 20; i++) await page.keyboard.press('ArrowLeft');
  await until(request, (s) => s.masterDimmer === 235);
  await expect(fader).toHaveValue('235');
  await expect(page.locator('.cb-master-val')).toHaveText('92%');
});
