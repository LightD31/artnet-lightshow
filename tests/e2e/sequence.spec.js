// The Sequence view: a clip added in the editor plays and the lane cursor
// moves; a pattern inserts at the playhead in one tap; a pad hit during a
// take becomes a clip.

import { test, expect } from '@playwright/test';
import { open, reset } from './helpers.js';

const BASE = {
  id: 'e2e-seq', name: 'E2E', mode: 'arrangement', snap: 1,
  lanes: [{ id: 'base', kind: 'shared', name: 'Base', mute: false, solo: false }],
  clips: [], commands: [],
};

test.beforeEach(async ({ request }) => {
  await reset(request);
  await request.post('/api/sequence/stop', { data: {} });
  expect((await request.put('/api/sequence', { data: BASE })).ok()).toBe(true);
});

const cursorLeft = (page) => page.locator('.seq-cursor').first().evaluate((el) => parseFloat(el.style.left));

test('a clip added in the editor plays, and the lane cursor moves', async ({ page }) => {
  await open(page, 'sequence');
  await expect(page.locator('.seq-now')).toContainText('E2E');
  await page.getByRole('button', { name: 'Edit' }).click();
  await page.getByRole('button', { name: 'Add clip' }).click();
  await expect(page.locator('.seq-block')).toHaveCount(1);
  await page.getByRole('button', { name: 'Play' }).click();
  await expect(page.locator('.seq-now')).toContainText('Playing');
  const before = await cursorLeft(page);
  await expect.poll(() => cursorLeft(page), { timeout: 4000 }).toBeGreaterThan(before);
});

test('a pattern from the library inserts in one tap', async ({ page, request }) => {
  // A pattern clip, like a sequence clip, plays exactly one preset (a strobe plays as a voice instead).
  const library = await (await request.get('/api/effects')).json();
  const preset = library.builtin.find((p) => !/strobe/i.test(`${p.id} ${p.kind || ''} ${(p.spec && p.spec.kind) || ''}`));
  const made = await request.post('/api/sequence/patterns', { data: {
    name: 'Four on the floor', lengthBeats: 4,
    lanes: [{ kind: 'shared', slot: 0, clips: [{ startBeat: 0, lengthBeats: 4, loopBeats: 4, presetId: preset.id, targets: 'lane', mute: false }] }],
  } });
  expect(made.ok()).toBe(true);
  await open(page, 'sequence');
  await expect(page.locator('.seq-block')).toHaveCount(0);
  await page.getByRole('button', { name: /^Insert Four on the floor at beat/ }).click();
  await expect(page.locator('.seq-block')).toHaveCount(1);
});

test('a pad hit while recording is kept as a clip', async ({ page, request }) => {
  await open(page, 'sequence');
  await page.getByLabel('Count-in beats').selectOption('0');
  await page.getByRole('button', { name: 'Play' }).click();
  await page.getByRole('button', { name: 'Record' }).click();
  await expect(page.getByRole('button', { name: 'Keep take' })).toBeVisible();
  await request.post('/api/pads/0/0/once', { data: {} });
  await page.waitForTimeout(600);
  await page.getByRole('button', { name: 'Keep take' }).click();
  await expect(page.locator('.seq-block')).not.toHaveCount(0);
});
