// What the party effects hear: Hue Dynamics Party's band levels, its Disco hit
// detection and Light DJ's loudness classes, worked out on the main thread from
// the live input's hops, one frame per hop.

import test from 'node:test';
import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { AudioFeatures, resolveDetectors } from '../../src/server/audio-features.ts';
import { HD_MASTER_DEFAULTS } from '../../src/shared/effects/types.ts';
import { DISCO_DEFAULTS, DISCO_PRESETS } from '../../src/shared/effects/disco.ts';
import { VISUALIZER_DEFAULTS } from '../../src/shared/effects/ldj-visualizer.ts';
import '../../src/shared/effects/index.ts';
import { bundleSpec } from '../../src/shared/effects/bundle.ts';
import { seedFrom } from '../../src/shared/effects/hash.ts';
import { validateSpec } from '../../src/shared/effects/registry.ts';
import { BIN_HZ } from '../../src/shared/spectrum-bands.ts';
import LiveInput from '../../src/live-input.ts';

const disco = () => ({ bands: DISCO_DEFAULTS.bands, globals: DISCO_DEFAULTS.globals });
const make = (now = () => 0) => new AudioFeatures({ master: () => HD_MASTER_DEFAULTS, disco, ldjTrigger: () => 0.30, binHz: 21.53, now });
// Bands in bandList order: party bass, mid, high, disco bass, disco voice, disco treble.
const reading = (t, bands, rms = 0.1, power = 1) => ({ t, captured: t, beat: 0, bpm: 120, phase: 0, locked: true, energy: rms, onset: 0, flux: 0, rms, tension: 0, bands: {}, spectrum: { power, rms, dominantHz: 1000, bands } });
const HOP = 0.0116;

test('the band list is the union of the party and disco bands', () => {
  assert.deepStrictEqual(make().bandList(), [[20, 250], [250, 3000], [3000, 9000], [0, 160], [750, 2000], [3000, 9000]].filter((b, i, a) => a.findIndex((c) => c[0] === b[0] && c[1] === b[1]) === i));
});

test('party levels: full = clamp(rms·(2+18·sens)), bands by sqrt share ×1.8, smoothed with 30/220 ms', () => {
  const a = make();
  for (let i = 0; i < 40; i++) a.onReading(reading(i * HOP, [4, 1, 0, 0, 0], 0.1, 5));
  const f = a.frame();
  assert.ok(Math.abs(f.party.full - Math.min(1, 0.1 * (2 + 18 * 0.5))) < 0.02);           // 1.1 → 1
  assert.ok(f.party.bass > f.party.mid && f.party.mid > f.party.high);
  assert.ok(Math.abs(f.party.bass - Math.min(1, f.party.full * Math.sqrt(4 / 5) * 1.8)) < 0.05);
});

test('disco: a band well above its history and floor is a hit; the next frame, the decayed gate holds it off', () => {
  const a = make();
  for (let i = 0; i < 80; i++) a.onReading(reading(i * HOP, [0, 0, 0, 1e-3, 0]));      // quiet bass history
  a.onReading(reading(1, [0, 0, 0, 1, 0]));                                              // bass jumps
  assert.strictEqual(a.frame().disco.hit[0], true);
  a.onReading(reading(1 + HOP, [0, 0, 0, 0.9, 0]));
  assert.strictEqual(a.frame().disco.hit[0], false, 'below the decayed gate');
});

test('disco floor: a band under the total floor (minimumThreshold / 200000 = 1e-5) never hits', () => {
  const a = make();
  for (let i = 0; i < 90; i++) a.onReading(reading(i * HOP, [0, 0, 0, i === 89 ? 9e-6 : 1e-9, 0]));
  assert.strictEqual(a.frame().disco.hit[0], false);
});

test('a synthetic kick trips the Disco defaults\' bass hit; a quiet bed does not', () => {
  // Band powers as live.py emits them (|X|² of a 1024-point Hamming FFT of float samples): a −40 dBFS bed in every
  // band, then one hop with a −6 dBFS 60 Hz burst — about (0.5 · 512 · 0.54)² ≈ 1.9e4 in the bass band against ≈ 0.19.
  const a = make();
  for (let i = 0; i < 80; i++) a.onReading(reading(i * HOP, [0.19, 0.19, 0.19, 0.19, 0.19], 0.01));
  assert.strictEqual(a.frame().disco.hit[0], false);
  a.onReading(reading(1, [1.9e4, 0.19, 0.19, 1.9e4, 0.19], 0.3));
  assert.strictEqual(a.frame().disco.hit[0], true);
});

test('SPL on the 16-bit scale: full scale → level 69 LOUD, −40 dBFS → level 29 SOFT, silence QUIET', () => {
  const a = make();
  for (let i = 0; i < 20; i++) a.onReading(reading(i * HOP, [0, 0, 0, 0, 0], 32767 / 32768));
  assert.strictEqual(a.frame().spl.level, 69);
  assert.strictEqual(a.frame().spl.beat, 'loud');
  for (let i = 0; i < 20; i++) a.onReading(reading(1 + i * HOP, [0, 0, 0, 0, 0], 0.01));
  assert.strictEqual(a.frame().spl.level, 29);
  assert.strictEqual(a.frame().spl.beat, 'soft');
  for (let i = 0; i < 20; i++) a.onReading(reading(2 + i * HOP, [0, 0, 0, 0, 0], 1e-6));
  assert.strictEqual(a.frame().spl.beat, 'quiet');
});

test('no reading for half a second: frame() is null', () => {
  let now = 0;
  const a = make(() => now);
  a.onReading(reading(0, [0, 0, 0, 0, 0]));
  now = 600;
  assert.strictEqual(a.frame(), null);
});

// ── The reviewed arithmetic ───────────────────────────────────────────────────

const f32 = Math.fround;
// The defaults' band list and the key the live input stamps a reading with.
const LIST = [[20, 250], [250, 3000], [3000, 9000], [0, 160], [750, 2000]];
const KEY = (list) => list.map(([lo, hi]) => `${lo}-${hi}`).join(',');

function hop({ t, bands = [0, 0, 0, 0, 0], rms = 0.1, power = 1, fftPower, dominantHz = 1000, generation, layout, cause }) {
  const spectrum = { power, rms, dominantHz, bands };
  if (fftPower !== undefined) spectrum.fftPower = fftPower;
  const r = { t, captured: t, beat: 0, bpm: 120, phase: 0, locked: true, energy: rms, onset: 0, flux: 0, rms, tension: 0, bands: {}, spectrum };
  if (generation !== undefined) r.generation = generation;
  if (layout !== undefined) r.layout = layout;
  if (cause !== undefined) r.cause = cause;
  return r;
}

function features(over = {}) {
  return new AudioFeatures({ master: () => HD_MASTER_DEFAULTS, disco, ldjTrigger: () => 0.30, binHz: BIN_HZ, now: () => 0, ...over });
}

test('the party bands share the FFT total, not the raw frame power, which stands in only when the total is absent', () => {
  const master = { ...HD_MASTER_DEFAULTS, smoothing: 0, attackMs: 30 };
  const run = (spectrum, bands = [25, 4, 0, 0, 0]) => {
    const a = features({ master: () => master });
    // full = rms × (2 + 18 × 0.5) = 0.2; the first hop anchors, the second is 30 ms on.
    for (const t of [0, 0.03]) a.onReading(hop({ t, rms: 0.2 / 11, bands, ...spectrum }));
    return a.frame().party;
  };
  const k = 1 - Math.exp(-1);
  const near = (got, want) => assert.ok(Math.abs(got - want) < 1e-12, `${got} ≠ ${want}`);
  let p = run({ power: 1, fftPower: 100 });
  near(p.full, 0.2 * k);
  near(p.bass, 0.2 * Math.sqrt(25 / 100) * 1.8 * k);                         // 0.18 before smoothing
  near(p.mid, 0.2 * Math.sqrt(4 / 100) * 1.8 * k);                           // 0.072
  p = run({ power: 1 });
  near(p.bass, 0.36 * k);                                                    // raw power 1: both shares clamp to 1
  near(p.mid, 0.36 * k);
  p = run({ power: 100 });
  near(p.bass, 0.18 * k);
  p = run({ power: 100, fftPower: 0 });
  assert.deepStrictEqual([p.bass, p.mid, p.high], [0, 0, 0], 'a silent FFT is silent, not a reason to read the raw power');
  near(p.full, 0.2 * k);
  p = run({ power: 1, fftPower: 1e-300 }, [2.5e-301, 4e-302, 0, 0, 0]);
  near(p.bass, 0.18 * k);                                                    // a tiny total still has its shares
  near(p.mid, 0.072 * k);
});

test('party smoothing runs on stream time with the master\'s attack and release, and polls cannot move it', () => {
  const at = (master, steps) => {
    const a = features({ master: () => ({ ...HD_MASTER_DEFAULTS, ...master }) });
    for (const [t, rms] of steps) a.onReading(hop({ t, rms }));
    return a;
  };
  let a = at({ smoothing: 0, attackMs: 30 }, [[0, 1]]);
  assert.strictEqual(a.frame().party.full, 0, 'the first hop anchors the stream: no interval is invented');
  a = at({ smoothing: 0, attackMs: 30 }, [[0, 1], [0.03, 1]]);
  assert.strictEqual(a.frame().party.full, 0.6321205588285577);
  for (let i = 0; i < 5; i++) a.frame();
  a.onReading(hop({ t: 0.03, rms: 1 }));
  assert.strictEqual(a.frame().party.full, 0.6321205588285577, 'neither polls nor a repeated hop age the levels');

  a = at({ smoothing: 0, attackMs: 0, releaseMs: 220 }, [[0, 1], [0.4, 1]]);
  assert.strictEqual(a.frame().party.full, 1);
  a.onReading(hop({ t: 0.62, rms: 0 }));
  assert.strictEqual(a.frame().party.full, 0.36787944117144233, '220 ms release');
  a = at({ smoothing: 0.35, attackMs: 30 }, [[0, 1], [0.03, 1]]);
  assert.strictEqual(a.frame().party.full, 0.34075936979955623, 'τ = 30 ms × (1 + 4 × 0.35)');

  // Over half a second without a hop: the stream starts again from the next
  // one, which moves nothing, and the levels reached are kept.
  a = at({ smoothing: 0, attackMs: 30 }, [[0, 1], [0.03, 1]]);
  a.onReading(hop({ t: 0.9, rms: 0 }));
  assert.strictEqual(a.frame().party.full, 0.6321205588285577);
});

test('the history is the 80 hops before this one, from ones at the start, and a hit tests the gate before it decays', () => {
  // A first bass hop of 1.52 against eighty ones: mean 1, no variance, so
  // C × mean = 1.5142857 and it hits. With the hop counted in first, or the
  // history seeded with it, C × mean would be over 1.52.
  let a = features();
  a.onReading(hop({ t: 0, bands: [0, 0, 0, 1.52, 0] }));
  assert.strictEqual(a.frame().disco.hit[0], true);
  a = features();
  a.onReading(hop({ t: 0, bands: [0, 0, 0, 1.5, 0] }));
  assert.strictEqual(a.frame().disco.hit[0], false);

  a = features();
  for (let i = 0; i < 80; i++) a.onReading(hop({ t: i * HOP, bands: [0, 0, 0, 1e-3, 0] }));
  a.onReading(hop({ t: 1, bands: [0, 0, 0, 1, 0] }));
  assert.strictEqual(a.frame().disco.hit[0], true);
  assert.strictEqual(a.frame().disco.level[0], 1, 'level is the raw band power');
  // The hit's own power is the gate on the next hop, before that hop decays it:
  // 0.99 would clear 1 − 1 × 25/1000 but not 1.
  a.onReading(hop({ t: 1 + HOP, bands: [0, 0, 0, 0.99, 0] }));
  assert.deepStrictEqual([a.frame().disco.hit[0], a.frame().disco.gate[0]], [false, 1]);
  let decayed = f32(1 - f32(1 * f32(25 / 1000)));
  for (let i = 0; i < 5; i++) a.frame();
  a.onReading(hop({ t: 1 + HOP, bands: [0, 0, 0, 0.99, 0] }));
  a.onReading(hop({ t: 1 + 2 * HOP, bands: [0, 0, 0, 1e-3, 0] }));
  assert.strictEqual(a.frame().disco.gate[0], decayed, 'once per new hop: polls and a repeat do not decay it');
  for (let i = 3; i < 30; i++) {
    decayed = f32(decayed - f32(1 * f32(25 / 1000)));
    a.onReading(hop({ t: 1 + i * HOP, bands: [0, 0, 0, 1e-3, 0] }));
  }
  assert.strictEqual(a.frame().disco.gate[0], decayed);
});

test('the gate is the raw power a band must pass: the larger of its decayed hit and its thresholds over the sensitivity', () => {
  const a = features({ disco: () => ({ bands: DISCO_DEFAULTS.bands, globals: { ...DISCO_DEFAULTS.globals, sensitivity: 25 } }) });
  a.onReading(hop({ t: 0, bands: [0, 0, 0, 0.1, 0] }));
  // Eighty ones: mean 1, C = 1.5142857; s = 25/100 × 2 = 0.5.
  const s = f32(f32(f32(25) / 100) * 2);
  assert.strictEqual(a.frame().disco.gate[0], f32(f32(1.5142857) / s));
  assert.ok(a.frame().disco.gate.every(Number.isFinite));
});

test('a changed band starts its history from its next power; the others keep theirs', () => {
  let bands = DISCO_DEFAULTS.bands;
  const a = features({ disco: () => ({ bands, globals: DISCO_DEFAULTS.globals }) });
  for (let i = 0; i < 80; i++) a.onReading(hop({ t: i * HOP, bands: [0, 0, 0, 1e-3, 1e-3] }));
  bands = { ...DISCO_DEFAULTS.bands, bass: [0, 120] };
  assert.deepStrictEqual(a.bandList(), [[20, 250], [250, 3000], [3000, 9000], [0, 120], [750, 2000]]);
  // Ten in both: the edited bass is measured against itself, the voice against its quiet past.
  a.onReading(hop({ t: 1, bands: [0, 0, 0, 10, 10] }));
  assert.deepStrictEqual(a.frame().disco.hit.slice(0, 2), [false, true]);
  // At the start the history is ones, which ten clears: priming is not startup.
  const fresh = features();
  fresh.onReading(hop({ t: 0, bands: [0, 0, 0, 10, 10] }));
  assert.deepStrictEqual(fresh.frame().disco.hit.slice(0, 2), [true, true]);
});

test('a band edit drops the hops summed over the old bands and asks the input for the new ones', () => {
  let now = 0;
  let bands = DISCO_DEFAULTS.bands;
  const asked = [];
  const a = features({ now: () => now, disco: () => ({ bands, globals: DISCO_DEFAULTS.globals }), onBands: () => asked.push(a.bandList()) });
  const before = KEY(LIST);
  const level = (L) => 2e-6 * 10 ** ((L + 55.5 + 80) / 20) / 32768;
  // Three soft classes on the old process, a quiet history behind the voice band, and a bass hit last.
  a.onReading(hop({ t: 0, generation: 1, layout: before, rms: 0, bands: [0, 0, 0, 1e-3, 1e-3] }));
  for (let i = 1; i <= 12; i++) a.onReading(hop({ t: i * 0.025, generation: 1, layout: before, rms: level(29), bands: [0, 0, 0, i === 12 ? 10 : 1e-3, 1e-3] }));
  const old = a.frame();
  assert.deepStrictEqual([old.spl.beat, old.spl.section, old.disco.hit[0]], ['soft', 'soft', true]);

  bands = { ...DISCO_DEFAULTS.bands, bass: [0, 120] };
  const after = KEY([[20, 250], [250, 3000], [3000, 9000], [0, 120], [750, 2000]]);
  now = 300;
  a.onReading(hop({ t: 0.325, generation: 1, layout: before, bands: [0, 0, 0, 10, 10] }));
  a.onReading(hop({ t: 0.35, generation: 1, layout: before, bands: [0, 0, 0, 10, 10] }));
  assert.strictEqual(a.frame().t, old.t, 'not heard: summed over the old bands');
  assert.strictEqual(a.frame().disco.hit.some(Boolean), false, 'and the edit takes the old hits off the published frame');
  assert.deepStrictEqual(asked, [[[20, 250], [250, 3000], [3000, 9000], [0, 120], [750, 2000]]], 'asked once');
  now = 600;
  assert.strictEqual(a.frame(), null, 'and they kept nothing fresh');

  // The new process: the edited bass starts from its first power, the voice
  // keeps its quiet past, the sections so far stand, and no old class is held.
  a.onReading(hop({ t: 0.0116, generation: 2, layout: after, cause: 'bands', rms: level(29), bands: [0, 0, 0, 10, 10] }));
  const f = a.frame();
  assert.ok(f.generation > old.generation, 'a new epoch: the stream starts from zero again');
  assert.deepStrictEqual(f.disco.hit.slice(0, 2), [false, true]);
  assert.deepStrictEqual([f.spl.beat, f.spl.section, f.spl.eventT], [null, 'soft', undefined]);
  assert.strictEqual(a.frame(0.005), null, 'nothing of the old process is selected');
});

test('Disco globals edits keep the histories and take the published hits back', () => {
  let globals = DISCO_DEFAULTS.globals;
  const a = features({ disco: () => ({ bands: DISCO_DEFAULTS.bands, globals }) });
  for (let i = 0; i < 80; i++) a.onReading(hop({ t: i * HOP, bands: [0, 0, 0, 1e-3, 0] }));
  a.onReading(hop({ t: 1, bands: [0, 0, 0, 1, 0] }));
  assert.strictEqual(a.frame().disco.hit[0], true);
  globals = { ...globals, sensitivity: 51 };
  assert.deepStrictEqual([a.frame().t, a.frame().disco.hit[0]], [1, false], 'the same hop, no longer a hit');
  // 1.2 clears the quiet history (and the gate of 1) but would not clear ones.
  a.onReading(hop({ t: 1 + HOP, bands: [0, 0, 0, 1.2, 0] }));
  assert.strictEqual(a.frame().disco.hit[0], true);
});

test('an owner change with the same settings changes nothing', () => {
  const copy = (x) => JSON.parse(JSON.stringify(x));
  const a = features();
  // Fresh objects every call, the globals in one order then the other: the same settings.
  let calls = 0;
  const entries = Object.entries(DISCO_DEFAULTS.globals);
  const reordered = () => ({ bands: copy(DISCO_DEFAULTS.bands), globals: Object.fromEntries(++calls % 2 ? entries : [...entries].reverse()) });
  const b = features({ disco: reordered, ldjTrigger: () => Number('0.3') });
  for (let i = 0; i < 200; i++) {
    const r = hop({ t: i * HOP, rms: 0.05 + 0.04 * Math.sin(i), power: 3 + 2 * Math.sin(i / 3), bands: [1, 2, 3, 4 + 3 * Math.sin(i / 2), 0.5 + Math.cos(i)].map(Math.abs) });
    a.onReading(r);
    b.onReading(copy(r));
    assert.deepStrictEqual(b.frame(), a.frame(), `hop ${i}`);
  }
});

test('Peak reads the raw frame power, with its sensitivity counted twice against the mean', () => {
  const peak = (power, globals = {}) => {
    const a = features({ disco: () => ({ bands: DISCO_DEFAULTS.bands, globals: { ...DISCO_DEFAULTS.globals, ...globals } }) });
    a.onReading(hop({ t: 0, power, fftPower: 1e5 }));
    return a.frame().disco.peakHit;
  };
  // simpleSensitivity 44: s = 0.88; floor 30 / 100000; a history of ones.
  assert.strictEqual(peak(2), true);
  assert.strictEqual(peak(1.2), false, '1.056 is under C × mean');
  assert.strictEqual(peak(1e-6), false, 'the FFT total is not Peak\'s power');
  // s = 0.5: 3.5 × s clears C × mean, 3.5 × s × s does not clear the mean.
  assert.strictEqual(peak(3.5, { simpleSensitivity: 25 }), false);
  assert.strictEqual(peak(4.5, { simpleSensitivity: 25 }), true);
});

test('Neural: the RMS over its own history from zeros, in single precision, never clipped and never NaN', () => {
  let a = features();
  a.onReading(hop({ t: 0, rms: 0.1 }));
  assert.strictEqual(a.frame().disco.neural.amplitude, 17.61006736755371, 'ratio 52.83 over a three-hop mean');

  a = features();
  a.onReading(hop({ t: 0, rms: 0, power: 0, dominantHz: null }));
  assert.deepStrictEqual(a.frame().disco.neural, { mainFrequency: 0, amplitude: 0 });

  // The floor is tested on the scaled RMS: 5e-4 × 0.5 is under 3e-4.
  a = features({ disco: () => ({ bands: DISCO_DEFAULTS.bands, globals: { ...DISCO_DEFAULTS.globals, analyserSensitivity: 25 } }) });
  a.onReading(hop({ t: 0, rms: 5e-4 }));
  assert.strictEqual(a.frame().disco.neural.amplitude, 0);

  // Bin 46 of 92 below 2 kHz is half way.
  a = features();
  for (let i = 0; i < 9; i++) a.onReading(hop({ t: i * HOP, dominantHz: 46 * BIN_HZ }));
  assert.strictEqual(a.frame().disco.neural.mainFrequency, 0.5);
});

test('Neural\'s frequency is a lower median, its smoothers written at the shared history slot modulo their length', () => {
  const at = (smoothnessAnalyser, bins) => {
    const a = features({ disco: () => ({ bands: DISCO_DEFAULTS.bands, globals: { ...DISCO_DEFAULTS.globals, smoothnessAnalyser } }) });
    bins.forEach((bin, i) => a.onReading(hop({ t: i * HOP, dominantHz: bin === null ? null : bin * BIN_HZ })));
    return a.frame().disco.neural.mainFrequency;
  };
  // Four frequencies (smoothnessAnalyser 4/3 → max(3, 4)): the lower of the middle two.
  assert.strictEqual(at(4 / 3, [0, 23, 69, 92]), 0.25);
  // Three slots: hop 78 (slot 2) is 1, hops 79 and 80 (slots 0 and 1) are 0;
  // hop 81 wraps the history to slot 0, not on to slot 2.
  const bins = Array.from({ length: 81 }, () => 0);
  bins[77] = 92;
  bins[80] = 92;
  assert.strictEqual(at(1, bins), 1);
});

// ── Light DJ's classes ───────────────────────────────────────────────────────

// The RMS whose SPL level is `L`: dB = 20·log10(rms·32768 / 2e-6) − 80 and
// level = trunc(dB) − 55, taken half way through the level.
const rmsFor = (L) => 2e-6 * 10 ** ((L + 55.5 + 80) / 20) / 32768;

// One class per level, 100 ms each, as four 25 ms hops; anchored at `from`.
function classes(a, levels, from = 0, { anchor = true } = {}) {
  if (anchor) a.onReading(hop({ t: from, rms: 0 }));
  levels.forEach((L, e) => {
    for (let j = 1; j <= 4; j++) a.onReading(hop({ t: from + e * 0.1 + j * 0.025, rms: rmsFor(L) }));
  });
  return from + levels.length * 0.1;
}

test('an SPL sample is its 50 ms\'s RMS, each hop weighted by the time it covers', () => {
  const a = features();
  a.onReading(hop({ t: 0, rms: 0 }));
  a.onReading(hop({ t: 0.025, rms: 0.1 }));
  assert.deepStrictEqual([a.frame().spl.db, a.frame().spl.level], [0, -55], 'nothing measured yet reads as silence');
  a.onReading(hop({ t: 0.05, rms: 0.3 }));
  assert.strictEqual(a.frame().spl.level, 56, 'sqrt(0.05), not the 0.2 average (55)');
  assert.ok(Math.abs(a.frame().spl.db - (20 * Math.log10((Math.sqrt(0.05) * 32768) / 2e-6) - 80)) < 1e-9);
});

test('the first class is 100 ms in; a class is held by its stream time until the next', () => {
  const a = features();
  const seen = [];
  for (let i = 0; i < 20; i++) {
    a.onReading(hop({ t: i * HOP, rms: rmsFor(29) }));
    const { beat, eventT } = a.frame().spl;
    seen.push([+(i * HOP).toFixed(4), beat, eventT]);
  }
  assert.deepStrictEqual(seen.filter(([, beat]) => beat === null).map(([t]) => t), [0, 0.0116, 0.0232, 0.0348, 0.0464, 0.058, 0.0696, 0.0812, 0.0928]);
  assert.deepStrictEqual([...new Set(seen.map(([, , eventT]) => eventT))], [undefined, 0.1, 0.2]);
  assert.deepStrictEqual(seen.find(([t]) => t === 0.1972), [0.1972, 'soft', 0.1]);
});

test('under the soft floor is quiet, over the loud floor loud, on either floor soft', () => {
  // trigger 0: loud floor 15, soft floor 9.
  const at = (L) => { const a = features({ ldjTrigger: () => 0 }); classes(a, [L]); return a.frame().spl.beat; };
  assert.deepStrictEqual([8, 9, 15, 16].map(at), ['quiet', 'soft', 'soft', 'loud']);
  // trigger 10/65: 25 and 15.
  const at2 = (L) => { const a = features({ ldjTrigger: () => 10 / 65 }); classes(a, [L]); return a.frame().spl.beat; };
  assert.deepStrictEqual([14, 15, 25, 26].map(at2), ['quiet', 'soft', 'soft', 'loud']);
});

test('the section moves when the current class has its count over the last sixteen', () => {
  const a = features();
  const S = 29, L = 40, Q = 10;   // at trigger 0.30: soft, loud, quiet
  let t = classes(a, [S, S]);
  assert.strictEqual(a.frame().spl.section, null, 'two soft beats are no section yet');
  t = classes(a, [S], t, { anchor: false });
  assert.deepStrictEqual([a.frame().spl.beat, a.frame().spl.section], ['soft', 'soft']);
  t = classes(a, Array(10).fill(L), t, { anchor: false });
  assert.strictEqual(a.frame().spl.section, 'soft', 'ten loud beats in sixteen');
  t = classes(a, [L], t, { anchor: false });
  assert.strictEqual(a.frame().spl.section, 'loud');
  // A soft beat with four soft in the window: soft, though loud still has its eleven.
  t = classes(a, [S], t, { anchor: false });
  assert.deepStrictEqual([a.frame().spl.beat, a.frame().spl.section], ['soft', 'soft']);
  t = classes(a, Array(6).fill(Q), t, { anchor: false });
  assert.strictEqual(a.frame().spl.section, 'soft');
  classes(a, [Q], t, { anchor: false });
  assert.deepStrictEqual([a.frame().spl.beat, a.frame().spl.section], ['quiet', 'quiet']);
});

test('a trigger change decides the next class and keeps the history; level 29 is soft at 0.30, loud at 0.10', () => {
  let trigger = 0.3;
  const a = features({ ldjTrigger: () => trigger });
  const t = classes(a, [29, 29, 29]);
  const held = a.frame().spl;
  assert.deepStrictEqual([held.beat, held.section], ['soft', 'soft']);
  trigger = 0.1;
  assert.deepStrictEqual(a.frame().spl, held, 'a published class is not decided again');
  classes(a, [29], t, { anchor: false });
  assert.deepStrictEqual([a.frame().spl.beat, a.frame().spl.section], ['loud', 'soft']);
});

test('a gap of over half a second starts the classes again; a shorter one is heard as it was', () => {
  const a = features();
  let t = classes(a, [29, 29, 29]);
  a.onReading(hop({ t: t + 0.8, rms: rmsFor(29) }));
  assert.deepStrictEqual([a.frame().spl.beat, a.frame().spl.section, a.frame().spl.eventT], [null, null, undefined], 'no classes made up for the gap');
  a.onReading(hop({ t: t + 0.9, rms: rmsFor(29) }));
  assert.ok(Math.abs(a.frame().spl.eventT - (t + 0.9)) < 1e-9, '100 ms after the new anchor');

  const b = features();
  t = classes(b, [29]);
  b.onReading(hop({ t: t + 0.4, rms: rmsFor(29) }));
  assert.deepStrictEqual([b.frame().spl.beat, b.frame().spl.section], ['soft', 'soft'], 'four classes in one hop');
  assert.ok(Math.abs(b.frame().spl.eventT - (t + 0.4)) < 1e-9);
});

// ── Identity, freshness and latency ──────────────────────────────────────────

test('a repeated hop arriving later neither changes the analysis nor keeps the audio fresh', () => {
  let now = 0;
  const a = features({ now: () => now });
  a.onReading(hop({ t: 1, generation: 1, bands: [0, 0, 0, 2, 0] }));
  const first = a.frame();
  now = 400;
  a.onReading(hop({ t: 1, generation: 1, bands: [0, 0, 0, 2, 0] }));
  a.onReading(hop({ t: 0.9, generation: 1, bands: [0, 0, 0, 2, 0] }));
  assert.strictEqual(a.frame(), first, 'a repeat and a late line are not news');
  now = 600;
  assert.strictEqual(a.frame(), null);
});

test('a line from a replaced process is ignored; a new process is a new epoch with nothing held', () => {
  const a = features();
  let t = 0;
  for (; t < 0.31; t += 0.025) a.onReading(hop({ t, generation: 2, rms: rmsFor(29), bands: [0, 0, 0, 1e-3, 0] }));
  const old = a.frame();
  assert.strictEqual(old.spl.beat, 'soft');
  a.onReading(hop({ t: t + 0.025, generation: 1 }));
  assert.strictEqual(a.frame(), old, 'generation 1 is the process before');

  a.onReading(hop({ t: 0.0116, generation: 3, layout: undefined, rms: rmsFor(29), bands: [0, 0, 0, 1.52, 0] }));
  const f = a.frame();
  assert.strictEqual(f.generation, old.generation + 1);
  assert.deepStrictEqual([f.spl.beat, f.spl.section], [null, null], 'a true discontinuity: the classes start again');
  assert.strictEqual(f.disco.hit[0], true, 'and so does the history, from ones');
  assert.strictEqual(a.frame(0.005), null, 'the old process\'s frames are gone');
});

test('a hop without a generation that runs backwards is a restart', () => {
  const a = features();
  a.onReading(hop({ t: 5 }));
  a.onReading(hop({ t: 5.0116 }));
  const before = a.frame().generation;
  a.onReading(hop({ t: 0.0116 }));
  assert.deepStrictEqual([a.frame().t, a.frame().generation], [0.0116, before + 1]);
});

test('the frame for the aligned stream time comes from the recent hops; freshness goes by the newest arrival', () => {
  let now = 0;
  const a = features({ now: () => now });
  for (const t of [1.0, 1.1, 1.2]) { a.onReading(hop({ t })); now += 100; }
  assert.strictEqual(a.frame(1.1).t, 1.1);
  assert.strictEqual(a.frame(1.15).t, 1.1);
  assert.strictEqual(a.frame(0.9), null, 'nothing that early');
  assert.strictEqual(a.frame(5).t, 1.2, 'nothing later than the newest is made up');
  assert.strictEqual(a.frame().t, 1.2);
  now = 200 + 450;
  assert.strictEqual(a.frame(1.0).t, 1.0, 'an old hop of a fresh stream');
  now = 200 + 501;
  assert.strictEqual(a.frame(1.0), null);
});

test('recent hops are kept for 1.25 s of stream and 256 hops at most', () => {
  let a = features();
  for (let i = 0; i <= 150; i++) a.onReading(hop({ t: i * HOP }));
  const newest = 150 * HOP;
  assert.ok(a.frame(newest - 1.2), 'within 1.25 s');
  assert.strictEqual(a.frame(newest - 1.3), null);
  a = features();
  for (let i = 0; i < 300; i++) a.onReading(hop({ t: i / 1000 }));
  assert.strictEqual(a.frame(0.043), null, 'the oldest 44 are gone');
  assert.strictEqual(a.frame(0.044).t, 0.044);
});

test('a malformed spectrum is not heard, and what is published is always finite', () => {
  const a = features();
  for (const spectrum of [{ fftPower: -1 }, { bands: [0, 0, 0, NaN, 0] }, { rms: Infinity }, { bands: [0, 0, 0, 0] }, { power: -2 }]) {
    a.onReading({ ...hop({ t: 0 }), spectrum: { ...hop({ t: 0 }).spectrum, ...spectrum } });
  }
  a.onReading({ ...hop({ t: 0 }), spectrum: undefined });
  assert.strictEqual(a.frame(), null);
  a.onReading(hop({ t: 0, rms: 0, power: 0, fftPower: 0, dominantHz: null }));
  a.onReading(hop({ t: HOP, rms: 0, power: 0, fftPower: 0, dominantHz: null }));
  const numbers = [];
  JSON.stringify(a.frame(), (k, v) => { if (typeof v === 'number') numbers.push(v); return v; });
  assert.ok(numbers.length > 10 && numbers.every(Number.isFinite), JSON.stringify(a.frame()));
});

test('the band list follows the Disco bands in force, without repeats, and hands out a copy', () => {
  const bands = { ...DISCO_DEFAULTS.bands, bass: [20, 250] };
  const a = features({ disco: () => ({ bands, globals: DISCO_DEFAULTS.globals }) });
  const list = a.bandList();
  assert.deepStrictEqual(list, [[20, 250], [250, 3000], [3000, 9000], [750, 2000]]);
  list[0][0] = 99;
  assert.deepStrictEqual(a.bandList()[0], [20, 250]);
  // The bass shares the party bass's sum: index 0 of the reading.
  a.onReading(hop({ t: 0, bands: [10, 0, 0, 0] }));
  assert.strictEqual(a.frame().disco.level[0], 10);
});

/** A stand-in for the service's process: its stdin's lines land in `asked`. */
function standIn() {
  const proc = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), asked: [] });
  proc.stdin.on('data', (d) => proc.asked.push(...d.toString().split('\n').filter(Boolean).map((l) => JSON.parse(l))));
  proc.kill = () => { proc.killed = true; proc.emit('close', null); };
  return proc;
}

test('a band edit is sent to the running input, which carries on; a floor or a globals edit asks for nothing', async () => {
  const spawned = [];
  const procs = [];
  const live = new LiveInput({ now: () => 0, spawner: (exe, args) => { spawned.push(args); const p = standIn(); procs.push(p); return p; } });
  let d = disco();
  const a = features({ disco: () => d, onBands: () => { Promise.resolve().then(() => live.refreshBands()); } });
  live.useBands(() => a.bandList());
  live.onReading((r) => a.onReading(r));
  live.start({ source: 'loopback' });
  const line = (t) => JSON.stringify({ type: 'state', t, captured: t, beat: 0, bpm: 120, phase: 0, locked: true, energy: 0.1, onset: 0, flux: 0,
    rms: 0.1, tension: 0, bands: {}, spectrum: { power: 1, rms: 0.1, dominantHz: null, bands: [1, 1, 1, 1, 1], fftPower: 5 } });
  live.handleLine(line(1));
  const epoch = a.frame().generation;
  d = { ...d, bands: { ...d.bands, floorDb: [-60, -60, -60] } };
  live.handleLine(line(1.0116));
  d = { ...d, globals: { ...d.globals, sensitivity: 70 } };
  live.handleLine(line(1.0232));
  await settle();
  assert.deepStrictEqual([spawned.length, procs[0].asked, a.frame().t], [1, [], 1.0232], 'heard throughout, and nothing asked');

  d = { ...d, bands: { ...d.bands, bass: [0, 120] } };
  const edited = '20-250,250-3000,3000-9000,0-120,750-2000';
  live.handleLine(line(1.0348));
  live.handleLine(line(1.0464));
  await settle();
  assert.deepStrictEqual([spawned.length, procs[0].killed], [1, undefined], 'no restart');
  assert.deepStrictEqual(procs[0].asked, [{ type: 'bands', bands: edited }], 'asked once');
  assert.strictEqual(a.frame().t, 1.0232, 'the lines summed over the old bands were not heard');
  // The service takes the new list between two hops and says so.
  live.handleLine(JSON.stringify({ type: 'bands', bands: edited }));
  live.handleLine(line(1.058));
  assert.deepStrictEqual([a.frame().t, a.frame().generation], [1.058, epoch], 'the same stream, on the new bands');
  live.stop();
});

/**
 * A real live input feeding the features, its process a stand-in: the bands
 * come from the features, a band edit asks the input for them, as
 * integrations.ts wires them.
 */
function listening() {
  const spawned = [];
  const procs = [];
  const live = new LiveInput({ now: () => 0, spawner: (exe, args) => { spawned.push(args); const p = standIn(); procs.push(p); return p; } });
  const rig = { d: disco(), spawned, procs, live };
  rig.a = features({ disco: () => rig.d, onBands: () => { Promise.resolve().then(() => live.refreshBands()); } });
  live.useBands(() => rig.a.bandList());
  live.onReading((r) => rig.a.onReading(r));
  rig.line = (t, { power = 1e-3, rms = rmsFor(29) } = {}) => live.handleLine(JSON.stringify({
    type: 'state', t, captured: t, beat: 0, bpm: 120, phase: 0, locked: true, energy: rms, onset: 0, flux: 0, rms, tension: 0, bands: {},
    spectrum: { power, rms, dominantHz: null, bands: [1, 1, 1, 1, 1], fftPower: 5 },
  }));
  // Ninety hops 25 ms apart: a quiet Peak history and a soft section.
  rig.history = () => { for (let i = 0; i < 90; i++) rig.line(i * 0.025); };
  // The service's word that it sums the list it was last sent.
  rig.taken = () => { const asked = rig.procs.at(-1).asked; live.handleLine(JSON.stringify(asked.at(-1))); };
  return rig;
}
const settle = () => new Promise((r) => setImmediate(r));

test('a restart on another source, device or file starts every history again, even with the bands changed in it', async () => {
  // A power of 0.01 is a Peak hit against a quiet history of 0.001, not
  // against the ones it starts from; the soft section is kept or forgotten.
  const after = (rig, t = 0.0116) => { rig.line(t, { power: 0.01 }); const f = rig.a.frame(); return [f.disco.peakHit, f.spl.section]; };

  let rig = listening();
  rig.live.start({ source: 'loopback' });
  rig.history();
  assert.deepStrictEqual([rig.a.frame().disco.peakHit, rig.a.frame().spl.section], [false, 'soft']);
  rig.d = { ...rig.d, bands: { ...rig.d.bands, bass: [0, 120] } };
  rig.line(2.25);
  await settle();
  assert.strictEqual(rig.spawned.length, 1, 'a band edit alone restarts nothing');
  rig.taken();
  assert.deepStrictEqual(after(rig, 2.2616), [true, 'soft'], 'and keeps the histories the edit left');
  rig.live.stop();

  for (const other of [{ source: 'input', device: 'Line In' }, { source: 'file', file: '/music/a.wav' }]) {
    rig = listening();
    rig.live.start({ source: 'input', device: 'Mic' });
    rig.history();
    rig.d = { ...rig.d, bands: { ...rig.d.bands, bass: [0, 120] } };
    rig.live.start(other);
    assert.strictEqual(rig.spawned.length, 2);
    assert.ok(rig.spawned[1].join(' ').includes('--bands 20-250,250-3000,3000-9000,0-120,750-2000'), 'on the new bands');
    assert.deepStrictEqual(after(rig), [false, null], `${JSON.stringify(other)}: another stream of audio`);
    rig.live.stop();
  }
});

test('a process started for more than a band edit resets the histories even when only a later band edit is heard', () => {
  const old = KEY(LIST);
  const edited = KEY([[20, 250], [250, 3000], [3000, 9000], [0, 120], [750, 2000]]);
  const run = (between) => {
    let bands = DISCO_DEFAULTS.bands;
    const a = features({ disco: () => ({ bands, globals: DISCO_DEFAULTS.globals }), onBands: () => {} });
    for (let i = 0; i < 90; i++) a.onReading(hop({ t: i * 0.025, generation: 1, layout: old, cause: 'start', power: 1e-3, rms: rmsFor(29) }));
    bands = { ...DISCO_DEFAULTS.bands, bass: [0, 120] };
    // Lines of a process on another device, summed over the bands before the edit: not heard.
    for (const r of between) a.onReading(r);
    a.onReading(hop({ t: 0.0116, generation: 3, layout: edited, cause: 'bands', power: 0.01, rms: rmsFor(29) }));
    return [a.frame().disco.peakHit, a.frame().spl.section];
  };
  assert.deepStrictEqual(run([]), [true, 'soft'], 'band edits on the same input');
  assert.deepStrictEqual(run([hop({ t: 0.0116, generation: 2, layout: old, cause: 'input' })]), [false, null]);
  assert.deepStrictEqual(run([hop({ t: 0.0116, generation: 2, layout: old, cause: 'start' })]), [false, null], 'a restart after it died');
});

test('the hops handed to the effects never step back within an epoch, while the selector still answers any time', () => {
  let now = 0;
  const a = features({ now: () => now });
  for (const t of [1.0, 1.1, 1.2]) a.onReading(hop({ t, generation: 1, layout: KEY(LIST), cause: 'start' }));
  assert.strictEqual(a.heard(1.15).t, 1.1);
  // The latency raised, or the clock's least-delayed arrival gone: the
  // aligned time moves back, and the hop already handed out is held.
  assert.strictEqual(a.heard(0.95).t, 1.1, 'not 1.0, and not nothing');
  assert.strictEqual(a.heard(1.05).t, 1.1);
  assert.strictEqual(a.frame(1.05).t, 1.0, 'frame() is the plain selector');
  assert.strictEqual(a.heard(1.2).t, 1.2);
  a.onReading(hop({ t: 1.3, generation: 1, layout: KEY(LIST), cause: 'start' }));
  assert.strictEqual(a.heard(1.25).t, 1.2);
  assert.strictEqual(a.heard().t, 1.3, 'no time: the newest');
  assert.strictEqual(a.heard(1.25).t, 1.3);
  // A new stream counts from its own start: nothing of the old one holds it.
  a.onReading(hop({ t: 0.0116, generation: 2, layout: KEY(LIST), cause: 'start' }));
  a.onReading(hop({ t: 0.0232, generation: 2, layout: KEY(LIST), cause: 'start' }));
  assert.strictEqual(a.heard(0.0116).t, 0.0116);
  assert.strictEqual(a.heard(0.001), a.frame(0.0116), 'held in the new epoch');
  now = 600;
  assert.strictEqual(a.heard(0.0232), null, 'and stale is stale');
});

test('Neural\'s smoothers longer than the history count their unwritten zeros, without storing them', () => {
  const at = (smoothnessAnalyser, hops = 1) => {
    const a = features({ disco: () => ({ bands: DISCO_DEFAULTS.bands, globals: { ...DISCO_DEFAULTS.globals, smoothnessAnalyser } }) });
    for (let i = 0; i < hops; i++) a.onReading(hop({ t: i * HOP, rms: 0.1, dominantHz: 46 * BIN_HZ }));
    return a.frame().disco.neural;
  };
  // The first hop's ratio is 52.83 (the three-hop oracle above); a hundred
  // slots average it over a hundred, though only eighty are ever written.
  assert.strictEqual(at(100).amplitude, f32(f32(52.830204010009766) / 100));
  // Three hundred frequency slots, eighty of them 0.5: the lower median is a zero.
  assert.strictEqual(at(100, 80).mainFrequency, 0);
  assert.strictEqual(at(26, 80).mainFrequency, 0.5, '78 slots, all written');
  // A length no rig could hold is still a finite reading, at once.
  const huge = at(1e12, 2);
  assert.ok(Number.isFinite(huge.amplitude) && huge.amplitude >= 0 && huge.mainFrequency === 0, JSON.stringify(huge));
});

// ── Whose settings the detectors run on ──────────────────────────────────────

const visualizer = (trigger) => ({ kind: 'ldj.visualizer', params: { ...VISUALIZER_DEFAULTS, trigger } });
const voice = (id, spec, over = {}) => ({ id, spec, targets: null, tier: 'voice', launchSeq: 1, startedAtMs: 0, untilMs: null, ...over });
const resolve = (over) => resolveDetectors({ base: null, voices: [], nowMs: 1000, fixtureIds: [1, 2], ldjTrigger: 0.3, acknowledged: true, ...over });

test('with no Disco or Visualizer playing, the detectors run on the settings and Disco\'s defaults', () => {
  const d = resolve({ voices: [voice('pad', { kind: 'hd.twinkle', params: {} })] });
  assert.deepStrictEqual(d.spl, { owner: { from: 'fallback', id: null, kind: null }, trigger: 0.3 });
  assert.deepStrictEqual(d.disco.owner, { from: 'fallback', id: null, kind: null });
  assert.deepStrictEqual([d.disco.bands, d.disco.globals], [DISCO_DEFAULTS.bands, DISCO_DEFAULTS.globals]);
});

test('the highest relevant voice owns a detector, else the base look, each detector on its own', () => {
  const pop = DISCO_PRESETS.find((p) => p.id === 'hd.disco.pop').params;
  const base = { id: 'ldj.visualizer.firework', spec: visualizer(0.2) };
  let d = resolve({ base });
  assert.deepStrictEqual(d.spl, { owner: { from: 'base', id: 'ldj.visualizer.firework', kind: 'ldj.visualizer' }, trigger: 0.2 });
  assert.strictEqual(d.disco.owner.from, 'fallback', 'a Visualizer does not own Disco\'s detector');

  const voices = [
    voice('a', visualizer(0.1), { launchSeq: 3 }),
    voice('b', visualizer(0.5), { launchSeq: 5 }),
    voice('later', visualizer(0.6), { launchSeq: 9, startedAtMs: 2000 }),       // not started yet
    voice('gone', visualizer(0.7), { launchSeq: 9, untilMs: 1000 }),            // ended
    voice('empty', visualizer(0.8), { launchSeq: 9, targets: [] }),
    voice('elsewhere', visualizer(0.9), { launchSeq: 9, targets: [7] }),         // no such fixture
    voice('strobe', { kind: 'strobe', params: {} }, { launchSeq: 10, tier: 'strobe' }),
    voice('disco', { kind: 'hd.disco', params: pop }, { launchSeq: 2, targets: [2] }),
  ];
  d = resolve({ base, voices });
  assert.deepStrictEqual(d.spl, { owner: { from: 'voice', id: 'b', kind: 'ldj.visualizer' }, trigger: 0.5 });
  assert.deepStrictEqual(d.disco.owner, { from: 'voice', id: 'disco', kind: 'hd.disco' });
  assert.strictEqual(d.disco.bands, pop.bands);

  // The strobe tier outranks a later launch; a Visualizer without a trigger has its kind's.
  d = resolve({ voices: [voice('pad', visualizer(0.4), { launchSeq: 7 }), voice('s', { kind: 'ldj.visualizer', params: {} }, { launchSeq: 1, tier: 'strobe' })] });
  assert.deepStrictEqual([d.spl.owner.id, d.spl.trigger], ['s', VISUALIZER_DEFAULTS.trigger]);
  // On a tie, targeted beats the whole rig, then the later start, then the first listed.
  d = resolve({ voices: [voice('all', visualizer(0.1), { startedAtMs: 900 }), voice('one', visualizer(0.2), { targets: [1], startedAtMs: 100 })] });
  assert.strictEqual(d.spl.owner.id, 'one');
  d = resolve({ voices: [voice('early', visualizer(0.1), { startedAtMs: 100 }), voice('late', visualizer(0.2), { startedAtMs: 900 })] });
  assert.strictEqual(d.spl.owner.id, 'late');
  d = resolve({ voices: [voice('first', visualizer(0.1)), voice('second', visualizer(0.2))] });
  assert.strictEqual(d.spl.owner.id, 'first');
});

test('a Visualizer that cannot play without the acknowledgement owns nothing until it is given; the Disco needs none', () => {
  const pop = DISCO_PRESETS.find((p) => p.id === 'hd.disco.pop').params;
  const voices = [voice('pad', visualizer(0.1), { launchSeq: 2 }), voice('disco', { kind: 'hd.disco', params: pop })];
  const base = { id: 'ldj.visualizer.firework', spec: visualizer(0.2) };
  let d = resolve({ base, voices, acknowledged: false });
  assert.deepStrictEqual(d.spl, { owner: { from: 'fallback', id: null, kind: null }, trigger: 0.3 }, 'neither the voice nor the base plays');
  assert.deepStrictEqual(d.disco.owner, { from: 'voice', id: 'disco', kind: 'hd.disco' });
  // A Disco marked to flash fast needs it too.
  d = resolve({ voices: [voice('fast', { kind: 'hd.disco', params: pop, rapidFlash: true })], acknowledged: false });
  assert.strictEqual(d.disco.owner.from, 'fallback');
  d = resolve({ base, voices, acknowledged: true });
  assert.deepStrictEqual([d.spl.owner.id, d.spl.trigger], ['pad', 0.1]);
});

test('a Visualizer that owns the classes decides them with its trigger', () => {
  let voices = [];
  const owner = () => resolve({ voices });
  const a = features({ ldjTrigger: () => owner().spl.trigger });
  let t = classes(a, [29]);
  assert.strictEqual(a.frame().spl.beat, 'soft', 'the fallback 0.30');
  voices = [voice('pad', visualizer(0.1))];
  t = classes(a, [29], t, { anchor: false });
  assert.strictEqual(a.frame().spl.beat, 'loud', 'the voice\'s 0.10');
  voices = [voice('pad', visualizer(0.1), { untilMs: 500 })];
  classes(a, [29], t, { anchor: false });
  assert.strictEqual(a.frame().spl.beat, 'soft', 'back to the fallback once it has ended');
});

// ── Containers: the child playing now decides ───────────────────────────────

const pop = () => DISCO_PRESETS.find((p) => p.id === 'hd.disco.pop').params;
const twinkle = { kind: 'hd.twinkle', params: {} };
const macroOf = (steps, loopBeats) => validateSpec({ kind: 'macro', params: { steps: steps.map(([effect, beats]) => ({ effect, beats })), loopBeats } });
const tableOf = (lanes, clips) => ({
  revision: 0, lanes: lanes.map((id) => ({ id, kind: 'shared', name: id, mute: false, solo: false })),
  clips: clips.map(([id, laneId, spec, startBeat, lengthBeats]) => ({ id, laneId, fixtureIds: null, startBeat, lengthBeats, loopBeats: lengthBeats,
    spec: validateSpec(spec), seed: seedFrom(id), mute: false })),
});
const bundleOf = (table, lengthBeats = 8, once = false) => bundleSpec({ patternId: 'p', lengthBeats, table }, once);
// A voice as the voices hand it out, anchored on its launch beat.
const pad = (id, spec, over = {}) => voice(id, spec, { anchorBeat: 0, ...over });

test('a macro owns Disco\'s detector only while its Disco step plays, with that step\'s bands', () => {
  const m = macroOf([[twinkle, 4], [{ kind: 'hd.disco', params: pop() }, 4]], 8);
  const at = (beatPos, anchorBeat = 0) => resolve({ beatPos, voices: [pad('pad', m, { anchorBeat })] }).disco;
  assert.deepStrictEqual(at(2).owner, { from: 'fallback', id: null, kind: null });
  assert.deepStrictEqual(at(2).bands, DISCO_DEFAULTS.bands);
  assert.deepStrictEqual(at(5).owner, { from: 'voice', id: 'pad', kind: 'hd.disco' });
  assert.deepStrictEqual([at(5).bands, at(5).globals], [pop().bands, pop().globals]);
  assert.strictEqual(at(9).owner.from, 'fallback', 'the next lap starts on the first step');
  assert.strictEqual(at(4.5, 1).owner.from, 'fallback', 'counted from the voice\'s own anchor');
  assert.strictEqual(at(5, 1).owner.from, 'voice');
  // Without a position no step is known, so the macro owns nothing.
  assert.strictEqual(resolve({ voices: [pad('pad', m)] }).disco.owner.from, 'fallback');
});

test('a pattern bundle owns the Visualizer\'s trigger while a Visualizer clip covers the position, highest lane first', () => {
  const b = bundleOf(tableOf(['shared:0', 'shared:1'], [['a', 'shared:0', visualizer(0.2), 0, 4], ['b', 'shared:1', visualizer(0.7), 2, 1]]));
  const at = (beatPos) => resolve({ beatPos, voices: [pad('pad:1', b)] }).spl;
  assert.deepStrictEqual(at(1), { owner: { from: 'voice', id: 'pad:1', kind: 'ldj.visualizer' }, trigger: 0.2 });
  assert.strictEqual(at(2.5).trigger, 0.7);
  assert.deepStrictEqual(at(5), { owner: { from: 'fallback', id: null, kind: null }, trigger: 0.3 });
  assert.strictEqual(at(9).trigger, 0.2, 'held, the pattern laps');
  const once = bundleOf(tableOf(['shared:0'], [['a', 'shared:0', visualizer(0.2), 0, 8]]), 8, true);
  assert.strictEqual(resolve({ beatPos: 9, voices: [pad('pad:1', once)] }).spl.owner.from, 'fallback', 'once stops at its length');
});

test('a container\'s child takes the normal voice priority: a higher plain voice of the kind still wins', () => {
  const m = macroOf([[{ kind: 'hd.disco', params: pop() }, 4]], 4);
  const plain = voice('plain', { kind: 'hd.disco', params: {} }, { launchSeq: 5 });
  let d = resolve({ beatPos: 1, voices: [pad('macro', m, { launchSeq: 3 }), plain] }).disco;
  assert.deepStrictEqual([d.owner.id, d.bands], ['plain', DISCO_DEFAULTS.bands]);
  d = resolve({ beatPos: 1, voices: [pad('macro', m, { launchSeq: 9 }), plain] }).disco;
  assert.deepStrictEqual([d.owner.id, d.bands], ['macro', pop().bands]);
  // A container whose child is another kind does not seize the detector from a lower voice.
  d = resolve({ beatPos: 1, voices: [pad('macro', macroOf([[twinkle, 4]], 4), { launchSeq: 9 }), plain] }).disco;
  assert.strictEqual(d.owner.id, 'plain');
});

test('a child that needs the photosensitivity acknowledgement owns nothing while it is not given', () => {
  const m = macroOf([[visualizer(0.6), 4]], 4);
  const b = bundleOf(tableOf(['shared:0'], [['a', 'shared:0', visualizer(0.6), 0, 8]]));
  for (const spec of [m, b]) {
    assert.strictEqual(resolve({ beatPos: 1, acknowledged: false, voices: [pad('pad', spec)] }).spl.owner.from, 'fallback', spec.kind);
    assert.strictEqual(resolve({ beatPos: 1, acknowledged: true, voices: [pad('pad', spec)] }).spl.trigger, 0.6, spec.kind);
  }
});

test('nested containers resolve to the leaf playing now, for a voice, a sequence clip and the base alike', () => {
  const m = macroOf([[twinkle, 2], [{ kind: 'hd.disco', params: pop() }, 2]], 4);
  const b = bundleOf(tableOf(['shared:0'], [['m', 'shared:0', m, 0, 8]]));
  const at = (beatPos) => resolve({ beatPos, voices: [pad('pad:1', b)] }).disco.owner.from;
  assert.deepStrictEqual([1, 3, 5, 7].map(at), ['fallback', 'voice', 'fallback', 'voice']);
  // A sequence clip carries the position it was placed at and its lap's anchor.
  const clip = (beatPos) => resolve({ clips: [{ id: 'c', spec: m, anchorBeat: 8, beatPos }] }).disco.owner;
  assert.deepStrictEqual([clip(9).from, clip(11)], ['fallback', { from: 'clip', id: 'c', kind: 'hd.disco' }]);
  const base = (beatPos) => resolve({ beatPos, base: { id: 'look', spec: m, anchorBeat: 0 } }).disco.owner.from;
  assert.deepStrictEqual([base(1), base(3)], ['fallback', 'base']);
});
