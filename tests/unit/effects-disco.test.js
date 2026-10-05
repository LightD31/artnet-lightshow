import test from 'node:test';
import assert from 'node:assert/strict';
import { DISCO_DEFAULTS, DISCO_PRESETS, assignDiscoBands, hdAutoStrobeFlash, hdHsbToColour } from '../../src/shared/effects/disco.ts';
import { kindOf, requiresAcknowledgement, validateSpec } from '../../src/shared/effects/registry.ts';
import { renderEffect } from '../../src/shared/effects/render.ts';
import { EffectStepper } from '../../src/shared/effects/stepper.ts';
import { HD_MASTER_DEFAULTS } from '../../src/shared/effects/types.ts';
import { seedFrom } from '../../src/shared/effects/hash.ts';
import { parseHex } from '../../src/shared/effects/palette.ts';
import { BAND_HZ_MAX, BIN_HZ, bandBins, perBinFloorDb } from '../../src/shared/spectrum-bands.ts';
import { harness, row } from '../helpers/ldj-harness.js';

// Levels are Hue brightness bytes over 254; colours are full-scale RGB.
const L = (bri) => bri / 254;
const C = (r, g, b) => ({ r, g, b, w: 0, a: 0, uv: 0 });
const WHITE = C(255, 255, 255);
const close = (actual, expected, message = '') => assert.ok(Math.abs(actual - expected) < 1e-9, `${message} ${actual} ≠ ${expected}`);
const channels = (over = {}) => DISCO_DEFAULTS.channels.map((c, i) => ({ ...c, ...(over[i] ?? {}) }));
const hop = (t, { hit = [false, false, false], peakHit = false, mainFrequency = 0, amplitude = 0, generation } = {}) => ({
  t, ...(generation === undefined ? {} : { generation }), rms: 0, power: 0, dominantHz: null, party: { full: 0, bass: 0, mid: 0, high: 0 },
  disco: { hit, gate: [0, 0, 0], level: [0, 0, 0], peakHit, neural: { mainFrequency, amplitude } },
  spl: { db: -80, level: -51, beat: null, section: null },
});
const quiet = (nowMs, over = {}) => ({ nowMs, beatPos: nowMs / 500, ...over });
const live = (nowMs, audio, over = {}) => quiet(nowMs, { audio, audioMode: 'reactive', ...over });
const disco = (room, params = {}, options = {}) => harness('hd.disco', room, { params, seed: 'disco', ...options });
const lit = (out) => out.flatMap((s, i) => s.level > 0 ? [i] : []);
const full = (out) => out.flatMap((s, i) => s.level === 1 ? [i] : []);
const hueOf = ({ r, g, b }) => {
  const max = Math.max(r, g, b), d = max - Math.min(r, g, b);
  if (!d) return 0;
  const h = max === r ? (g - b) / d : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
};
const BASS = [true, false, false], TREBLE = [false, false, true], BASS_TREBLE = [true, false, true], ALL = [true, true, true];
// Spectrum releases from full to the default fade floor; `k` is the fraction of the fall done.
const falling = (k) => 1 + (L(40) - 1) * k;

test('the defaults carry all five channels, the globals and the bands with their floors', () => {
  const shared = { enabled: true, fadeBrightness: 40, fadeSaturation: 255, useAmbience: false, palette: null, strobeOn: false, linkLights: false };
  assert.deepEqual(DISCO_DEFAULTS.channels, [
    { fade: true, allowPulse: true, minHue: 0, maxHue: 10000, idleFadeBrightness: 254, sequenceLength: 8, modulateSaturation: false },
    { fade: false, allowPulse: false, minHue: 0, maxHue: 60000, idleFadeBrightness: 254, sequenceLength: 8, modulateSaturation: false },
    { fade: true, allowPulse: false, minHue: 38000, maxHue: 52000, idleFadeBrightness: 254, sequenceLength: 8, modulateSaturation: false },
    { fade: true, allowPulse: true, minHue: 0, maxHue: 60000, idleFadeBrightness: 140, sequenceLength: 16, modulateSaturation: false },
    { fade: true, allowPulse: true, minHue: 24800, maxHue: 65534, idleFadeBrightness: 140, sequenceLength: 16, modulateSaturation: true },
  ].map((c) => ({ ...shared, ...c })));
  assert.deepEqual(DISCO_DEFAULTS.globals, { sensitivity: 50, advancedDecay: 25, smoothness: 500, minimumThreshold: 2, simpleSensitivity: 44,
    simpleDecay: 20, simpleMinimumThreshold: 30, analyserSensitivity: 50, smoothnessAnalyser: 3 });
  const { floorDb, ...edges } = DISCO_DEFAULTS.bands;
  assert.deepEqual(edges, { bass: [0, 160], voice: [750, 2000], treble: [3000, 9000] });
  // 8, 59 and 279 bins of 22050/1024 Hz sharing a total floor of 2/200000.
  [-59.03089986991944, -67.70852011642144, -74.45604203273598].forEach((db, i) => close(floorDb[i], db, `band ${i}`));
  assert.equal(DISCO_DEFAULTS.style, 'spectrum');
  assert.equal(DISCO_DEFAULTS.allowStrobe, false);
  assert.deepEqual(DISCO_DEFAULTS.strobe, { palette: ['#FFFFFF'], flashesPerSecond: 2 });
  assert.deepEqual(DISCO_DEFAULTS.assign, {});
  assert.equal(DISCO_DEFAULTS.smoothness, 500);
  assert.equal(DISCO_DEFAULTS.maxLightsPerBatch, 10);
  const spec = validateSpec({ kind: 'hd.disco' });
  assert.deepEqual(spec.params, DISCO_DEFAULTS);
  assert.deepEqual(validateSpec(spec), spec);
  assert.equal(kindOf('hd.disco').app, 'hd');
  assert.equal(kindOf('hd.disco').stateful, true);
});

test('the kind never needs the acknowledgement as a whole: its automatic strobe is gated inside it', () => {
  const strobing = { allowStrobe: true, channels: channels({ 3: { strobeOn: true } }) };
  assert.equal(requiresAcknowledgement(validateSpec({ kind: 'hd.disco', params: strobing })), false);
  const h = disco(row(3), strobing, { acknowledged: false });
  h.draw(quiet(0));
  assert.equal(h.draw(live(100, hop(1, { hit: BASS })))[0].level, 1, 'music plays unacknowledged');
});

test('band bins: a 22050/1024 Hz grid, never fewer than two bins, Nyquist included', () => {
  assert.equal(BIN_HZ, 22050 / 1024);
  assert.equal(BAND_HZ_MAX, 11025);
  assert.deepEqual(bandBins(0, 1), { lower: 0, upper: 1, count: 2 });
  assert.deepEqual(bandBins(11024, 11025), { lower: 511, upper: 512, count: 2 });
  assert.deepEqual(bandBins(0, 160), { lower: 0, upper: 7, count: 8 });
  assert.deepEqual(bandBins(4000, 11025), { lower: 185, upper: 512, count: 328 });
  close(perBinFloorDb(1e-5, 0, 1), -53.01029995663981);
});

test('band edges must ascend within 0..11025 Hz; nothing is clamped', () => {
  const withBands = (over) => ({ kind: 'hd.disco', params: { bands: { ...DISCO_DEFAULTS.bands, ...over } } });
  for (const bad of [[0, 11026], [300, 200], [100, 100], [-1, 100], [4000, 12000]]) {
    assert.throws(() => validateSpec(withBands({ treble: bad })), /11025/, JSON.stringify(bad));
  }
  for (const bad of [[NaN, 100], [0, Infinity], [100], [0, 100, 200]]) assert.throws(() => validateSpec(withBands({ bass: bad })), String(bad));
  const edge = validateSpec(withBands({ bass: [0, 1], treble: [11024, 11025] })).params.bands;
  assert.deepEqual([edge.bass, edge.treble], [[0, 1], [11024, 11025]]);
  // Overlapping and narrow bands are allowed: the edges only have to ascend.
  assert.doesNotThrow(() => validateSpec(withBands({ bass: [100, 3000], voice: [200, 210] })));
  for (const floorDb of [[1, -60, -70], [-121, -60, -70], [-60, -70]]) assert.throws(() => validateSpec(withBands({ floorDb })), JSON.stringify(floorDb));
});

test('the schema rejects what the app cannot play', () => {
  const bad = [
    { style: 'strobe' }, { channels: channels().slice(0, 4) }, { channels: channels({ 0: { minHue: 20000, maxHue: 10000 } }) },
    { channels: channels({ 1: { maxHue: 65536 } }) }, { channels: channels({ 2: { fadeBrightness: 255 } }) },
    { channels: channels({ 3: { idleFadeBrightness: -1 } }) }, { channels: channels({ 4: { sequenceLength: 0 } }) },
    { channels: channels({ 0: { palette: ['red'] } }) }, { channels: channels({ 0: { unknown: true } }) },
    { strobe: { palette: [] } }, { strobe: { palette: Array(7).fill('#FFFFFF') } }, { strobe: { flashesPerSecond: 6 } },
    { strobe: { flashesPerSecond: 0 } }, { assign: { 7: 'peak' } }, { maxLightsPerBatch: 0 }, { smoothness: -1 },
    { globals: { sensitivity: -5 } }, { unknown: 1 },
  ];
  for (const params of bad) assert.throws(() => validateSpec({ kind: 'hd.disco', params }), JSON.stringify(params));
  const ok = validateSpec({ kind: 'hd.disco', params: { assign: { 7: 'treble' }, strobe: { flashesPerSecond: 5 } } }).params;
  assert.deepEqual(ok.assign, { 7: 'treble' });
  assert.deepEqual(ok.strobe, { palette: ['#FFFFFF'], flashesPerSecond: 5 });
});

test('lamps are assigned to the enabled band with the fewest lamps, ties Bass < Voice < Treble; a manual assignment wins', () => {
  const on = [true, true, true];
  assert.deepEqual(assignDiscoBands(['1', '2', '3', '4', '5', '6'], {}, on), [0, 1, 2, 0, 1, 2]);
  // A fixture's cells share its id and its manual band; the others balance around them.
  assert.deepEqual(assignDiscoBands(['200', '200', '17', '99'], { 200: 'treble' }, on), [2, 2, 0, 1]);
  assert.deepEqual(assignDiscoBands(['17', '200', '99', '200'], { 200: 'treble' }, on), [0, 2, 1, 2]);
  assert.deepEqual(assignDiscoBands(['1', '2', '3', '4'], { 1: 'bass', 2: 'bass' }, on), [0, 0, 1, 2]);
  // A manual band that is switched off keeps its lamp dark rather than moving it.
  assert.deepEqual(assignDiscoBands(['17', '1', '2', '3'], { 17: 'voice' }, [true, false, true]), [-1, 0, 2, 0]);
  assert.deepEqual(assignDiscoBands(['1', '2'], {}, [false, false, false]), [-1, -1]);
  assert.deepEqual(assignDiscoBands([], {}, on), []);

  // In the kind, fixture ids come with the frame; without them each slot is its own fixture.
  const ids = [200, 200, 17, 99];
  const h = disco(row(4), { assign: { 200: 'treble' } });
  h.draw(quiet(0, { fixtureIds: ids }));
  assert.deepEqual(lit(h.draw(live(100, hop(1, { hit: TREBLE }), { fixtureIds: ids }))), [0, 1]);
  // A changed layout reassigns: fixture 200 now sits in slots 1 and 3.
  assert.deepEqual(full(h.draw(live(300, hop(2, { hit: TREBLE }), { fixtureIds: [17, 200, 99, 200] }))), [1, 3]);
});

test('a bass hit lights up to three random bass lamps at full in a hue from the band\'s range, transition 0', () => {
  const h = disco(row(15));
  h.draw(quiet(0));
  const out = h.draw(live(100, hop(1, { hit: BASS })));
  const on = lit(out);
  assert.equal(on.length, 3);
  for (const i of on) {
    assert.equal(i % 3, 0, `slot ${i} plays bass`);
    assert.equal(out[i].level, 1);
    assert.deepEqual(out[i].colour, out[on[0]].colour, 'one colour for the batch');
  }
  // Bass hues 0..10000 are 0..54 degrees: red through orange to yellow.
  const { r, b } = out[on[0]].colour;
  assert.ok(r === 255 && b === 0 && hueOf(out[on[0]].colour) <= 55, JSON.stringify(out[on[0]].colour));
  assert.ok(out.every((s) => s.strength === 1), 'Disco owns every lamp, dark ones too');
});

test('the batch is the per-hit cap shared by the enabled bands, empty ones included, at least one lamp', () => {
  const assign = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [i, 'bass']));
  const count = (params) => {
    const h = disco(row(12), { assign, ...params });
    h.draw(quiet(0));
    return lit(h.draw(live(100, hop(1, { hit: BASS })))).length;
  };
  assert.equal(count({}), 3, 'three bands, voice and treble empty: 10 / 3');
  assert.equal(count({ channels: channels({ 2: { enabled: false } }) }), 5);
  assert.equal(count({ channels: channels({ 1: { enabled: false }, 2: { enabled: false } }) }), 10);
  assert.equal(count({ maxLightsPerBatch: 2 }), 1);
});

test('the look palette does not replace the band ranges', () => {
  const h = disco(row(3));
  h.draw(quiet(0));
  // Treble hues 38000..52000 are 208..285 degrees, far from the look's red and cyan.
  const hue = hueOf(h.draw(live(100, hop(1, { hit: TREBLE })))[2].colour);
  assert.ok(hue >= 207 && hue <= 286, String(hue));
});

test('with Fade the hit lamps fall to fadeBrightness over max(T + smoothness − 500, 0) ms after a 32 ms delay; Voice (fade off) holds', () => {
  // One lamp per band: slot 0 bass, 1 voice, 2 treble.
  const h = disco(row(3));
  h.draw(quiet(0));
  const hit = h.draw(live(100, hop(1, { hit: [true, true, false] })));
  assert.deepEqual([hit[0].level, hit[1].level], [1, 1]);
  assert.equal(h.draw(quiet(132))[0].level, 1);
  // T = 100 ms since launch: a 100 ms fall.
  close(h.draw(quiet(182))[0].level, L(147));
  const low = h.draw(quiet(232))[0];
  close(low.level, L(40));
  assert.deepEqual(low.colour, hit[0].colour, 'fadeSaturation 255 keeps the colour');
  // T = 1000 ms: a 1000 ms fall.
  h.draw(live(1100, hop(2, { hit: BASS })));
  assert.equal(h.draw(quiet(1132))[0].level, 1);
  close(h.draw(quiet(1632))[0].level, L(147));
  assert.equal(h.draw(quiet(2000))[1].level, 1, 'voice holds');
  close(h.draw(quiet(2132))[0].level, L(40));

  // A render that skips the deadline still sees the fall as it ran.
  const sparse = disco(row(3));
  sparse.draw(quiet(0));
  sparse.draw(live(100, hop(1, { hit: BASS })));
  close(sparse.draw(quiet(250))[0].level, L(40));

  // Smoothness 300 shortens the fall by 200 ms; T is capped at 1400 ms.
  const smooth = disco(row(3), { smoothness: 300 });
  smooth.draw(quiet(0));
  smooth.draw(live(100, hop(1, { hit: BASS })));
  close(smooth.draw(quiet(132))[0].level, L(40), 'max(100 − 200, 0) = 0 ms');
  smooth.draw(live(3100, hop(2, { hit: BASS })));
  close(smooth.draw(quiet(3732))[0].level, L(147), 'min(3000, 1400) − 200 = 1200 ms');
});

test('a channel accepts a second hit only 100 ms after the first, counted from launch', () => {
  const h = disco(row(3));
  h.draw(quiet(0));
  assert.equal(h.draw(live(99, hop(1, { hit: BASS })))[0].level, 0, 'within 100 ms of launch');
  assert.equal(h.draw(live(100, hop(1, { hit: BASS })))[0].level, 0, 'the same hop again is not a new hit');
  assert.equal(h.draw(live(100, hop(2, { hit: BASS })))[0].level, 1);
  close(h.draw(live(199, hop(3, { hit: BASS })))[0].level, falling(0.67), 'refused: the fall goes on');
  assert.equal(h.draw(live(200, hop(4, { hit: BASS })))[0].level, 1);
  // T counts from the hit accepted at 100, not from the refused one at 199.
  close(h.draw(quiet(282))[0].level, L(147));
});

test('one hop is one hit: holding it, or switching to reactive while it is held, never fires again', () => {
  const h = disco(row(3));
  h.draw(quiet(0));
  h.draw(live(100, hop(1, { hit: BASS })));
  for (let t = 150; t <= 500; t += 50) h.draw(live(t, hop(1, { hit: BASS })));
  close(h.draw(live(500, hop(1, { hit: BASS })))[0].level, L(40));
  // Heard first in tempo mode, a hop stays heard.
  h.draw(quiet(600, { audio: hop(2, { hit: BASS }), audioMode: 'tempo' }));
  close(h.draw(live(650, hop(2, { hit: BASS })))[0].level, L(40));
  assert.equal(h.draw(live(700, hop(3, { hit: BASS })))[0].level, 1);
  // The same stream time in a new feature epoch is a new hop.
  assert.equal(h.draw(live(800, hop(3, { hit: BASS, generation: 1 })))[0].level, 1);
  close(h.draw(live(900, hop(3, { hit: BASS, generation: 1 })))[0].level, falling(0.68));
  // A hop without a valid time never hits.
  close(h.draw(live(1000, hop(NaN, { hit: BASS })))[0].level, L(40));
  // Off and tempo modes ignore hits.
  close(h.draw(quiet(1100, { audio: hop(11, { hit: BASS }), audioMode: 'off' }))[0].level, L(40));
  close(h.draw(quiet(1200, { audio: hop(12, { hit: BASS }), audioMode: 'tempo' }))[0].level, L(40));
});

test('after 2 s without a hit a random batch idles to idleFadeBrightness over 2000 ms, every 2 s', () => {
  const h = disco(row(15));
  h.draw(quiet(0));
  assert.deepEqual(lit(h.draw(quiet(1999))), []);
  assert.deepEqual(lit(h.draw(quiet(2000))), [], 'the idle transition starts from dark');
  const half = h.draw(quiet(3000)), first = lit(half);
  assert.equal(first.length, 9);
  for (const band of [0, 1, 2]) assert.equal(first.filter((i) => i % 3 === band).length, 3, `band ${band}`);
  for (const i of first) close(half[i].level, 0.5);
  const top = h.draw(quiet(4000));
  for (const i of first) assert.equal(top[i].level, 1);
  // The next batch starts at 4000.
  const next = h.draw(quiet(5000));
  assert.ok(lit(next).some((i) => !first.includes(i) && Math.abs(next[i].level - 0.5) < 1e-9), 'a new lamp is halfway up');
});

test('a sparse render idles at its own time, without replaying the idles it missed', () => {
  const h = disco(row(3));
  h.draw(quiet(0));
  assert.equal(h.draw(quiet(5000))[0].level, 0);
  close(h.draw(quiet(6000))[0].level, 0.5);
  assert.equal(h.draw(quiet(7000))[0].level, 1);
});

test('the sequence wraps at sequenceLength and toggles pulse mode when allowed (T = 200 ms)', () => {
  // Hits 300 ms apart: 100 ms into a fall, an ordinary one (T = 300) and a pulse (200) differ.
  const normal = falling(1 / 3), pulse = L(147), first = L(40);
  const run = (over) => {
    const h = disco(row(3), { channels: channels({ 0: over }) });
    h.draw(quiet(0));
    return [100, 400, 700, 1000, 1300, 1600].map((t, k) => {
      h.draw(live(t, hop(k + 1, { hit: BASS })));
      return h.draw(quiet(t + 132))[0].level;
    });
  };
  const expect = (levels, wanted) => levels.forEach((level, k) => close(level, wanted[k], `hit ${k + 1}`));
  // The first hit has T = 100: its fall is over by +132.
  expect(run({ sequenceLength: 3 }), [first, normal, pulse, pulse, pulse, normal]);
  expect(run({ sequenceLength: 3, allowPulse: false }), [first, normal, normal, normal, normal, normal]);
  // The counter steps before the wrap test: a length of one toggles on every hit.
  expect(run({ sequenceLength: 1 }), [pulse, normal, pulse, normal, pulse, normal]);

  // An idle resets the sequence and leaves pulse mode.
  const h = disco(row(3), { channels: channels({ 0: { sequenceLength: 3 } }) });
  h.draw(quiet(0));
  [100, 400, 700].forEach((t, k) => h.draw(live(t, hop(k + 1, { hit: BASS }))));
  h.draw(quiet(2700));
  h.draw(live(3000, hop(4, { hit: BASS })));
  close(h.draw(quiet(3132))[0].level, falling(100 / 1400), 'an ordinary fall with T capped at 1400');
});

test('peak style uses channel 3: one random lamp per peak hit, held 100 ms then released; with fade off it holds; linkLights sends the whole group', () => {
  const h = disco(row(4), { style: 'peak' });
  h.draw(quiet(0));
  const on = lit(h.draw(live(100, hop(1, { peakHit: true }))));
  assert.equal(on.length, 1);
  const [i] = on;
  assert.equal(h.draw(quiet(200))[i].level, 1);
  close(h.draw(quiet(350))[i].level, L(147), '300 ms release');
  close(h.draw(quiet(500))[i].level, L(40));
  assert.deepEqual(lit(h.draw(live(600, hop(2, { hit: ALL })))), [i], 'Spectrum hits mean nothing here');

  // Fade off holds the lamp at full: it is not switched off after 100 ms.
  const hold = disco(row(4), { style: 'peak', channels: channels({ 3: { fade: false } }) });
  hold.draw(quiet(0));
  const [j] = lit(hold.draw(live(100, hop(1, { peakHit: true }))));
  for (const t of [200, 300, 1000, 2099]) assert.equal(hold.draw(quiet(t))[j].level, 1, `${t}`);

  // Pulse mode keeps the hold and shortens the fall to 200 ms.
  const pulse = disco(row(4), { style: 'peak', channels: channels({ 3: { sequenceLength: 1 } }) });
  pulse.draw(quiet(0));
  const [k] = lit(pulse.draw(live(100, hop(1, { peakHit: true }))));
  assert.equal(pulse.draw(quiet(200))[k].level, 1);
  close(pulse.draw(quiet(300))[k].level, L(147));
  close(pulse.draw(quiet(400))[k].level, L(40));

  const link = disco(row(4), { style: 'peak', channels: channels({ 3: { linkLights: true } }) });
  link.draw(quiet(0));
  assert.deepEqual(full(link.draw(live(100, hop(1, { peakHit: true })))), [0, 1, 2, 3]);

  const off = disco(row(4), { style: 'peak', channels: channels({ 3: { enabled: false } }) });
  off.draw(quiet(0));
  assert.deepEqual(lit(off.draw(live(100, hop(1, { peakHit: true })))), []);
  assert.deepEqual(lit(off.draw(quiet(3000))), [], 'a disabled channel does not idle either');
});

test('peak hits postpone the idle; the idle washes the whole group, however large', () => {
  const h = disco(row(4), { style: 'peak' });
  h.draw(quiet(0));
  h.draw(live(100, hop(1, { peakHit: true })));
  h.draw(live(1500, hop(2, { peakHit: true })));
  assert.ok(lit(h.draw(quiet(2500))).length <= 2, 'no idle two seconds after launch');
  assert.ok(lit(h.draw(quiet(3499))).length <= 2, 'nor before two seconds after the last hit');
  h.draw(quiet(3500));
  assert.equal(lit(h.draw(quiet(4500))).length, 4, 'idle from 3500');

  const big = disco(row(12), { style: 'peak' });
  big.draw(quiet(0));
  big.draw(quiet(2000));
  const out = big.draw(quiet(3000));
  assert.equal(lit(out).length, 12);
  for (const s of out) close(s.level, L(70));
  // Peak idles do not share one colour forever: the next wash picks a new one.
  const a = big.draw(quiet(4000))[0].colour, b = big.draw(quiet(6000))[0].colour;
  assert.notDeepEqual(a, b);
});

test('neural style uses channel 4: hue from mainFrequency across minHue..maxHue, brightness 254·amplitude, sat = bri when modulating', () => {
  const h = disco(row(3), { style: 'neural' });
  h.draw(quiet(0));
  const reading = (t, mainFrequency, amplitude) => h.draw(live(t, hop(t, { mainFrequency, amplitude })));
  const check = (out, colour, level, message) => out.forEach((s) => { assert.deepEqual(s.colour, colour, message); close(s.level, level, message); });
  // 24800 + 40734 · 0.5 = 45167 → 248°; amplitude .5 → bri 127, saturation 127/254.
  check(reading(10, 0.5, 0.5), C(144, 127, 255), L(127), 'middle');
  check(reading(20, 0, 1), C(0, 255, 67), 1, 'minHue: 136°');
  check(reading(30, 1, 1), C(255, 0, 4), 1, 'maxHue: 359°');
  // The app multiplies in 32-bit floats: these differ from double arithmetic.
  check(reading(40, 1414 / 40734, 1), C(0, 255, 101), 1, 'hue 26214, not 26213');
  check(reading(50, 0, 0.003937007874015747), C(253, 255, 254), L(1), 'bri 1, not 0');
  // Out-of-range and non-finite readings clamp.
  check(reading(60, 7, 2), C(255, 0, 4), 1, 'clamped high');
  check(reading(70, NaN, -1), WHITE, 0, 'clamped low');
  const before = reading(80, 0.5, 0.5);
  assert.deepEqual(h.draw(live(90, hop(NaN, { mainFrequency: 1, amplitude: 1 }))), before, 'a hop without a valid time changes nothing');

  // A fixed hue: the amplitude sets saturation and level separately.
  const fixed = disco(row(1), { style: 'neural', channels: channels({ 4: { minHue: 32768, maxHue: 32768 } }) });
  fixed.draw(quiet(0));
  check(fixed.draw(live(10, hop(1, { mainFrequency: 0.3, amplitude: 0.5 }))), C(127, 255, 255), 0.5);
  const flat = disco(row(1), { style: 'neural', channels: channels({ 4: { minHue: 32768, maxHue: 32768, modulateSaturation: false } }) });
  flat.draw(quiet(0));
  check(flat.draw(live(10, hop(1, { mainFrequency: 0.3, amplitude: 0.5 }))), C(0, 255, 255), 0.5);
  // Ambience picks entry floor((n − 1) · frequency) and keeps only its hue.
  const amb = disco(row(1), { style: 'neural', channels: channels({ 4: { useAmbience: true, palette: ['#FF0000', '#80FF80', '#0000FF'] } }) });
  amb.draw(quiet(0));
  check(amb.draw(live(10, hop(1, { mainFrequency: 0.99, amplitude: 1 }))), C(0, 255, 0), 1);
  check(amb.draw(live(20, hop(2, { mainFrequency: 1, amplitude: 1 }))), C(0, 0, 255), 1);
  // An effect palette is literal: no saturation modulation, the level is the amplitude.
  const own = disco(row(1), { style: 'neural' }, { spec: { palette: ['#123456'] } });
  own.draw(quiet(0));
  check(own.draw(live(10, hop(1, { mainFrequency: 0.5, amplitude: 0.5 }))), parseHex('#123456'), 0.5);
});

test('fresh neural readings postpone the idle; without them channel 4 idles', () => {
  const h = disco(row(2), { style: 'neural' });
  h.draw(quiet(0));
  h.draw(live(1500, hop(1, { mainFrequency: 0.5, amplitude: 0 })));
  assert.deepEqual(lit(h.draw(quiet(3499))), [], 'idle waits until 3500');
  h.draw(quiet(3500));
  const out = h.draw(quiet(4500));
  for (const s of out) close(s.level, L(70));
});

test('automatic strobe: bass and treble in the same frame flash every enabled channel\'s batch in a strobe palette colour, falling to 40 over 200 ms', () => {
  const palette = ['#FF00FF', '#00FFFF', '#FFFFFF', '#FF0000', '#00FF00', '#0000FF'];
  // A slow smoothness and a high fade floor do not change the flash's fixed fall.
  const h = disco(row(15), { allowStrobe: true, smoothness: 900, strobe: { palette, flashesPerSecond: 2 },
    channels: channels({ 0: { fadeBrightness: 100 }, 1: { fadeBrightness: 100 }, 2: { fadeBrightness: 100 } }) });
  h.draw(quiet(0));
  const out = h.draw(live(100, hop(1, { hit: BASS_TREBLE })));
  const on = lit(out);
  assert.equal(on.length, 9);
  for (const band of [0, 1, 2]) assert.equal(on.filter((i) => i % 3 === band).length, 3, `band ${band} flashes, voice without a hit`);
  const colour = out[on[0]].colour;
  assert.ok(palette.map(parseHex).some((c) => JSON.stringify(c) === JSON.stringify(colour)), JSON.stringify(colour));
  for (const i of on) { assert.deepEqual(out[i].colour, colour); assert.equal(out[i].level, 1); }
  for (const [t, level] of [[200, L(147)], [300, L(40)], [1000, L(40)]]) {
    const at = h.draw(quiet(t));
    for (const i of on) { close(at[i].level, level, `${t}`); assert.deepEqual(at[i].colour, colour); }
  }
});

test('the automatic strobe flashes no faster than five a second, whatever the manual rate; refused, Spectrum plays the hits', () => {
  const h = disco(row(3), { allowStrobe: true });
  h.draw(quiet(0));
  assert.deepEqual(h.draw(live(100, hop(1, { hit: BASS_TREBLE }))).map((s) => s.colour), [WHITE, WHITE, WHITE]);
  let out = h.draw(live(250, hop(2, { hit: BASS_TREBLE })));
  assert.deepEqual([out[0].level, out[2].level], [1, 1], 'ordinary bass and treble hits');
  assert.notDeepEqual(out[0].colour, WHITE);
  assert.notDeepEqual(out[2].colour, WHITE);
  assert.ok(hueOf(out[0].colour) <= 55 && hueOf(out[2].colour) >= 207);
  close(out[1].level, 1 + (L(40) - 1) * 0.75, 'voice is still falling from its flash');
  // At 300 the cap allows a flash; bass and treble fired 50 ms ago and refuse it, voice takes it.
  out = h.draw(live(300, hop(3, { hit: BASS_TREBLE })));
  assert.deepEqual(out[1], { colour: WHITE, level: 1, strength: 1 });
  assert.notDeepEqual(out[0].colour, WHITE);
  out = h.draw(live(400, hop(4, { hit: BASS_TREBLE })));
  assert.notDeepEqual(out[0].colour, WHITE, '400 is within 200 ms of the flash at 300');
  out = h.draw(live(500, hop(5, { hit: BASS_TREBLE })));
  assert.deepEqual(out.map((s) => [s.colour, s.level]), [[WHITE, 1], [WHITE, 1], [WHITE, 1]]);
});

test('a flash no channel can take does not use up the permit', () => {
  const h = disco(row(3), { allowStrobe: true });
  h.draw(quiet(0));
  h.draw(live(100, hop(1, { hit: BASS_TREBLE })));
  h.draw(live(250, hop(2, { hit: ALL })));
  assert.ok(h.draw(live(320, hop(3, { hit: BASS_TREBLE }))).every((s) => JSON.stringify(s.colour) !== JSON.stringify(WHITE)));
  assert.deepEqual(h.draw(live(350, hop(4, { hit: BASS_TREBLE }))).map((s) => [s.colour, s.level]), [[WHITE, 1], [WHITE, 1], [WHITE, 1]]);
});

test('a peak flash lights one lamp, even with linkLights; a flash the cap refuses holds instead of pulsing', () => {
  const h = disco(row(4), { style: 'peak', channels: channels({ 3: { strobeOn: true, linkLights: true } }) });
  h.draw(quiet(0));
  let out = h.draw(live(100, hop(1, { peakHit: true })));
  assert.equal(lit(out).length, 1);
  const [i] = lit(out);
  assert.deepEqual(out[i], { colour: WHITE, level: 1, strength: 1 });
  close(h.draw(quiet(200))[i].level, L(147));
  out = h.draw(live(250, hop(2, { peakHit: true })));
  assert.deepEqual(lit(out), [i]);
  close(out[i].level, 1 + (L(40) - 1) * 0.75);
  out = h.draw(live(300, hop(3, { peakHit: true })));
  assert.equal(full(out).length, 1);
  assert.deepEqual(out[full(out)[0]].colour, WHITE);
});

test('without the acknowledgement or under a manual strobe the music plays on with no automatic flash', () => {
  for (const over of [{ acknowledged: false }, { manualStrobeActive: true }]) {
    const h = disco(row(3), { allowStrobe: true });
    h.draw(quiet(0, over));
    const out = h.draw(live(100, hop(1, { hit: BASS_TREBLE }), over));
    assert.deepEqual(out.map((s) => s.level), [1, 0, 1], JSON.stringify(over));
    assert.notDeepEqual(out[0].colour, WHITE);
    const p = disco(row(4), { style: 'peak', channels: channels({ 3: { strobeOn: true } }) });
    p.draw(quiet(0, over));
    const po = p.draw(live(100, hop(1, { peakHit: true }), over));
    const [i] = lit(po);
    assert.notDeepEqual(po[i].colour, WHITE);
    assert.equal(p.draw(quiet(200, over))[i].level, 1, 'an ordinary peak hold, not a 200 ms flash fall');
  }
});

test('the automatic strobe permit: now ≥ last + ceil(1000 / clamp(rate, 1, 5))', () => {
  assert.equal(hdAutoStrobeFlash(299, 100, 5), false);
  assert.equal(hdAutoStrobeFlash(300, 100, 5), true);
  assert.equal(hdAutoStrobeFlash(599, 100, 2), false);
  assert.equal(hdAutoStrobeFlash(600, 100, 2), true);
  assert.equal(hdAutoStrobeFlash(300, 100, 50), true, 'never faster than five a second');
  assert.equal(hdAutoStrobeFlash(299, 100, 50), false);
  assert.equal(hdAutoStrobeFlash(1099, 100, 0), false, 'a rate below one is one');
  assert.equal(hdAutoStrobeFlash(0, -Infinity, 5), true, 'never flashed');
  assert.equal(hdAutoStrobeFlash(NaN, -Infinity, 5), false);
  assert.equal(hdAutoStrobeFlash(1000, 0, NaN), false);
  assert.equal(hdAutoStrobeFlash(1000, NaN, 5), false);
});

test('no audio frame: nothing hits, the idle cycle still runs', () => {
  const loud = { hit: ALL, peakHit: true, mainFrequency: 0.5, amplitude: 1 };
  for (const style of ['spectrum', 'peak', 'neural']) {
    const h = disco(row(3), { style, allowStrobe: true });
    h.draw(quiet(0));
    assert.deepEqual(lit(h.draw(quiet(100, { audio: hop(1, loud), audioMode: 'tempo' }))), [], style);
    assert.deepEqual(lit(h.draw(quiet(200, { audio: hop(2, loud), audioMode: 'off' }))), [], style);
    assert.deepEqual(lit(h.draw(live(300, null))), [], style);
    assert.deepEqual(lit(h.draw(quiet(1999))), [], style);
    h.draw(quiet(2000));
    const out = h.draw(quiet(3000));
    assert.equal(lit(out).length, 3, style);
    for (const s of out) close(s.level, style === 'spectrum' ? 0.5 : L(70), style);
  }
});

test('Hue colours convert as Hue Dynamics streams them: whole degrees of hue / 182.04, truncated bytes', () => {
  const vectors = [[0, C(255, 0, 0)], [9000, C(255, 208, 0)], [32768, C(0, 255, 255)], [43690, C(0, 0, 255)], [49151, C(127, 0, 255)],
    [54613, C(255, 0, 255)], [60000, C(255, 0, 131)], [65534, C(255, 0, 4)], [65535, C(255, 0, 4)]];
  for (const [hue, colour] of vectors) assert.deepEqual(hdHsbToColour(hue, 254), colour, String(hue));
  assert.deepEqual(hdHsbToColour(32768, 255), C(0, 255, 255), 'saturation clamps to 254');
  assert.deepEqual(hdHsbToColour(32768, 127), C(127, 255, 255));
  assert.deepEqual(hdHsbToColour(9000, 0), WHITE);
});

test('an override or the effect\'s own palette plays as literal colours; ambience takes only a colour\'s hue', () => {
  const lamp = parseHex('#11223344');
  const h = disco(row(3), {}, { spec: { palette: ['#11223344'] } });
  h.draw(quiet(0));
  let out = h.draw(live(100, hop(1, { hit: BASS })));
  assert.deepEqual([out[0].colour, out[0].level], [lamp, 1]);
  out = h.draw(quiet(232));
  assert.deepEqual(out[0].colour, lamp, 'the release keeps the white die');
  close(out[0].level, L(40));
  h.draw(quiet(2000));
  out = h.draw(quiet(3000));
  assert.deepEqual(out[1].colour, lamp, 'and so does the idle');
  close(out[1].level, 0.5);

  // An override beats the effect's palette, the strobe palette included.
  const green = parseHex('#00FF00');
  const s = disco(row(3), { allowStrobe: true }, { spec: { palette: ['#11223344'] } });
  s.draw(quiet(0, { paletteOverride: [green] }));
  assert.deepEqual(s.draw(live(100, hop(1, { hit: BASS_TREBLE }), { paletteOverride: [green] })).map((x) => [x.colour, x.level]),
    [[green, 1], [green, 1], [green, 1]]);

  // White and pale colours from a palette stay white and pale.
  const pale = disco(row(4), { style: 'peak', channels: channels({ 3: { linkLights: true } }) }, { spec: { palette: ['#FFFFFF'] } });
  pale.draw(quiet(0));
  assert.deepEqual(pale.draw(live(100, hop(1, { peakHit: true })))[0].colour, WHITE);

  // Ambience: a pale pink plays as pure red.
  const amb = disco(row(3), { channels: channels({ 0: { useAmbience: true, palette: ['#FF8080'] } }) });
  amb.draw(quiet(0));
  assert.deepEqual(amb.draw(live(100, hop(1, { hit: BASS })))[0].colour, C(255, 0, 0));
});

test('the eleven genre presets carry the catalogue values', () => {
  // id, name, decay, sensitivity, smoothness, relaxed, sequence, auto strobe, manual rate, strobe palette,
  // bass [lo, hi, minHue, maxHue, pulse], voice [lo, hi, minHue, maxHue], treble [lo, hi, minHue, maxHue, pulse].
  // Dance, Drum and Bass, Trance and Ambient end their treble at the service's 11025 Hz.
  const rows = [
    ['hd.disco.pop', 'Pop', 24, 60, 500, false, 8, false, 2, ['#FF00FF', '#00FFFF', '#FFFFFF'], [40, 250, 52000, 62000, true], [300, 3000, 0, 11000], [4000, 11000, 10000, 24000, false]],
    ['hd.disco.rock', 'Rock', 28, 55, 400, false, 8, false, 3, ['#FF0000', '#FFFFFF'], [40, 215, 58000, 65534, true], [250, 2500, 3000, 8500], [3000, 9000, 8000, 14000, false]],
    ['hd.disco.hipHop', 'Hip Hop', 18, 62, 550, false, 8, false, 2, ['#FF0000', '#FFD000', '#7F00FF'], [40, 250, 61000, 65534, true], [300, 3500, 3000, 11000], [4500, 10000, 50000, 58000, false]],
    ['hd.disco.rAndB', 'R&B', 10, 65, 850, true, 8, false, 1, ['#FF68B6', '#CC9AFF'], [40, 250, 60000, 65534, false], [300, 4000, 52000, 60000], [4500, 10000, 5000, 12000, false]],
    ['hd.disco.dance', 'Dance', 30, 58, 400, false, 8, false, 4, ['#00FFFF', '#FF00FF', '#FFFFFF'], [40, 200, 60000, 65534, true], [250, 3200, 16000, 26000], [4000, 11025, 38000, 50000, false]],
    ['hd.disco.classical', 'Classical', 7, 65, 950, true, 8, false, 1, ['#FFEDC2'], [40, 350, 42000, 48000, false], [400, 3000, 47000, 54000], [3500, 10000, 7000, 14000, false]],
    ['hd.disco.jazz', 'Jazz', 16, 60, 650, true, 8, false, 1, ['#0000FF', '#7F00FF'], [40, 300, 3000, 9000, false], [350, 2500, 56000, 65534], [3000, 9000, 38000, 46000, false]],
    ['hd.disco.acoustic', 'Acoustic', 14, 66, 750, true, 8, false, 1, ['#FFEDC2', '#FF9722'], [70, 300, 59000, 65534, false], [350, 3000, 5000, 12000], [3500, 10000, 38000, 46000, false]],
    ['hd.disco.drumAndBass', 'Drum and Bass', 40, 60, 400, false, 4, true, 5, ['#00FFFF', '#FF00FF', '#FFFFFF'], [40, 200, 60000, 65534, true], [250, 2500, 26000, 38000], [3000, 11025, 50000, 62000, true]],
    ['hd.disco.trance', 'Trance', 38, 60, 400, false, 4, true, 4, ['#0000FF', '#00FFFF', '#FFFFFF'], [40, 180, 52000, 62000, true], [220, 2000, 40000, 52000], [3000, 11025, 27000, 38000, true]],
    ['hd.disco.ambient', 'Ambient', 5, 70, 1000, true, 8, false, 1, ['#AEAEFF', '#CC9AFF'], [40, 400, 43000, 50000, false], [450, 4000, 35000, 44000], [4500, 11025, 28000, 36000, false]],
  ];
  assert.deepEqual(DISCO_PRESETS.map((p) => [p.id, p.name]), rows.map(([id, name]) => [id, name]));
  rows.forEach(([id, , decay, sensitivity, smoothness, relaxed, sequenceLength, allowStrobe, rate, palette, bass, voice, treble], n) => {
    const p = DISCO_PRESETS[n].params;
    assert.equal(p.style, 'spectrum', id);
    assert.deepEqual(p.globals, { ...DISCO_DEFAULTS.globals, advancedDecay: decay, sensitivity, smoothness, minimumThreshold: 2 }, id);
    assert.equal(p.smoothness, smoothness, id);
    assert.equal(p.allowStrobe, allowStrobe, id);
    assert.deepEqual(p.strobe, { palette, flashesPerSecond: rate }, id);
    assert.deepEqual(p.assign, {}, id);
    assert.equal(p.maxLightsPerBatch, 10, id);
    const levels = { fadeBrightness: relaxed ? 176 : 40, idleFadeBrightness: relaxed ? 176 : 254, fadeSaturation: 255, useAmbience: false, palette: null };
    [bass, voice, treble].forEach(([, , minHue, maxHue, allowPulse = false], i) => assert.deepEqual(p.channels[i],
      { ...DISCO_DEFAULTS.channels[i], ...levels, enabled: true, fade: true, allowPulse, minHue, maxHue, sequenceLength }, `${id} ${i}`));
    for (const i of [3, 4]) assert.deepEqual(p.channels[i], { ...DISCO_DEFAULTS.channels[i], ...levels }, `${id} ${i}`);
    const edges = [bass, voice, treble].map(([lo, hi]) => [lo, hi]);
    assert.deepEqual([p.bands.bass, p.bands.voice, p.bands.treble], edges, id);
    // Each band's per-bin floors add up to the app's total floor of 2 / 200000.
    edges.forEach(([lo, hi], i) => assert.ok(Math.abs(10 ** (p.bands.floorDb[i] / 10) * bandBins(lo, hi).count / 1e-5 - 1) < 1e-12, `${id} ${i}`));
    const spec = validateSpec({ kind: 'hd.disco', params: p });
    assert.deepEqual(spec.params, p, id);
    assert.deepEqual(validateSpec(spec), spec, id);
  });
  const floors = (id) => DISCO_PRESETS.find((p) => p.id === id).params.bands.floorDb;
  [-60.413926851582254, -71.03803720955958, -75.1321760006794].forEach((db, i) => close(floors('hd.disco.pop')[i], db, `pop ${i}`));
  close(floors('hd.disco.dance')[2], -75.1587384371168, 'dance treble: bins 185..512');
  close(floors('hd.disco.drumAndBass')[2], -75.7287160220048, 'drum and bass treble: bins 139..512');
  close(floors('hd.disco.trance')[2], -75.7287160220048, 'trance treble: bins 139..512');
  close(floors('hd.disco.ambient')[2], -74.84299839346787, 'ambient treble: bins 208..512');
  // No preset shares an object or array with another, or with the defaults.
  const seen = new Map();
  const walk = (owner, value) => {
    if (value === null || typeof value !== 'object') return;
    assert.ok(!seen.has(value) || seen.get(value) === owner, `${owner} shares an object with ${seen.get(value)}`);
    seen.set(value, owner);
    Object.values(value).forEach((child) => walk(owner, child));
  };
  walk('defaults', DISCO_DEFAULTS);
  DISCO_PRESETS.forEach((p) => walk(p.id, p.params));
});

test('a target mask hides lamps without changing which lamps play', () => {
  const room = row(12), spec = validateSpec({ kind: 'hd.disco' }), seed = seedFrom('disco');
  const frames = [quiet(0), live(100, hop(1, { hit: ALL })), quiet(150), quiet(3000)];
  const play = (targets) => {
    const stepper = new EffectStepper(), inst = { id: 'disco', spec, seed, anchorBeat: 0, startedAtMs: 0, targets };
    return frames.map((input) => {
      const out = Array.from({ length: room.n }, () => ({ colour: C(9, 9, 9), level: 0, strength: 0 }));
      renderEffect(inst, { bpm: 120, dtMs: 0, anchorBeat: 0, lookPalette: [], paletteOverride: null, audio: null, audioMode: 'tempo',
        master: HD_MASTER_DEFAULTS, seed, acknowledged: true, hueStrobe: 'pulse', ...input }, room, stepper, out);
      return out;
    });
  };
  const whole = play(null), masked = play([0, 1, 2, 3, 4, 5]);
  assert.ok(lit(whole[1]).some((i) => i < 6) && lit(whole[1]).some((i) => i >= 6));
  masked.forEach((out, k) => {
    assert.deepEqual(out.slice(0, 6), whole[k].slice(0, 6), `frame ${k}`);
    assert.ok(out.slice(6).every((s) => s.strength === 0));
  });
});

test('one lamp, one colour or no lamps at all: every style renders finite output', () => {
  for (const style of ['spectrum', 'peak', 'neural']) {
    for (const n of [0, 1]) {
      for (const spec of [{}, { palette: ['#FF0000'] }]) {
        const h = disco(row(n), { style, allowStrobe: true, channels: channels({ 3: { strobeOn: true } }) }, { spec });
        const frames = [quiet(0), live(100, hop(1, { hit: ALL, peakHit: true, mainFrequency: 1, amplitude: 1 })), quiet(150), quiet(3000), quiet(6000)];
        for (const frame of frames) {
          const out = h.draw(frame);
          assert.equal(out.length, n);
          for (const s of out) assert.ok([s.level, s.colour.r, s.colour.g, s.colour.b].every(Number.isFinite), `${style} ${n} ${JSON.stringify(s)}`);
        }
      }
    }
  }
});

test('a cloned stepper continues the same show, pending releases included', () => {
  const h = disco(row(15), { allowStrobe: true });
  h.draw(quiet(0));
  h.draw(live(100, hop(1, { hit: BASS_TREBLE })));
  h.draw(live(250, hop(2, { hit: ALL })));
  const state = h.state();
  assert.deepEqual(structuredClone(state), state, 'plain data only');
  const copy = h.stepper.clone();
  for (const frame of [quiet(260), live(400, hop(3, { hit: BASS })), quiet(2600), live(2700, hop(4, { hit: BASS_TREBLE })), quiet(5000)]) {
    assert.deepEqual(h.draw(frame, copy), h.draw(frame), String(frame.nowMs));
  }
});
