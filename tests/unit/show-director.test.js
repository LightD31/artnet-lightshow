'use strict';

// The director is where the show gets its judgement, so these tests are about
// judgement rather than about output format: does it rest where a designer
// would rest, does it stay inside its budget, does a returning chorus look like
// the chorus. The rendering tests next door cover the format.

const test = require('node:test');
const assert = require('node:assert');

const { ShowDirector, ROLE_PROFILE, ACCENT_BUDGET } = require('../../src/show/director');
const { INTENT, BURST } = require('../../src/show/intents');
const { COLOR_PRESETS, PATTERNS } = require('../../src/server/presets');

const BPM = 128;
const BEAT = 60 / BPM;
const BAR = BEAT * 4;

/** A four-minute dance track with a written arrangement. */
function analysis(over = {}) {
  const bars = 120;
  const beats = [];
  const downbeats = [];
  for (let bar = 0; bar < bars; bar++) {
    downbeats.push(+(bar * BAR).toFixed(3));
    for (let b = 0; b < 4; b++) beats.push(+((bar * 4 + b) * BEAT).toFixed(3));
  }
  const at = (bar) => +(bar * BAR).toFixed(3);
  return {
    duration: bars * BAR,
    bpm: BPM,
    meter: 4,
    tempoStability: 0.95,
    tempoCurve: [],
    key: 'A',
    scale: 'minor',
    mood: { valence: 0.6, arousal: 0.85, danceability: 0.85, kickiness: 0.8 },
    genre: { label: 'edm', confidence: 0.9, style: 'dance' },
    beats,
    beatStrengths: beats.map((_, i) => (i % 4 === 0 ? 0.9 : 0.4)),
    downbeats,
    downbeatConfidence: 0.9,
    onsets: beats.slice(),
    segments: [
      { start: at(0), end: at(8), role: 'intro', level: 'low', energy: 0.2, brightness: 0.3, bass: 0.2, label: 'A', confidence: 0.7 },
      { start: at(8), end: at(24), role: 'verse', level: 'mid', energy: 0.5, brightness: 0.5, bass: 0.5, label: 'B', confidence: 0.7 },
      { start: at(24), end: at(40), role: 'chorus', level: 'high', energy: 0.85, brightness: 0.7, bass: 0.7, label: 'C', confidence: 0.8 },
      { start: at(40), end: at(56), role: 'breakdown', level: 'low', energy: 0.15, brightness: 0.4, bass: 0.2, label: 'D', confidence: 0.8 },
      { start: at(56), end: at(72), role: 'drop', level: 'high', energy: 0.95, brightness: 0.8, bass: 0.9, label: 'E', confidence: 0.9 },
      { start: at(72), end: at(88), role: 'verse', level: 'mid', energy: 0.5, brightness: 0.5, bass: 0.5, label: 'B', confidence: 0.7 },
      { start: at(88), end: at(104), role: 'chorus', level: 'high', energy: 0.85, brightness: 0.7, bass: 0.7, label: 'C', confidence: 0.8 },
      { start: at(104), end: at(120), role: 'outro', level: 'low', energy: 0.2, brightness: 0.3, bass: 0.2, label: 'F', confidence: 0.7 },
    ],
    drops: [{ t: at(56), confidence: 0.9, breakdownScore: 0.8, sustainScore: 0.9, kind: 'proper', snapTo: 'downbeat' }],
    buildups: [{ start: at(52), end: at(56), intensity: 0.9, subdivision: 4 }],
    kickOnsets: [],
    ...over,
  };
}

function plan(a = analysis(), intensity = 50) {
  const director = new ShowDirector({
    patterns: PATTERNS, colorPresets: COLOR_PRESETS, paletteSize: 4, intensity,
  });
  return director.plan(a);
}

const of = (intents, kind) => intents.filter((i) => i.kind === kind);
const from = (intents, source) => intents.filter((i) => i.source === source);
const accents = (intents) => of(intents, INTENT.ACCENT);

// ── Pacing and contrast ─────────────────────────────────────────────────────

test('the accent budget is respected across every rolling minute', () => {
  for (const intensity of [25, 50, 75, 100]) {
    const { intents } = plan(analysis(), intensity);
    const bursts = accents(intents).map((i) => i.timeMs);
    const cap = Math.round(ACCENT_BUDGET.dance * Math.min(2, intensity / 50));
    for (const start of bursts) {
      const inWindow = bursts.filter((t) => t >= start && t < start + 60000).length;
      // Drop accents are exempt from the budget, and one drop contributes two.
      assert.ok(inWindow <= cap + 3,
        `intensity ${intensity}: ${inWindow} bursts in the minute from ${start}ms (cap ${cap})`);
    }
  }
});

test('nothing fires in the seconds before a drop', () => {
  // A stray accent there spends the audience's attention a moment before the
  // payoff needed it.
  const a = analysis();
  const dropMs = a.drops[0].t * 1000;
  const { intents } = plan(a, 100);
  const intruders = accents(intents).filter(
    (i) => i.timeMs >= dropMs - 2000 && i.timeMs < dropMs && i.source !== 'drop:slam');
  assert.deepStrictEqual(intruders, []);
});

test('nothing fires in the seconds after a drop either', () => {
  // The drop is the statement. Carrying on flashing over it reads as the rig
  // not having noticed.
  const a = analysis();
  const dropMs = a.drops[0].t * 1000;
  const { intents } = plan(a, 100);
  const after = accents(intents).filter(
    (i) => i.timeMs > dropMs + 2000 && i.timeMs <= dropMs + 3000
      && !i.source.startsWith('drop:'));
  assert.deepStrictEqual(after, []);
});

test('two bursts never overlap', () => {
  const { intents } = plan(analysis(), 100);
  const bursts = accents(intents).sort((a, b) => a.timeMs - b.timeMs);
  for (let i = 1; i < bursts.length; i++) {
    const gap = bursts[i].timeMs - (bursts[i - 1].timeMs + bursts[i - 1].durationMs);
    assert.ok(gap >= 0,
      `burst at ${bursts[i].timeMs}ms starts inside the one before it`);
  }
});

test('the intensity fader really does change how much the show does', () => {
  const counts = [0, 25, 50, 100].map((i) => accents(plan(analysis(), i).intents).length);
  assert.strictEqual(counts[0], 0, 'intensity 0 is a show that does nothing loud');
  assert.ok(counts[3] > counts[1], `expected more at 100 than at 25, got ${counts}`);
});

// ── Rest ────────────────────────────────────────────────────────────────────

test('the roles that are meant to rest carry no accents', () => {
  const a = analysis();
  const { intents } = plan(a, 100);
  const resting = a.segments.filter((s) => !ROLE_PROFILE[s.role].accents);
  assert.ok(resting.length > 0, 'the fixture must contain some resting sections');
  for (const section of resting) {
    const inside = accents(intents).filter((i) => i.timeMs >= section.start * 1000
      && i.timeMs < section.end * 1000 && !i.source.startsWith('drop:'));
    assert.deepStrictEqual(inside.map((i) => i.timeMs), [],
      `${section.role} should be a rest`);
  }
});

test('an intro opens on a slow look rather than giving away the chorus', () => {
  const { intents } = plan();
  const intro = from(intents, 'section:intro')[0];
  assert.ok(intro, 'the intro should get its own scene');
  assert.ok(['fade', 'wave', 'solid'].includes(intro.pattern),
    `intro opened on ${intro.pattern}`);
  assert.strictEqual(intro.beatDivision, 1);
});

test('a breakdown pulls the show back', () => {
  const a = analysis();
  const { intents } = plan(a, 100);
  const breakdown = a.segments.find((s) => s.role === 'breakdown');
  const scene = of(intents, INTENT.SCENE).find(
    (i) => i.source === 'section:breakdown');
  assert.ok(scene);
  assert.strictEqual(scene.beatDivision, 1);
  assert.strictEqual(scene.strobeSpeed, 0);
  void breakdown;
});

test('a calm track does nothing loud at normal intensity', () => {
  const a = analysis({
    genre: { label: 'ambient', confidence: 0.9, style: 'calm' },
    mood: { valence: 0.5, arousal: 0.2, danceability: 0.2, kickiness: 0.1 },
  });
  for (const intensity of [25, 50, 65]) {
    const { intents } = plan(a, intensity);
    assert.deepStrictEqual(accents(intents), [],
      `intensity ${intensity} put a burst on a calm track`);
  }
});

test('pushing the fader past 70 buys a calm track its drops and nothing else', () => {
  // A fader that did nothing on a ballad is a fader the operator stops
  // trusting. It buys drops, never accent density.
  const a = analysis({
    genre: { label: 'ambient', confidence: 0.9, style: 'calm' },
    mood: { valence: 0.5, arousal: 0.2, danceability: 0.2, kickiness: 0.1 },
  });
  const bursts = accents(plan(a, 100).intents);
  assert.ok(bursts.length > 0, 'the fader should reach something');
  for (const burst of bursts) {
    assert.ok(burst.source.startsWith('drop:'),
      `a calm track fired ${burst.source} outside a drop`);
  }
});

// ── Structure ───────────────────────────────────────────────────────────────

test('a returning section returns to the same look', () => {
  const { intents } = plan();
  const scenes = of(intents, INTENT.SCENE).filter((i) => i.label);
  const byLabel = new Map();
  for (const scene of scenes) {
    if (!byLabel.has(scene.label)) byLabel.set(scene.label, []);
    byLabel.get(scene.label).push(scene);
  }
  for (const [label, group] of byLabel) {
    if (group.length < 2) continue;
    const patterns = new Set(group.map((s) => s.pattern));
    const colours = new Set(group.map((s) => s.colors.join(',')));
    assert.strictEqual(patterns.size, 1, `label ${label} used ${[...patterns]}`);
    assert.strictEqual(colours.size, 1, `label ${label} used ${[...colours]}`);
  }
});

test('the drop gets the biggest gesture in the show', () => {
  const a = analysis();
  const { intents } = plan(a, 100);
  const dropMs = a.drops[0].t * 1000;
  const bursts = accents(intents).filter(
    (i) => i.timeMs >= dropMs && i.timeMs < dropMs + 3000);
  assert.ok(bursts.length > 0, 'the drop should fire something');
  assert.ok(bursts.some((b) => b.burst === BURST.BLINDER
    || b.burst === BURST.WHITE_STROBE),
  `expected a blinder or white strobe, got ${bursts.map((b) => b.burst)}`);
});

test('white strobe never appears outside a drop', () => {
  // It stopped meaning anything when the old engine reached for it on every
  // bright accent.
  const { intents } = plan(analysis(), 100);
  for (const burst of accents(intents)) {
    if (burst.burst !== BURST.WHITE_STROBE) continue;
    assert.ok(burst.source.startsWith('drop:'), `white strobe from ${burst.source}`);
  }
});

test('the build-up runs tension, rise, peak and a gap, in that order', () => {
  const { intents } = plan(analysis(), 75);
  const phases = intents
    .filter((i) => i.source.startsWith('buildup:'))
    .sort((a, b) => a.timeMs - b.timeMs)
    .map((i) => i.source);
  assert.deepStrictEqual(phases,
    ['buildup:tension', 'buildup:rise', 'buildup:peak', 'buildup:gap']);
});

test('the build-up goes dark immediately before the drop', () => {
  const a = analysis();
  const { intents } = plan(a, 75);
  const gap = intents.find((i) => i.source === 'buildup:gap');
  assert.ok(gap);
  assert.strictEqual(gap.kind, INTENT.DARK);
  assert.ok(Math.abs(gap.timeMs - (a.drops[0].t * 1000 - 150)) < 5);
});

test('scene changes land on bar lines', () => {
  const a = analysis();
  const { intents } = plan(a);
  const downbeatMs = new Set(a.downbeats.map((t) => Math.round(t * 1000)));
  for (const scene of of(intents, INTENT.SCENE)) {
    if (!scene.source.startsWith('section:') || scene.source.endsWith('followup')) continue;
    assert.ok(downbeatMs.has(scene.timeMs),
      `${scene.source} at ${scene.timeMs}ms is not on a bar line`);
  }
});

test('triple metre never subdivides the beat', () => {
  // Subdividing 3/4 by two puts the rig on the off-beats of the bar.
  const { intents } = plan(analysis({ meter: 3 }), 100);
  const divisions = new Set(of(intents, INTENT.SCENE)
    .filter((i) => i.beatDivision != null)
    .map((i) => i.beatDivision));
  assert.deepStrictEqual([...divisions], [1]);
});

// ── Tempo ───────────────────────────────────────────────────────────────────

test('a steady track gets one tempo instruction and no more', () => {
  const { intents } = plan();
  const tempos = of(intents, INTENT.TEMPO);
  assert.deepStrictEqual(tempos, [], 'the opening scene already set the clock');
});

test('a drifting track has its tempo followed', () => {
  const a = analysis({
    tempoStability: 0.3,
    tempoCurve: Array.from({ length: 40 }, (_, i) => ({ t: i * 5, v: 120 + i })),
  });
  const tempos = of(plan(a).intents, INTENT.TEMPO);
  assert.ok(tempos.length > 3, 'the clock should follow a real drift');
  assert.ok(tempos.every((t) => t.bpm >= 50 && t.bpm <= 220));
});

test('no two tempo instructions land on the same millisecond', () => {
  const a = analysis({
    tempoStability: 0.3,
    tempoCurve: Array.from({ length: 40 }, (_, i) => ({ t: i * 5, v: 120 + i })),
  });
  const times = of(plan(a).intents, INTENT.TEMPO).map((i) => i.timeMs);
  assert.strictEqual(new Set(times).size, times.length);
});

// ── Robustness ──────────────────────────────────────────────────────────────

test('an analysis with nothing in it still produces a usable opening', () => {
  const { intents, palette } = plan({ duration: 10 });
  assert.ok(palette.length > 0);
  const opening = from(intents, 'opening')[0];
  assert.ok(opening);
  assert.strictEqual(opening.running, true);
  assert.strictEqual(opening.masterBlackout, false);
});

test('a nonsense tempo is clamped rather than passed through', () => {
  const { intents } = plan(analysis({ bpm: 1e9 }));
  const opening = from(intents, 'opening')[0];
  assert.ok(opening.bpm >= 20 && opening.bpm <= 300);
});

test('the palette is locked for the whole track', () => {
  const { intents, palette } = plan(analysis(), 100);
  const used = new Set();
  for (const intent of of(intents, INTENT.SCENE)) {
    for (const colour of intent.colors || []) used.add(colour);
  }
  for (const colour of used) {
    assert.ok(palette.includes(colour), `colour ${colour} is outside the locked palette`);
  }
});

test('silence in the track goes dark', () => {
  const a = analysis({
    events: null,
    segments: analysis().segments,
  });
  a.events = require('../../src/show/musical-events').deriveEvents(a).concat([
    { t: 30, type: 'SILENCE', confidence: 0.9, intensity: 0, duration: 2,
      effect: 'blackout', data: { end: 32 } },
  ]);
  const dark = of(plan(a).intents, INTENT.DARK).filter((i) => i.source === 'silence');
  assert.strictEqual(dark.length, 1);
  assert.strictEqual(dark[0].timeMs, 30000);
});
