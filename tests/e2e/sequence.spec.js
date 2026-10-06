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

// What the tests change, put back after each so later specs start the same.
let before = null;

test.beforeEach(async ({ request }) => {
  const { settings } = await (await request.get('/api/settings')).json();
  const { layout } = await (await request.get('/api/pads')).json();
  const { patterns } = await (await request.get('/api/sequence/patterns')).json();
  before = {
    acknowledged: !!settings.safety.photosensitivityAcknowledged,
    pad: layout.find((p) => p.bank === 0 && p.slot === 0),
    patterns: new Set(patterns.map((p) => p.id)),
  };
  await reset(request);
  await request.post('/api/sequence/stop', { data: {} });
  expect((await request.put('/api/sequence', { data: BASE })).ok()).toBe(true);
});

test.afterEach(async ({ request }) => {
  // Unloaded, not only stopped: a stopped sequence holds its picture over the look.
  expect((await request.delete('/api/sequence')).ok()).toBe(true);
  const { bank: _b, slot: _s, ...pad } = before.pad;
  const put = await request.put('/api/pads/0/0', { data: pad });
  expect(put.ok(), await put.text()).toBe(true);
  // The pad first: a strobe pad may need the acknowledgement it is restored under.
  const ack = await request.put('/api/settings', { data: { safety: { photosensitivityAcknowledged: before.acknowledged } } });
  expect(ack.ok(), await ack.text()).toBe(true);
  const { patterns } = await (await request.get('/api/sequence/patterns')).json();
  for (const p of patterns.filter((x) => !before.patterns.has(x.id))) {
    expect((await request.delete(`/api/sequence/patterns/${encodeURIComponent(p.id)}`)).ok()).toBe(true);
  }
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
  // Pad 0/0 is the white strobe by default, and a strobe never becomes a clip: give it a
  // preset a clip can play. The hit is refused (409) before the acknowledgement, so give that too.
  expect((await request.post('/api/safety/acknowledge', { data: {} })).ok()).toBe(true);
  const library = await (await request.get('/api/effects')).json();
  const preset = library.builtin.find((p) => !p.legacy && !p.rapidFlash && !/strobe/i.test(`${p.id} ${p.kind || ''} ${(p.spec && p.spec.kind) || ''}`));
  const { layout } = await (await request.get('/api/pads')).json();
  const { bank: _b, slot: _s, ...pad } = layout.find((p) => p.bank === 0 && p.slot === 0);
  const put = await request.put('/api/pads/0/0', { data: { ...pad, content: { kind: 'preset', id: preset.id }, launch: 'once' } });
  expect(put.ok(), await put.text()).toBe(true);
  await open(page, 'sequence');
  await page.getByLabel('Count-in beats').selectOption('0');
  await page.getByRole('button', { name: 'Play' }).click();
  await page.getByRole('button', { name: 'Record' }).click();
  await expect(page.getByRole('button', { name: 'Keep take' })).toBeVisible();
  const hit = await request.post('/api/pads/0/0/once', { data: {} });
  expect(hit.ok(), await hit.text()).toBe(true);
  await page.waitForTimeout(600);
  await page.getByRole('button', { name: 'Keep take' }).click();
  await expect(page.locator('.seq-block')).not.toHaveCount(0);
  // The transport and the pad back as found, for the specs after this one.
  await request.post('/api/sequence/stop', { data: {} });
  await request.put('/api/pads/0/0', { data: pad });
});
