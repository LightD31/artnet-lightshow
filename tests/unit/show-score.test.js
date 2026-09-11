'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { ShowDirector } = require('../../src/show/director');
const { renderIntents } = require('../../src/show/render');
const { PATTERNS, COLOR_PRESETS } = require('../../src/server/presets');
const { patchSchema } = require('../../src/server/validation');
const { makeScore, semantics } = require('../../src/show/score');
const cv = v => [{ t: 0, v }, { t: 40, v }];
function track(extra = {}) {
  return { duration: 40, bpm: 120, meter: 4, key: 'C', scale: 'major',
    mood: { arousal: .8, danceability: .8 },
    segments: [{ start: 0, end: 20, role: 'verse', level: 'mid', label: 'a' },
      { start: 20, end: 40, role: 'chorus', level: 'high', label: 'b' }],
    instruments: { scores: { kick: 1, vocal: 1, bassline: 1 }, curves: { kick: cv(.8), bassline: cv(.7), vocal: cv(.2) } },
    energyCurve: cv(.8), rhythm: { stability: .9, intensityCurve: cv(.8) },
    events: [{ t: 8, type: 'BASS_HIT', confidence: .9 }, { t: 22, type: 'DROP', confidence: .95 }],
    ...extra };
}
const plan = (a, intensity = 50) => new ShowDirector({ patterns: PATTERNS, colorPresets: COLOR_PRESETS, intensity }).plan(a);
const expressions = p => p.intents.filter(i => i.kind === 'EXPRESSION' && i.source === 'music');

test('semantic evidence changes the palette, ties keep the key/mood fallback', () => {
  const warm = plan(track({ semantic_scores: [{ label: 'warm', score: .5 }, { label: 'organic', score: .45 }, { label: 'cold', score: .1 }] }));
  const cold = plan(track({ semantic_scores: [{ label: 'warm', score: .1 }, { label: 'cold', score: .5 }, { label: 'mechanical', score: .45 }] }));
  assert.equal(warm.paletteName, 'desert'); assert.equal(cold.paletteName, 'arctic');
  assert.deepEqual(semantics([{ label: 'warm', score: .3 }, { label: 'cold', score: .3 }]), {});
});

test('stem activity shapes actual render targets and source confidence gates leakage', () => {
  const a = track(), b = track({ sources: { vocals: 0, bass: .7, drums: .3 } });
  assert.ok(makeScore(a).sample(2).vocal > makeScore(b).sample(2).vocal);
  const p = plan(a), targets = expressions(p);
  assert.ok(targets[0].dynamics.bass > targets[0].dynamics.vocal);
  for (const e of renderIntents(p.intents)) if (e.action === 'patch') {
    assert.equal(patchSchema.safeParse(e.data).success, true, JSON.stringify(e));
    assert.ok(!('masterDimmer' in e.data));
  }
});

test('embeddings restore the identity of repeated passages with different structure labels', () => {
  const a = track({ embeddings: [{ time: 4, vector: [1, 0] }, { time: 24, vector: [1, 0] }] });
  const scenes = plan(a).intents.filter(i => i.source.startsWith('section:'));
  assert.equal(scenes[0].identity, scenes[1].identity);
  assert.deepEqual(scenes[0].colors, scenes[1].colors);
});

test('short silence closes all automatic light immediately and restores at its exact end', () => {
  const a = track({ events: [{ t: 1.1, duration: .1, type: 'SILENCE', confidence: 1 }] });
  const out = renderIntents(plan(a).intents);
  const start = out.find(e => e.timeMs === 1100);
  assert.equal(start.data.showDynamics.level, 0); assert.equal(start.data.energyOverride, null);
  const end = out.find(e => Math.abs(e.timeMs - 1200) < .001);
  assert.ok(end.data.showDynamics.level > 0);
});

test('intensity is bounded and zero removes accents without touching master controls', () => {
  const low = plan(track(), 0), high = plan(track(), 100);
  assert.equal(low.intents.filter(i => i.kind === 'ACCENT').length, 0);
  assert.ok(expressions(high)[0].dynamics.level > expressions(low)[0].dynamics.level);
  assert.ok(high.intents.some(i => ['kill', 'color-strobe'].includes(i.burst)));
});

test('legacy documents still plan, corrupt vectors and nonfinite similarities are ignored', () => {
  assert.ok(plan({ duration: 10, bpm: 120, segments: [] }).intents.length);
  const p = plan(track({ embeddings: [{ time: 0, vector: [NaN] }], semantic_scores: [{ label: 'warm', score: Infinity }] }));
  assert.doesNotThrow(() => JSON.stringify(p.intents));
  assert.ok(p.intents.every(i => Number.isFinite(i.timeMs)));
});

test('expressive opening survives same-time scene patches and quiet spans block accents', () => {
  const a = track({ events: [
    { t: 8, type: 'SILENCE', confidence: 1, duration: 2 },
    { t: 8.2, type: 'DROP', confidence: 1 },
    { t: 10.5, type: 'BASS_HIT', confidence: .9 },
  ] });
  const p = plan(a);
  const opening = renderIntents(p.intents).filter(e => e.timeMs === 0 && 'showDynamics' in e.data);
  assert.ok(opening.at(-1).data.showDynamics.level > 0);
  assert.ok(!p.intents.some(i => i.kind === 'ACCENT' && i.timeMs >= 8000 && i.timeMs < 10000));
});

test('stereo width and vocal activity change the rendered pattern, for one through eight lamps', () => {
  const { PATTERN_FUNCS } = require('../../src/server/patterns');
  const draw = (count, vocal, width) => {
    const rows = [];
    PATTERN_FUNCS.ensemble({ colors: COLOR_PRESETS.slice(0, 4), fixtureCount: count, phase: .2,
      dynamics: { bass: .5, vocal, air: .7, width }, write: (i, c, dim) => rows.push({ i, c, dim }) });
    return rows;
  };
  for (const count of [1, 2, 4, 8]) {
    const a = draw(count, .1, .1), b = draw(count, .9, .9);
    assert.equal(a.length, count); assert.notDeepEqual(a, b);
    assert.ok(b.every(row => Number.isFinite(row.dim) && row.dim >= 0 && row.dim <= 255));
  }
});
