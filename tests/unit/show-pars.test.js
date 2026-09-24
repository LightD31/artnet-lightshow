// The show on a rig of pars: no bars to carry the movement, so the pars carry
// all of it and what the show adds is shape. The chorus and the drop are laid
// symmetrically about the centre of the stage, a build-up stacks out from the
// middle, a long passage comes back to its own look at the top of every
// phrase, and `hit` flashes with the drums when the track's drum lanes are
// ones a light may follow.

import test from 'node:test';
import assert from 'node:assert';

import { ShowDirector } from '../../src/show/director.ts';
import { INTENT } from '../../src/show/intents.ts';
import { PAR_PICTURES, PAR_PICTURES_WITH_DRUMS, pickPattern } from '../../src/show/look.ts';
import { pulseTrack } from '../../src/show/pulse.ts';
import { renderLayer } from '../../src/shared/layer.ts';
import { buildRig } from '../../src/shared/rig.ts';
import { PATTERN_FUNCS } from '../../src/shared/patterns.ts';
import { hitBrightness } from '../../src/shared/look-math.ts';
import { applyPatch } from '../../src/server/patch.ts';
import { state } from '../../src/server/state.ts';
import { COLOR_PRESETS, PATTERNS } from '../../src/server/presets.ts';

const BPM = 128;
const BEAT = 60 / BPM;
const BAR = BEAT * 4;
const at = (bar) => +(bar * BAR).toFixed(3);

/** Intro, verse, chorus, breakdown, a build into a drop, verse, chorus, outro. */
function analysis({ pulse = null } = {}) {
  const bars = 120;
  const beats = [];
  const downbeats = [];
  for (let bar = 0; bar < bars; bar++) {
    downbeats.push(at(bar));
    for (let b = 0; b < 4; b++) beats.push(+((bar * 4 + b) * BEAT).toFixed(3));
  }
  return {
    duration: bars * BAR, bpm: BPM, meter: 4, tempoStability: 0.95, tempoCurve: [],
    key: 'A', scale: 'minor',
    mood: { valence: 0.6, arousal: 0.85, danceability: 0.85, kickiness: 0.8 },
    genre: { label: 'edm', confidence: 0.9, style: 'dance' },
    beats, beatStrengths: beats.map((_, i) => (i % 4 === 0 ? 0.9 : 0.4)),
    downbeats, downbeatConfidence: 0.9, onsets: beats.slice(),
    segments: [
      { start: at(0), end: at(8), role: 'intro', level: 'low', energy: 0.2, label: 'A' },
      { start: at(8), end: at(24), role: 'verse', level: 'mid', energy: 0.5, label: 'B' },
      { start: at(24), end: at(40), role: 'chorus', level: 'high', energy: 0.85, label: 'C' },
      { start: at(40), end: at(56), role: 'breakdown', level: 'low', energy: 0.15, label: 'D' },
      { start: at(56), end: at(72), role: 'drop', level: 'high', energy: 0.95, label: 'E' },
      { start: at(72), end: at(88), role: 'verse', level: 'mid', energy: 0.5, label: 'B' },
      { start: at(88), end: at(104), role: 'chorus', level: 'high', energy: 0.85, label: 'C' },
      { start: at(104), end: at(120), role: 'outro', level: 'low', energy: 0.2, label: 'F' },
    ],
    drops: [{ t: at(56), confidence: 0.9, breakdownScore: 0.8, sustainScore: 0.9, kind: 'proper', snapTo: 'downbeat' }],
    buildups: [{ start: at(48), end: at(56), intensity: 0.9, subdivision: 4 }],
    kickOnsets: [],
    ...(pulse ? { pulse } : {}),
  };
}

function plan(doc = analysis(), { intensity = 60, pixels = false } = {}) {
  const director = new ShowDirector({ patterns: PATTERNS, colorPresets: COLOR_PRESETS, paletteSize: 4, intensity, pixels });
  return director.plan(doc);
}

const scenes = (intents) => intents.filter((i) => i.kind === INTENT.SCENE && i.pattern);
const sectionAt = (doc, ms) => doc.segments.find((s) => ms / 1000 >= s.start - 0.01 && ms / 1000 < s.end);

// The looks that change when laid mirrored (director.ts MIRRORED_LOOKS).
const TRAVELLING = new Set(['chase', 'chase-rev', 'runner', 'pairs', 'ping-pong', 'stack-up',
  'sections', 'split', 'random-flash', 'wave', 'comet', 'gradient']);

test('every scene says how it is laid out, so a verse after a chorus crosses the stage again', () => {
  for (const intensity of [30, 60, 90]) {
    for (const s of scenes(plan(analysis(), { intensity }).intents)) {
      assert.ok(s.pixelMap === 'stage' || s.pixelMap === 'mirror', `${s.source} at ${s.timeMs}: ${s.pixelMap}`);
      assert.strictEqual(s.pixelPattern, undefined, 'a rig of pars has no bars to give a picture to');
    }
  }
});

test('the chorus and the drop are laid about the centre; the verses across', () => {
  const doc = analysis();
  const all = scenes(plan(doc).intents);
  let mirrored = 0;
  for (const s of all) {
    if (String(s.source).startsWith('buildup:') || s.source === 'break' || s.source === 'drop:anchor') continue;
    const role = String(s.source).startsWith('drop:') ? 'drop' : sectionAt(doc, s.timeMs + 1)?.role;
    const expect = (role === 'chorus' || role === 'drop') && TRAVELLING.has(s.pattern) ? 'mirror' : 'stage';
    assert.strictEqual(s.pixelMap, expect, `${s.source} (${role}) on ${s.pattern} at ${s.timeMs}`);
    if (expect === 'mirror') mirrored++;
  }
  assert.ok(mirrored >= 4, `only ${mirrored} mirrored scenes`);
  const verse = all.find((s) => s.source === 'section:verse');
  assert.strictEqual(verse.pixelMap, 'stage');
});

test('a build-up stacks out from the middle, and its peak and the drop anchor are the whole rig', () => {
  const { intents } = plan();
  const rise = intents.find((i) => i.source === 'buildup:rise');
  assert.strictEqual(rise.pattern, 'stack-up');
  assert.strictEqual(rise.pixelMap, 'mirror');
  assert.ok(rise.beatDivision >= 2, 'on the build\'s quickening steps');
  assert.strictEqual(intents.find((i) => i.source === 'buildup:peak').pixelMap, 'stage');
  assert.strictEqual(intents.find((i) => i.source === 'drop:anchor').pixelMap, 'stage');
});

test('a long passage comes back to its own look at the top of every phrase', () => {
  const { intents } = plan(analysis(), { intensity: 90 });
  const chorus = intents.find((i) => i.source === 'section:chorus');
  const end = chorus.timeMs + 16 * BAR * 1000;
  const turns = intents.filter((i) => i.source === 'rotation' && i.timeMs > chorus.timeMs && i.timeMs < end);
  assert.ok(turns.length >= 4, `only ${turns.length} turns in sixteen bars`);
  const looks = turns.map((i) => i.pattern);
  assert.strictEqual(looks[3], chorus.pattern, `the fourth turn is the chorus's own: ${looks.join(', ')}`);
  assert.ok(new Set(looks.slice(0, 3)).size >= 2, `more than two looks take turns: ${looks.join(', ')}`);
  assert.ok(!looks.slice(0, 3).includes(chorus.pattern), 'and in between, others');
});

test('the pars take the pictures that read on a few lamps, the kit only on drum lanes a light may follow', () => {
  assert.ok(!PAR_PICTURES.has('drums') && PAR_PICTURES_WITH_DRUMS.has('drums'));
  assert.ok(!PAR_PICTURES.has('stems'), 'four zones need more lamps than a row of pars has');
  const available = new Set(PATTERNS.map((p) => p.id));
  const groove = { kick: 0.9, bassline: 0.8, energy: 0.9, pulse: 0.9, vocal: 0.1 };
  const pick = (pictures) => {
    const got = new Set();
    for (let seed = 0; seed < 40; seed++) got.add(pickPattern({ character: groove, available, seed, drive: 0.9, dance: 0.9, pictures }));
    return got;
  };
  const plain = pick(null);
  assert.ok(![...plain].some((p) => PAR_PICTURES_WITH_DRUMS.has(p)), 'without them, the lamp patterns alone');
  const pars = pick(PAR_PICTURES);
  assert.ok([...pars].some((p) => PAR_PICTURES.has(p)), [...pars].join(', '));
  assert.ok(!pars.has('drums'));
  assert.ok(pick(PAR_PICTURES_WITH_DRUMS).has('drums'));

  // And the director offers the kit only for lanes found by the rules
  // measured on real drumming, and a rig with a lamp in the middle for the
  // kick and one at each end for the snare.
  const kit = (detector, lamps) => {
    const director = new ShowDirector({ patterns: PATTERNS, colorPresets: COLOR_PRESETS, paletteSize: 4, intensity: 60, lamps });
    return director.plan(drummed(detector)).context.pictures;
  };
  assert.strictEqual(kit(2), PAR_PICTURES_WITH_DRUMS);
  assert.strictEqual(kit(2, 4), PAR_PICTURES_WITH_DRUMS);
  assert.strictEqual(kit(2, 2), PAR_PICTURES, 'two pars have no middle');
  assert.strictEqual(kit(null), PAR_PICTURES);
  assert.strictEqual(plan(analysis(), { pixels: true }).context.pictures, null, 'a rig with bars has every picture');
});

function drummed(detector = 2) {
  const lane = { t: [], s: [] };
  for (let b = 32; b < 440; b++) { lane.t.push(+(b * BEAT).toFixed(3)); lane.s.push(0.9); }
  return analysis({ pulse: { rate: 50, encoding: 'u8-base64', source: 'stems', envelopes: { mix: '' }, lanes: { kick: lane, snare: { t: [], s: [] }, hats: { t: [], s: [] } }, ...(detector ? { detector } : {}) } });
}

test('a rig of pars replans when it crosses three lamps, and not for a lamp more or less above it', async () => {
  const { default: AutoShow } = await import('../../src/auto-show.ts');
  const show = new AutoShow(() => {}, COLOR_PRESETS, PATTERNS);
  show._worker.shutdown();
  show.analysis = drummed();
  show.setRig({ hasPixels: false, lamps: 6 });
  show.buildTimeline();
  let revision = show.timelineRevision;
  show.setRig({ hasPixels: false, lamps: 5 });
  assert.strictEqual(show.timelineRevision, revision, 'still room for the kit');
  show.setRig({ hasPixels: false, lamps: 2 });
  assert.notStrictEqual(show.timelineRevision, revision, 'the kit went');
  revision = show.timelineRevision;
  show.setRig({ hasPixels: false, lamps: 3 });
  assert.notStrictEqual(show.timelineRevision, revision, 'and came back');
});

// ── What the lamps do ───────────────────────────────────────────────────────

const pars = (n) => buildRig(Array.from({ length: n }, (_, i) => ({ position: { x: 10 + i * 80 / (n - 1), y: 40 } })), () => null);
const COLOURS = [{ r: 255, g: 0, b: 0 }, { r: 0, g: 255, b: 0 }, { r: 0, g: 0, b: 255 }, { r: 255, g: 255, b: 255 }];
const clock = (beatPos, extra = {}) => ({
  beatPos, step: Math.floor(beatPos), anchor: 0, division: 1, phase: 0,
  expression: { level: 1, bass: 0.5, vocal: 0.5, air: 0.3, width: 0.5, motion: 0.3, decay: 0.2 },
  dynamicsOn: false, fixtureCount: 6, twinkle: [], ...extra,
});
function frame(rig, look, c) {
  const out = [];
  renderLayer(rig, { colors: COLOURS, split: null, ...look }, c, (u, colour, dim) => { out[u] = dim; });
  return out;
}

test('mirrored, a chase runs from the middle out to both ends at once', () => {
  const rig = pars(6);
  const lit = (step) => frame(rig, { pattern: 'chase', pixelMap: 'mirror' }, clock(step)).map((d, i) => (d === 255 ? i : -1)).filter((i) => i >= 0);
  assert.deepStrictEqual(lit(0), [2, 3], 'the middle pair');
  assert.deepStrictEqual(lit(1), [1, 4]);
  assert.deepStrictEqual(lit(2), [0, 5], 'then the ends');
  assert.deepStrictEqual(lit(3), [2, 3], 'and round again');
  assert.deepStrictEqual(frame(rig, { pattern: 'chase', pixelMap: 'stage' }, clock(1)).map((d) => d === 255), [false, true, false, false, false, false],
    'across the stage, one lamp at a time as it always was');
});

test('a stack fills in as many steps as there are lamps, full on the last', () => {
  const ctx = (step, n) => {
    const out = [];
    PATTERN_FUNCS['stack-up']({ colors: COLOURS, fixtureCount: n, step, hue: 0, twinkle: [], xs: null, ys: null, dynamics: null, write: (i, c, dim) => { out[i] = dim === 255; } });
    return out.filter(Boolean).length;
  };
  assert.deepStrictEqual([0, 1, 2, 3, 4, 5].map((s) => ctx(s, 4)), [1, 2, 3, 4, 1, 2], 'a bar of quarters on four lamps');
  // Mirrored on six pars: three slots, the middle pair first.
  const rig = pars(6);
  const lit = (step) => frame(rig, { pattern: 'stack-up', pixelMap: 'mirror' }, clock(step)).map((d, i) => (d === 255 ? i : -1)).filter((i) => i >= 0);
  assert.deepStrictEqual(lit(0), [2, 3]);
  assert.deepStrictEqual(lit(1), [1, 2, 3, 4]);
  assert.deepStrictEqual(lit(2), [0, 1, 2, 3, 4, 5]);
});

test('hit flashes with the drums when the lanes are ones a light may follow', () => {
  const rig = pars(4);
  const kickOnly = { mix: 0.5, kick: 0, snare: 0, hats: 0, groove: 0 };
  // Between the steps, a kick the grid does not have: the rig flashes on it.
  const offGrid = frame(rig, { pattern: 'hit' }, clock(0.5, { pulse: { ...kickOnly, kick: 1, groove: 1 } }));
  assert.deepStrictEqual(offGrid, [255, 255, 255, 255]);
  // On the step with nothing hit, the grid still pulses, at half its height.
  const quiet = frame(rig, { pattern: 'hit' }, clock(0, { pulse: kickOnly }))[0];
  assert.strictEqual(quiet, Math.round(35 + (hitBrightness(0) - 35) * 0.5));
  // A soft kick is a soft flash.
  const soft = frame(rig, { pattern: 'hit' }, clock(0.5, { pulse: { ...kickOnly, kick: 0.5, groove: 0.5 } }))[0];
  assert.strictEqual(soft, Math.round(35 + 220 * 0.5));
  // Lanes a light should not follow (no groove read), or none: the grid as
  // it always was.
  for (const pulse of [null, { mix: 0.5, kick: 1, snare: 0, hats: 0 }]) {
    assert.strictEqual(frame(rig, { pattern: 'hit' }, clock(0.5, { pulse }))[0], hitBrightness(0.5));
  }
});

test('the groove is the kick, and the snare too when it was read off the drum stem', () => {
  const b64 = (v) => Buffer.from(Uint8Array.from(v)).toString('base64');
  const block = (over) => ({
    rate: 50, encoding: 'u8-base64', envelopes: { mix: b64([128, 128]) },
    lanes: { kick: { t: [1.0], s: [0.6] }, snare: { t: [2.0], s: [1] }, hats: { t: [3.0], s: [1] } }, ...over,
  });
  const stems = pulseTrack(block({ source: 'stems', detector: 2 }));
  assert.strictEqual(stems.trusted, true);
  assert.strictEqual(stems.at(1000).groove, 0.6);
  assert.strictEqual(stems.at(2000).groove, 0.85, 'a snare counts a little less than a kick');
  assert.ok(stems.at(3000).groove < 0.01, 'the hats are texture, not a hit');
  const mix = pulseTrack(block({ source: 'mix', detector: 2 }));
  assert.ok(mix.at(2000).groove < 0.01, 'without separation the snare is right less than half the time');
  const first = pulseTrack(block({ source: 'stems' }));
  assert.strictEqual(first.trusted, false);
  assert.strictEqual(first.at(1000).groove, undefined, 'the first rules fire on a snare\'s body as a kick');
});

test('on a rig of pars a build-up\'s picture plays over its span too', () => {
  const rig = pars(4);
  // Counted on the beat, before the last quarter's stutter takes it down.
  const rise = (beatPos, span) => frame(rig, { pattern: 'rise', pixelSpan: span, pixelFrom: 0 }, clock(beatPos)).filter((d) => d > 60).length;
  assert.deepStrictEqual([1, 12, 22, 31].map((b) => rise(b, 32)), [1, 2, 3, 3], 'a lamp more as the build goes on, the last on the drop');
  assert.deepStrictEqual([1, 12, 22, 31].map((b) => rise(b, null)), [1, 3, 2, 3], 'without its span it goes round every sixteen steps');
});

test('a pattern picked by hand starts from its beginning, not a build-up\'s middle', () => {
  applyPatch({ pattern: 'rise', pixelSpan: 64, pixelFrom: 0.5, anchorMs: 1000 });
  assert.strictEqual(state.pixelSpan, 64);
  applyPatch({ pattern: 'rise' });
  assert.strictEqual(state.pixelSpan, null);
  assert.strictEqual(state.pixelFrom, null);
});

test('stopping the show takes its layout with it', async () => {
  const { default: AutoShow } = await import('../../src/auto-show.ts');
  const patches = [];
  const show = new AutoShow((patch) => patches.push(patch), COLOR_PRESETS, PATTERNS);
  show._worker.shutdown();
  show.stop();
  assert.strictEqual(patches.at(-1).pixelMap, 'stage', 'a manual look after a mirrored chorus runs across the stage');
});

test('a look the operator picks for a chorus is laid out for what it is', () => {
  const doc = analysis();
  const director = new ShowDirector({
    patterns: PATTERNS, colorPresets: COLOR_PRESETS, paletteSize: 4, intensity: 60,
    overlay: { sections: [{ atMs: at(24) * 1000, pattern: 'ensemble' }, { atMs: at(88) * 1000, pattern: 'runner' }] },
  });
  const choruses = director.plan(doc).intents.filter((i) => i.source === 'section:chorus');
  assert.deepStrictEqual(choruses.map((i) => [i.pattern, i.pixelMap]), [['ensemble', 'stage'], ['runner', 'mirror']],
    'the voice held in the middle stays across; a runner is mirrored');
});
