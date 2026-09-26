// Pars and bars as two layers: on a rig with LED bars the pars carry the
// colour and the wash, and the bars carry the movement, with a picture chosen
// by what the music is doing — the section's role, a build-up, a drop.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

import AutoShow from '../../src/auto-show.ts';
import { COLOR_PRESETS, PATTERNS } from '../../src/server/presets.ts';
import { buildRig } from '../../src/shared/rig.ts';
import { renderLayer } from '../../src/shared/layer.ts';
import { PATTERN_FUNCS, CELL_PATTERNS } from '../../src/shared/patterns.ts';
import { wledProfile, readInfo } from '../../src/server/wled.ts';
import { createPreviewSampler } from '../../src/shared/preview.ts';

const TRACKS = path.join(import.meta.dirname, '..', 'fixtures', 'tracks');
const files = fs.readdirSync(TRACKS).sort();
// Patterns that carry light across the stage lamp by lamp: on a rig with
// bars, those are the bars' job.
const TRAVELLING = new Set(['chase', 'chase-rev', 'ping-pong', 'runner', 'pairs', 'stack-up', 'random-flash', 'comet']);

function plan(file, { pixels = true, intensity = 60 } = {}) {
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

test('every scene on a rig with bars says what the bars draw', () => {
  for (const file of files) {
    for (const s of scenes(plan(file))) {
      assert.ok('pixelPattern' in s, `${file} ${s.source} at ${s.timeMs}`);
      if (s.pixelPattern) assert.ok(PATTERN_FUNCS[s.pixelPattern], `${file}: ${s.pixelPattern} is a picture the rig can draw`);
    }
  }
});

test('the bars draw what the section is doing', () => {
  const seen = new Map();
  for (const file of files) {
    for (const s of scenes(plan(file))) {
      if (!String(s.source).startsWith('section:')) continue;
      const role = s.source.slice('section:'.length);
      if (!seen.has(role)) seen.set(role, new Set());
      seen.get(role).add(`${s.pixelPattern}/${s.pixelMap}`);
    }
  }
  assert.deepStrictEqual([...seen.get('verse')], ['gradient/stage'], 'a verse is a slow gradient');
  // Or, driving as hard as a drop, one of the strobe programs, laid as it is.
  for (const look of seen.get('chorus')) {
    assert.ok(/^(comet\/mirror|flash-chase\/mirror|(flash-alternate|ramp|core)\/bar)$/.test(look), `a chorus is a mirrored chase: ${look}`);
  }
  assert.ok(seen.get('chorus').has('comet/mirror'), 'a chorus that is not driving that hard still chases');
  assert.deepStrictEqual([...seen.get('drop')], ['impact/stage'], 'a drop is a burst from the centre, sparking on the kick');
  for (const role of ['intro', 'outro']) {
    for (const look of seen.get(role) || []) assert.ok(/^(gradient|plasma)\/stage$/.test(look), `${role}: ${look}`);
  }
});

test('the drops and the hardest-driving passages play the bars as strobes, each laid as it runs', () => {
  const MAPS = { impact: 'stage', 'flash-scatter': 'stage', 'flash-chase': 'mirror',
    'flash-fill': 'bar', 'flash-alternate': 'bar', ramp: 'bar', core: 'bar' };
  const dropPrograms = new Set();
  let strobed = 0;
  for (const file of files) {
    const byDrop = new Map();
    for (const s of scenes(plan(file))) {
      if (!(s.pixelPattern in MAPS)) continue;
      strobed++;
      assert.strictEqual(s.pixelMap, MAPS[s.pixelPattern], `${file} ${s.source}: ${s.pixelPattern}`);
      const source = String(s.source);
      if (source.startsWith('drop:')) {
        dropPrograms.add(s.pixelPattern);
        // Every scene of one drop plays the same program.
        const t = Math.round(s.timeMs / 4000);
        if (byDrop.has(t)) assert.strictEqual(byDrop.get(t), s.pixelPattern, `${file}: one drop, one program`);
        byDrop.set(t, s.pixelPattern);
      }
    }
  }
  assert.ok(strobed > 0);
  assert.ok(dropPrograms.size >= 2, `the drops turn through their programs: ${[...dropPrograms]}`);
});

test('a build-up is one fill across its scenes, and full as the drop lands', () => {
  let builds = 0;
  for (const file of files) {
    const show = plan(file);
    const build = scenes(show).filter((s) => String(s.source).startsWith('buildup:'));
    for (const s of build) {
      assert.strictEqual(s.pixelPattern, 'rise', `${file} ${s.source}`);
      assert.ok(s.pixelSpan >= 1, `${file} ${s.source}: a span in beats`);
    }
    // Each build starts its fill from empty, and every scene after that in
    // the same build starts where the fill has got to.
    for (let i = 1; i < build.length; i++) {
      if (!build[i].pixelFrom) continue;
      assert.strictEqual(build[i].pixelSpan, build[i - 1].pixelSpan, `${file}: one build, one span`);
      assert.ok(build[i].pixelFrom > (build[i - 1].pixelFrom || 0), `${file}: the fill carries on`);
    }
    assert.ok(build.every((s) => s.source !== 'buildup:tension' || !s.pixelFrom), `${file}: a build's fill starts empty`);
    builds += build.length ? 1 : 0;
  }
  assert.ok(builds >= 2, 'the fixture tracks have build-ups to check');
});

test('on a rig with bars the pars hold colour and let the bars travel', () => {
  for (const file of files) {
    for (const s of scenes(plan(file))) {
      if (/^(section|rotation|drop)/.test(s.source) && s.source !== 'drop:anchor') {
        assert.ok(!TRAVELLING.has(s.pattern), `${file} ${s.source} at ${s.timeMs}: pars on ${s.pattern}`);
      }
      assert.strictEqual(s.split, undefined, `${file}: pars and bars are the two layers; no group split`);
    }
  }
});

test('a drop lands on every fixture at once before the bars take over', () => {
  for (const file of files) {
    for (const s of scenes(plan(file)).filter((x) => x.source === 'drop:anchor')) {
      assert.strictEqual(s.pixelPattern, null, `${file} at ${s.timeMs}`);
    }
  }
});

test('a rig of pars plans no pictures for bars', () => {
  for (const file of files) {
    const show = plan(file, { pixels: false });
    for (const s of scenes(show)) assert.ok(!('pixelPattern' in s), `${file} ${s.source}`);
    for (const ev of show.timeline) assert.ok(!ev.data || !('pixelPattern' in ev.data), `${file}: ${JSON.stringify(ev.data)}`);
  }
});

// ── The layer ───────────────────────────────────────────────────────────────

const PROFILES = {
  par: null,
  bar8: { cells: Array.from({ length: 8 }, () => ({ channelMap: { red: 0, green: 1, blue: 2 } })) },
};
const RED = { r: 255, g: 0, b: 0, w: 0 };
const BLUE = { r: 0, g: 0, b: 255, w: 0 };
const WHITE = { r: 255, g: 255, b: 255, w: 255 };

function paint(rig, look, beatPos = 1.25) {
  const out = rig.units.map(() => null);
  renderLayer(rig, { colors: [RED, BLUE, RED, WHITE], ...look }, {
    beatPos, step: Math.floor(beatPos), anchor: 0, division: 1, phase: 0,
    expression: { level: 1, bass: 0.5, vocal: 0.5, air: 0.3, width: 0.5, motion: 0.4, decay: 0.25 },
    dynamicsOn: false, fixtureCount: rig.fixtures.length, twinkle: rig.units.map(() => 0),
    pixelTwinkle: rig.units.map(() => 0),
  }, (u, colour, dim) => { out[u] = { colour, dim }; });
  return out;
}

test('the pars run the look\'s pattern and the bars their own picture', () => {
  const rig = buildRig([{ profileId: 'par' }, { profileId: 'bar8' }, { profileId: 'par' }], (f) => PROFILES[f.profileId]);
  const out = paint(rig, { pattern: 'solid', pixelPattern: 'rise', pixelSpan: 16, pixelFrom: 0.5 });
  const pars = rig.units.map((u, i) => [u, i]).filter(([u]) => rig.cellMaps[u.fixture] === null).map(([, i]) => out[i]);
  const cells = rig.units.map((u, i) => [u, i]).filter(([u]) => rig.cellMaps[u.fixture] !== null).map(([, i]) => out[i]);
  for (const p of pars) assert.deepStrictEqual([p.colour, p.dim], [RED, 255], 'the pars hold the wash');
  const lit = cells.filter((c) => c.dim > 60).length;
  assert.ok(lit >= 3 && lit <= 6, `halfway through the fill, about half the bar is lit (${cells.map((c) => c.dim)})`);
});

test('without bars, a picture for them changes nothing', () => {
  const rig = buildRig([{ profileId: 'par' }, { profileId: 'par' }, { profileId: 'par' }], () => null);
  assert.deepStrictEqual(paint(rig, { pattern: 'chase', pixelPattern: 'impact' }), paint(rig, { pattern: 'chase' }));
});

test('the rise is empty at the start of its span and full at the end', () => {
  const rig = buildRig([{ profileId: 'bar8' }], (f) => PROFILES[f.profileId]);
  const lit = (from) => paint(rig, { pattern: 'solid', pixelPattern: 'rise', pixelSpan: 64, pixelFrom: from }, 0).filter((c) => c.dim > 60).length;
  assert.strictEqual(lit(0), 1, 'the first cell only');
  assert.strictEqual(lit(1), 8, 'every cell on the drop');
  assert.ok(CELL_PATTERNS.has('rise') && CELL_PATTERNS.has('impact'));
});

// ── A strobe panel ──────────────────────────────────────────────────────────
// A WLED matrix patched as a strobe panel (server/wled.ts): zones in rows, a
// white line through the middle. It stands on the plot as a panel, but plays
// the bars' programs — it is a strobe, not a screen.


const STROBE_PANEL = wledProfile(readInfo({ name: 'Wall', mac: '00112233aabb', leds: { count: 2048, lc: 1, matrix: { w: 64, h: 32 } } }, 'x'),
  'x', null, { mode: 'strobe' });

test('a strobe panel is laid out in rows, but draws with the bars, not the screens', () => {
  const rig = buildRig([{ profileId: 'sp' }, { profileId: 'bar8' }], (f) => (f.profileId === 'sp' ? STROBE_PANEL : PROFILES[f.profileId]));
  assert.deepStrictEqual([rig.hasPanels, rig.zoned[0], rig.grids[0]], [false, true, { columns: 8, rows: 5 }]);
  assert.strictEqual(rig.layout(null, 'bar', 'strips').units.list.length, 40 + 8, 'both are strips to the look');
  assert.strictEqual(rig.layout(null, 'bar', 'panels').units.list.length, 0);

  // A screen's picture goes nowhere; the bars' strobe core strikes its white line.
  const out = paint(rig, { pattern: 'solid', pixelPattern: 'core', panelPattern: 'fire', pixelMap: 'bar' }, 0.01);
  const whites = STROBE_PANEL.cells.flatMap((cell, c) => (cell.channelMap.red === undefined ? [c] : []));
  assert.deepStrictEqual(whites, [16, 17, 18, 19, 20, 21, 22, 23]);
  for (const c of whites) assert.ok(out[c].colour.w === 255 && out[c].dim === 255, `white zone ${c} strikes`);
  for (const c of [0, 8, 24, 39]) assert.ok(out[c].colour === RED && out[c].dim > 100, `colour zone ${c} holds the wash`);
});

test('the rehearsal shows a strobe panel\'s white line as the rig lights it: dark under a colour, lit by a strobe', () => {
  const fixtures = [{ profileId: 'sp', maxBrightness: 255 }];
  const rig = buildRig(fixtures, () => STROBE_PANEL);
  const sample = createPreviewSampler([
    { timeMs: 0, action: 'patch', data: { pattern: 'solid', colorA: 0, bpm: 120, beatDivision: 1 } },
    { timeMs: 1000, action: 'energy', data: { id: 'white-strobe', durationMs: 500 } },
  ]);
  const red = sample(500, fixtures, COLOR_PRESETS, rig);
  assert.deepStrictEqual([red[0].r > 200, red[16].r, red[16].w], [true, 0, 0], 'a red look: the colour zones red, the white line dark');
  const strobe = sample(1100, fixtures, COLOR_PRESETS, rig);
  assert.deepStrictEqual([strobe[16].r, strobe[16].w], [0, 255], 'the white strobe lights it');
});
