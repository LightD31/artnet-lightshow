// Panels as a layer of their own: on a rig with a panel — a WLED matrix, its
// cells in rows — the auto show hands the panels a picture that stands up on
// a screen (the band's levels, fire, rain) by what the music is doing, while
// the pars and the bars keep what they were given.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

import AutoShow from '../../src/auto-show.ts';
import { COLOR_PRESETS, PATTERNS } from '../../src/server/presets.ts';
import { buildRig } from '../../src/shared/rig.ts';
import { renderLayer } from '../../src/shared/layer.ts';
import { renderIntents } from '../../src/show/render.ts';
import { state } from '../../src/server/state.ts';
import { applyPatch } from '../../src/server/patch.ts';
import { captureLook, recallLook } from '../../src/server/cues.ts';

const TRACKS = path.join(import.meta.dirname, '..', 'fixtures', 'tracks');
const files = fs.readdirSync(TRACKS).sort();
const PANEL_LOOKS = new Set(['bars', 'fire', 'rain']);

function plan(file, { pixels = true, panels = true } = {}) {
  const doc = JSON.parse(fs.readFileSync(path.join(TRACKS, file), 'utf8'));
  const show = new AutoShow(() => {}, COLOR_PRESETS, PATTERNS);
  show._worker.shutdown();
  show.analysis = doc.analysis || doc;
  show.intensity = 60;
  show.setRig({ hasPixels: pixels, hasPanels: panels });
  show.buildTimeline();
  return show;
}

const scenes = (show) => show.intents.filter((i) => i.kind === 'SCENE' && i.pattern);
const strip = (s) => ({ ...s, panelPattern: undefined });

// ── The auto show ───────────────────────────────────────────────────────────

test('on a rig with panels every scene says what the panels draw, by section', () => {
  const seen = new Map();
  for (const file of files) {
    for (const s of scenes(plan(file))) {
      assert.ok('panelPattern' in s, `${file} ${s.source} at ${s.timeMs}`);
      if (s.source === 'drop:anchor') {
        assert.strictEqual(s.panelPattern, null, `${file}: a drop's anchor is still the whole rig at once`);
        continue;
      }
      assert.ok(PANEL_LOOKS.has(s.panelPattern), `${file} ${s.source}: ${s.panelPattern}`);
      if (!String(s.source).startsWith('section:')) continue;
      const role = s.source.slice('section:'.length);
      if (!seen.has(role)) seen.set(role, new Set());
      seen.get(role).add(s.panelPattern);
    }
  }
  assert.deepStrictEqual([...seen.get('chorus')], ['fire'], 'a chorus burns');
  assert.deepStrictEqual([...seen.get('verse')], ['bars'], 'a verse is the band\'s levels');
  for (const role of ['intro', 'outro', 'breakdown']) {
    for (const look of seen.get(role) || []) assert.strictEqual(look, 'rain', role);
  }
});

test('the pars and the bars keep the looks they had without panels', () => {
  for (const file of files) {
    const withPanels = scenes(plan(file)).map(strip);
    const without = scenes(plan(file, { panels: false })).map(strip);
    assert.deepStrictEqual(withPanels, without, file);
  }
});

test('a rig without panels plans nothing for them', () => {
  for (const file of files) {
    for (const pixels of [true, false]) {
      const show = plan(file, { pixels, panels: false });
      for (const s of scenes(show)) assert.ok(!('panelPattern' in s), `${file} ${s.source}`);
      for (const ev of show.timeline) assert.ok(!ev.data || !('panelPattern' in ev.data), `${file}: ${JSON.stringify(ev.data)}`);
    }
  }
});

test('the timeline carries the panels\' picture, and gaining panels replans', () => {
  const file = files[0];
  const show = plan(file, { panels: false });
  const before = show.timelineRevision;
  show.setRig({ hasPixels: true, hasPanels: true });
  assert.ok(show.timelineRevision !== before, 'replanned for the panels');
  const patches = show.timeline.filter((ev) => ev.action === 'patch' && ev.data && 'panelPattern' in ev.data);
  assert.ok(patches.length > 0 && patches.some((ev) => ev.data.panelPattern === 'fire'));
  assert.ok(show.getTimelineData().timeline.some((ev) => ev.panelPattern === 'fire'), 'and the timeline view shows it');
  assert.deepStrictEqual(renderIntents([{ kind: 'SCENE', timeMs: 0, pattern: 'solid', panelPattern: 'rain', priority: 0 }])
    .map((ev) => ev.data.panelPattern), ['rain']);
});

// ── The layer ───────────────────────────────────────────────────────────────

const PROFILES = {
  par: null,
  strip16: { cells: Array.from({ length: 16 }, () => ({ channelMap: { red: 0, green: 1, blue: 2 } })) },
  panel8x4: { cells: Array.from({ length: 32 }, () => ({ channelMap: { red: 0, green: 1, blue: 2 } })), grid: { columns: 8, rows: 4 } },
};
const profileOf = (f) => PROFILES[f.profileId];
const RED = { r: 255, g: 0, b: 0, w: 0 };
const BLUE = { r: 0, g: 0, b: 255, w: 0 };
const WHITE = { r: 255, g: 255, b: 255, w: 255 };

function paint(rig, look, beatPos = 3.4) {
  const out = rig.units.map(() => null);
  renderLayer(rig, { colors: [RED, BLUE, RED, WHITE], ...look }, {
    beatPos, step: Math.floor(beatPos), anchor: 0, division: 1, phase: 0,
    expression: { level: 1, bass: 0.7, vocal: 0.5, air: 0.3, width: 0.5, motion: 0.4, decay: 0.25 },
    dynamicsOn: true, fixtureCount: rig.fixtures.length, twinkle: rig.units.map(() => 0),
    pixelTwinkle: rig.units.map(() => 0), panelTwinkle: rig.units.map(() => 0),
  }, (u, colour, dim) => { out[u] = { colour, dim }; });
  return out;
}

const RIG = [
  { profileId: 'par', position: { x: 10, y: 50 } },
  { profileId: 'strip16', position: { x: 30, y: 50 } },
  { profileId: 'panel8x4', position: { x: 50, y: 40 } },
  { profileId: 'strip16', position: { x: 70, y: 50 } },
  { profileId: 'par', position: { x: 90, y: 50 } },
];

test('the rig knows its panels, and lays them out apart', () => {
  const rig = buildRig(RIG, profileOf);
  assert.ok(rig.hasPanels && rig.hasPixels && rig.hasPars);
  const fixturesOf = (only) => [...new Set(rig.layout(null, 'stage', only).units.list.map((u) => rig.units[u].fixture))].sort();
  assert.deepStrictEqual(fixturesOf('panels'), [2]);
  assert.deepStrictEqual(fixturesOf('strips'), [1, 3]);
  assert.deepStrictEqual(fixturesOf('unpanelled'), [0, 1, 3, 4]);
  assert.deepStrictEqual(fixturesOf('cells'), [1, 2, 3]);
  assert.ok(!buildRig(RIG.filter((f) => f.profileId !== 'panel8x4'), profileOf).hasPanels);
});

test('the panels draw their own picture; the pars and the strips are untouched', () => {
  const rig = buildRig(RIG, profileOf);
  const of = (out, part) => out.filter((_, u) => part(rig.units[u].fixture));
  const pars = (i) => i === 0 || i === 4;
  const strips = (i) => i === 1 || i === 3;
  const panel = (i) => i === 2;

  // Per bar, each fixture draws the picture on its own, so the panel's fire
  // is the same whichever layer draws it.
  const fireOnPanel = paint(rig, { pattern: 'solid', pixelPattern: 'comet', pixelMap: 'bar', panelPattern: 'fire' });
  const fireOnCells = paint(rig, { pattern: 'solid', pixelPattern: 'fire', pixelMap: 'bar' });
  assert.deepStrictEqual(of(fireOnPanel, panel), of(fireOnCells, panel), 'the panel burns');
  const comet = paint(rig, { pattern: 'solid', pixelPattern: 'comet', pixelMap: 'bar' });
  assert.notDeepStrictEqual(of(comet, panel), of(fireOnPanel, panel), 'and not with the comet');
  assert.deepStrictEqual(of(fireOnPanel, pars), of(comet, pars), 'the pars hold their wash');
  for (const p of of(fireOnPanel, pars)) assert.deepStrictEqual([p.colour, p.dim], [RED, 255]);
  assert.ok(of(fireOnPanel, strips).every(Boolean), 'the strips are drawn');

  // With no picture for the bars, the rest of the rig runs the pattern.
  const chase = paint(rig, { pattern: 'chase', panelPattern: 'rain' });
  assert.ok(of(chase, panel).some((c) => c.dim > 0), 'rain on the panel');
  assert.ok(of(chase, (i) => !panel(i)).every(Boolean), 'the chase on everything else');
});

test('a picture for panels changes nothing on a rig without them, and nothing with none asked', () => {
  const noPanels = buildRig(RIG.filter((f) => f.profileId !== 'panel8x4'), profileOf);
  const look = { pattern: 'solid', pixelPattern: 'comet' };
  assert.deepStrictEqual(paint(noPanels, { ...look, panelPattern: 'fire' }), paint(noPanels, look));
  const rig = buildRig(RIG, profileOf);
  assert.deepStrictEqual(paint(rig, { ...look, panelPattern: null }), paint(rig, look));
});

// ── By hand ─────────────────────────────────────────────────────────────────

test('picked by hand: the panels keep their picture until a pattern is picked', () => {
  const before = { pattern: state.pattern, pixelPattern: state.pixelPattern, panelPattern: state.panelPattern };
  try {
    applyPatch({ pattern: 'solid' });
    applyPatch({ panelPattern: 'fire' });
    assert.strictEqual(state.panelPattern, 'fire');
    applyPatch({ pixelPattern: 'comet' });
    assert.strictEqual(state.panelPattern, 'fire', 'a picture for the bars leaves the panels\'');
    assert.deepStrictEqual(captureLook().panelPattern, 'fire', 'a cue keeps it');
    applyPatch({ pattern: 'chase' });
    assert.strictEqual(state.panelPattern, null, 'a pattern picked by hand runs on the whole rig');
    assert.throws(() => applyPatch({ panelPattern: '' }));

    const look = captureLook();
    recallLook({ ...look, panelPattern: 'rain' });
    assert.strictEqual(state.panelPattern, 'rain');
    const { panelPattern: _unused, ...older } = look;
    recallLook(older);
    assert.strictEqual(state.panelPattern, null, 'a cue from before panels recalls with them drawing the bars\'');
  } finally {
    Object.assign(state, before);
  }
});
