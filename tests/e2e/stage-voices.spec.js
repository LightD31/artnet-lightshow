// The live voices on the stage: a held pad and the latched strobe are named on
// the stage preview's "Now playing" line and drawn by the 3D Stage view over
// the look. Puts back the pad, the strobe, the acknowledgement and the look.

import { test, expect } from '@playwright/test';
import { open, reset, set, state, until } from './helpers.js';

const BANK = 0;
const SLOT = 1;

/** The 3D stage's mean colour in one drawn frame, 0–255 per channel, and its luminance. */
function stageSample(page) {
  return page.evaluate(() => new Promise((resolve) => window.requestAnimationFrame(() => {
    const stage = window.document.querySelector('.stage3d-canvas');
    const copy = window.document.createElement('canvas');
    copy.width = stage.width;
    copy.height = stage.height;
    const ctx = copy.getContext('2d');
    ctx.drawImage(stage, 0, 0);
    const px = ctx.getImageData(0, 0, copy.width, copy.height).data;
    let r = 0; let g = 0; let b = 0;
    for (let i = 0; i < px.length; i += 4) { r += px[i]; g += px[i + 1]; b += px[i + 2]; }
    const n = px.length / 4;
    resolve({ r: r / n, g: g / n, b: b / n, lum: (0.2126 * r + 0.7152 * g + 0.0722 * b) / n });
  })));
}

async function samples(page, count) {
  const out = [];
  for (let k = 0; k < count; k++) out.push(await stageSample(page));
  return out;
}

const distance = (a, b) => Math.max(Math.abs(a.r - b.r), Math.abs(a.g - b.g), Math.abs(a.b - b.b));

test('voices appear over the stage look and disappear when stopped', async ({ page, context, request }) => {
  await reset(request);
  // A still look and no sequence playing, so anything that moves on the stage is a voice.
  await request.post('/api/sequence/stop', { data: {} });
  await set(request, { pattern: 'solid' });
  // A preset that plays before the acknowledgement: the catalogue marks the ones that do not.
  const start = await state(request);
  const preset = (start.patterns || []).find((p) => 'rapidFlash' in p && !p.rapidFlash && !/strobe/i.test(`${p.id} ${p.family || ''}`));
  expect(preset, 'a non-strobe preset that needs no acknowledgement').toBeTruthy();
  const { layout } = await (await request.get('/api/pads')).json();
  const { bank: _b, slot: _s, ...original } = layout.find((p) => p.bank === BANK && p.slot === SLOT);
  const acknowledged = start.safety.photosensitivityAcknowledged;
  const put = await request.put(`/api/pads/${BANK}/${SLOT}`, { data: { ...original, content: { kind: 'preset', id: preset.id } } });
  expect(put.ok(), await put.text()).toBe(true);

  const preview = await context.newPage();
  try {
    await open(page, 'stage');
    await expect(page.getByRole('img', { name: /The rig in 3D/ })).toHaveAttribute('aria-label', /showing the live output/);
    await open(preview, 'effects');
    const now = preview.locator('.stage-now');
    await expect(now).toContainText(start.patterns.find((row) => row.id === start.pattern).name);
    await expect(preview.locator('.playing-voice')).toHaveCount(0);
    const baseline = await now.textContent();
    const look = await samples(page, 6);
    const lookLum = Math.max(...look.map((s) => s.lum));

    // Held: named, and the stage no longer looks like the look alone.
    const press = await (await request.post(`/api/pads/${BANK}/${SLOT}/press`, { data: {} })).json();
    expect(press.id, JSON.stringify(press)).toBeTruthy();
    const held = await until(request, (s) => s.voices.some((v) => v.id === press.id));
    const label = held.voices.find((v) => v.id === press.id).label;
    await expect(now).toContainText(label);
    const fromLook = (s) => Math.min(...look.map((l) => distance(l, s)));
    await expect.poll(async () => fromLook(await stageSample(page)),
      { message: 'the held pad changes the stage picture', timeout: 5000 }).toBeGreaterThan(4);

    // Released: back to the look.
    await request.post(`/api/pads/${BANK}/${SLOT}/release`, { data: { token: press.token } });
    await until(request, (s) => !s.voices.some((v) => v.id === press.id));
    await expect(now).toHaveText(baseline);
    await expect.poll(async () => fromLook(await stageSample(page)),
      { message: 'the stage goes back to the look', timeout: 5000 }).toBeLessThan(2);

    // The strobe: named, and some frame brighter than the look.
    expect((await request.post('/api/safety/acknowledge', { data: {} })).ok()).toBe(true);
    expect((await request.post('/api/strobe/on', { data: {} })).ok()).toBe(true);
    await until(request, (s) => !!s.strobe?.active);
    await expect(preview.locator('.playing-voice[data-voice="strobe"]')).toBeVisible();
    await expect.poll(async () => Math.max(...(await samples(page, 10)).map((s) => s.lum)),
      { message: 'the strobe flashes the stage', timeout: 8000 }).toBeGreaterThan(lookLum + 4);
    await request.post('/api/strobe/off', { data: {} });
    await until(request, (s) => !s.strobe?.active);
    await expect(now).toHaveText(baseline);
  } finally {
    await preview.close();
    await request.post('/api/strobe/off', { data: {} });
    await request.post(`/api/pads/${BANK}/${SLOT}/release`, { data: {} });
    await request.put(`/api/pads/${BANK}/${SLOT}`, { data: original });
    await request.put('/api/settings', { data: { safety: { photosensitivityAcknowledged: acknowledged } } });
    await reset(request);
  }
});
