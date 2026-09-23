'use strict';

// The auto show on a rig with LED bars: it reaches for the pictures drawn
// across cells, and says how each scene lays them over the bars. On a rig of
// pars it plans exactly as before (pars-golden.test.js pins that byte for
// byte); these pin what changes when there are bars.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const AutoShow = require('../../src/auto-show');
const { COLOR_PRESETS, PATTERNS } = require('../../src/server/presets');
const { patchSchema } = require('../../src/server/validation');
const { PIXEL_MAPS } = require('../../src/shared/rig');

const PIXEL_IDS = new Set(PATTERNS.filter((p) => p.pixel).map((p) => p.id));
const RESTING = new Set(['ribbon', 'fade', 'wave', 'solid', 'gradient', 'plasma']);
const TRACKS = path.join(__dirname, '..', 'fixtures', 'tracks');

function plan(file, { pixels, intensity = 60 }) {
  const doc = JSON.parse(fs.readFileSync(path.join(TRACKS, file), 'utf8'));
  const show = new AutoShow(() => {}, COLOR_PRESETS, PATTERNS);
  show._worker.shutdown();
  show.analysis = doc.analysis || doc;
  show.intensity = intensity;
  show.setRig({ hasPixels: pixels });
  show.buildTimeline();
  return show;
}

const scenes = (show) => show.intents.filter((i) => i.kind === 'SCENE' && i.pattern);
const files = fs.readdirSync(TRACKS).sort();

test('with bars on the rig, the show draws across them', () => {
  const used = new Set();
  for (const file of files) {
    for (const intensity of [30, 60, 90]) {
      for (const s of scenes(plan(file, { pixels: true, intensity }))) if (PIXEL_IDS.has(s.pattern)) used.add(s.pattern);
    }
  }
  assert.ok(used.size >= 3, `pixel effects the show reached for: ${[...used]}`);
  assert.ok(!used.has('meter'), 'the meter stays a manual effect until the level it reads is faster');
});

test('every scene on a rig with bars says how its picture lies over them', () => {
  for (const file of files) {
    const show = plan(file, { pixels: true });
    for (const s of scenes(show)) {
      assert.ok(PIXEL_MAPS.includes(s.pixelMap), `${file} ${s.source} at ${s.timeMs}: ${s.pixelMap}`);
      if (RESTING.has(s.pattern)) assert.strictEqual(s.pixelMap, 'stage', `${file}: a resting look spreads across the stage`);
    }
    for (const ev of show.timeline.filter((e) => e.action === 'patch')) {
      const parsed = patchSchema.safeParse(ev.data);
      assert.ok(parsed.success, `${file}: ${JSON.stringify(ev.data)} → ${parsed.error && parsed.error.message}`);
    }
    assert.ok(new Set(scenes(show).map((s) => s.pixelMap)).size >= 2, `${file}: more than one way of laying it out`);
  }
});

test('the passages that rest still rest, bars or not', () => {
  for (const file of files) {
    for (const s of scenes(plan(file, { pixels: true }))) {
      if (/^section:(intro|breakdown|outro)$/.test(s.source)) {
        assert.ok(RESTING.has(s.pattern), `${file}: ${s.source} on ${s.pattern}`);
      }
      if (s.split != null) assert.ok(!['gradient', 'plasma', 'meter'].includes(s.pattern), `${file}: split ${s.pattern}`);
    }
  }
});

test('a rig of pars never hears about cells', () => {
  for (const file of files) {
    for (const s of scenes(plan(file, { pixels: false }))) {
      assert.strictEqual(s.pixelMap, undefined);
      assert.ok(!PIXEL_IDS.has(s.pattern), `${file}: ${s.pattern}`);
    }
  }
});

test('gaining or losing bars replans the track; the same rig does not', () => {
  const show = plan(files[0], { pixels: false });
  const before = show.timelineRevision;
  show.setRig({ hasPixels: false });
  assert.strictEqual(show.timelineRevision, before, 'nothing changed');
  show.setRig({ hasPixels: true });
  assert.notStrictEqual(show.timelineRevision, before, 'bars arrived');
  assert.strictEqual(show.getClientState().pixels, true);
  const withBars = show.timelineRevision;
  show.setRig({ hasPixels: false });
  assert.notStrictEqual(show.timelineRevision, withBars, 'and left');
});
