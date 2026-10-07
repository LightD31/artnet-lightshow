// tests/unit/effects-hd.test.js
import test from 'node:test';
import assert from 'node:assert';
import '../../src/shared/effects/index.ts';
import { HD_DEFAULTS, HD_BASE, HD_CAPABILITIES, scopedLoopLength, orderTargets, gateStrength } from '../../src/shared/effects/hd.ts';
import { kindOf, validateSpec } from '../../src/shared/effects/registry.ts';
import { renderEffect } from '../../src/shared/effects/render.ts';
import { EffectStepper } from '../../src/shared/effects/stepper.ts';
import { HD_MASTER_DEFAULTS } from '../../src/shared/effects/types.ts';
import { buildRoom } from '../../src/shared/room.ts';
import { hash01, seedFrom } from '../../src/shared/effects/hash.ts';
import { parseHex, samplePalette } from '../../src/shared/effects/palette.ts';

const PAL = ['#A855F7', '#22D3EE', '#F472B6'].map(parseHex);
const frame = (beatPos, over = {}) => ({ beatPos, bpm: 120, nowMs: beatPos * 500, dtMs: 22.7, anchorBeat: 0, lookPalette: PAL, paletteOverride: null,
  audio: null, audioMode: 'tempo', master: HD_MASTER_DEFAULTS, seed: seedFrom('hd'), acknowledged: true, hueStrobe: 'pulse', ...over });
const room4 = () => buildRoom(4, (i) => i / 3, () => 0.5, () => 0.5, null);
const render = (kind, beatPos, room = room4(), params = {}, specOver = {}, frameOver = {}) => {
  const out = Array.from({ length: room.n }, () => ({ colour: PAL[0], level: 0, strength: 0 }));
  const spec = validateSpec({ kind, params: { ...HD_DEFAULTS[kind].params, ...params }, brightness: 1, ...specOver });
  renderEffect({ id: `${kind}:${JSON.stringify(params)}`, spec, seed: seedFrom('hd'), anchorBeat: 0, startedAtMs: 0, targets: null }, frame(beatPos, frameOver), room, new EffectStepper(), out);
  return out;
};
const silence = { t: 0, rms: 0, power: 0, dominantHz: null, party: { full: 0, bass: 0, mid: 0, high: 0 },
  disco: { hit: [false, false, false], gate: [0, 0, 0], level: [0, 0, 0], peakHit: false, neural: { mainFrequency: 0, amplitude: 0 } }, spl: { db: -80, level: -51, beat: null, section: null } };

test('every family is registered with its base and recommended settings', () => {
  for (const kind of Object.keys(HD_DEFAULTS)) assert.ok(kindOf(kind), kind);
  assert.strictEqual(HD_BASE.attack, 120 / 960);
  assert.strictEqual(HD_DEFAULTS['hd.positionChase'].params.attack, 80 / 960);
  assert.strictEqual(HD_DEFAULTS['hd.positionChase'].params.stagger, 120 / 960);
  assert.strictEqual(HD_DEFAULTS['hd.radialPulse'].params.trigger.beatInterval, 4);
  assert.strictEqual(HD_DEFAULTS['hd.radialPulse'].params.spatial.radius, 1);
  assert.strictEqual(HD_DEFAULTS['hd.spatialWash'].brightness, 0.72);
  assert.strictEqual(HD_DEFAULTS['hd.frequencyBurst'].minFlashIntervalMs, 400);
  assert.strictEqual(kindOf('hd.frequencyBurst').rapidFlash, true);
  assert.strictEqual(HD_DEFAULTS['hd.simpleAdsr'].scope, 'singleBeat');
});

test("preset scope determines the loop length", () => {
  const wash = HD_DEFAULTS['hd.spatialWash'].params;                 // 1920 + 960 + 1920 ticks = 5 beats
  assert.strictEqual(scopedLoopLength({ kind: 'hd.spatialWash', params: wash, scope: 'measure' }, wash), 5);
  const chase = HD_DEFAULTS['hd.positionChase'].params;              // 80 + 160 + 400 ticks < a bar
  assert.strictEqual(scopedLoopLength({ kind: 'hd.positionChase', params: chase, scope: 'measure' }, chase), 4);
  const adsr = HD_DEFAULTS['hd.simpleAdsr'].params;
  assert.strictEqual(scopedLoopLength({ kind: 'hd.simpleAdsr', params: adsr, scope: 'singleBeat' }, adsr), 1);
  const two = { ...chase, loopLength: 2 };
  assert.strictEqual(scopedLoopLength({ kind: 'hd.twinkle', params: two }, two), 2, 'an explicit loop length wins');
});

test('position chase: the envelope runs lamp to lamp by the stagger', () => {
  const p = { curve: 'cut', attack: 0, hold: 0.125, release: 0, stagger: 0.125, loopLength: 4 };
  assert.deepStrictEqual(render('hd.positionChase', 0.0625, room4(), p).map((s) => s.level > 0), [true, false, false, false]);
  assert.deepStrictEqual(render('hd.positionChase', 0.1875, room4(), p).map((s) => s.level > 0), [false, true, false, false]);
});

test("position chase divides palette positions by lamp count", () => {
  const p = { curve: 'cut', attack: 0, hold: 4, release: 0, stagger: 0, loopLength: 4 };
  const out = render('hd.positionChase', 0.5, room4(), p);
  assert.strictEqual(new Set(out.map((s) => JSON.stringify(s.colour))).size, 4);
});

test('radial pulse: the lamps on the ring are bright, the lamp inside it dark', () => {
  // Three lamps in a row: u = −1, 0, +1 → X = 0, 0.5, 1; Y = Z = 0.5. Origin 0.5³, radius 1, far corner √0.75:
  // the middle lamp is at d = 0, the outer two at d = 0.577. At progress 0.5 the ring passes the outer two.
  const room = buildRoom(3, (i) => [0.5, 0.75, 1][i], () => 0.5, () => 0.5, null);
  const p = { curve: 'cut', attack: 0, hold: 4, release: 0, loopLength: 4, trigger: { ...HD_DEFAULTS['hd.radialPulse'].params.trigger, mode: 'timeline' } };
  const out = render('hd.radialPulse', 2, room, p);
  assert.ok(out[0].level > 0.9 && out[2].level > 0.9, `${out[0].level} ${out[2].level}`);
  assert.strictEqual(out[1].level, 0);
});

test("twinkle selection follows seeded probability", () => {
  const a = render('hd.twinkle', 0.01).map((s) => s.level > 0);
  const b = render('hd.twinkle', 0.01).map((s) => s.level > 0);
  assert.deepStrictEqual(a, b);
  const none = render('hd.twinkle', 0.01, room4(), { probability: 0 });
  assert.ok(none.every((s) => s.level === 0));
});

test('frequency burst renders nothing until photosensitivity is acknowledged', () => {
  const out = render('hd.frequencyBurst', 0.01, room4(), {}, {}, { acknowledged: false });
  assert.ok(out.every((s) => s.strength === 0));
});

test("timeline triggers ignore reactive depth", () => {
  const p = { curve: 'cut', attack: 0, hold: 4, release: 0, trigger: { mode: 'beatAccent', band: 'bass', beatInterval: 1, threshold: .2, reactiveDepth: 0.5 } };
  const timeline = { ...p, trigger: { ...p.trigger, mode: 'timeline' } };
  assert.ok(Math.abs(render('hd.breathingFade', 1, room4(), timeline, {}, { audioMode: 'reactive', audio: silence })[0].level - 1) < 0.02, 'timeline: no reactive scaling');
});

test("beat-accent triggers apply reactive depth", () => {
  const p = { curve: 'cut', attack: 0, hold: 4, release: 0, trigger: { mode: 'beatAccent', band: 'bass', beatInterval: 1, threshold: .2, reactiveDepth: 0.5 } };
  const quiet = render('hd.breathingFade', 1, room4(), p, {}, { audioMode: 'reactive', audio: silence })[0].level;
  assert.ok(Math.abs(quiet - 0.5) < 0.02, `${quiet}`);
});

test("reactive effects fall back to tempo without audio", () => {
  const p = { curve: 'cut', attack: 0, hold: 4, release: 0, trigger: { mode: 'beatAccent', band: 'bass', beatInterval: 1, threshold: .2, reactiveDepth: 0.5 } };
  const noAudio = render('hd.breathingFade', 1, room4(), p, {}, { audioMode: 'reactive', audio: null })[0].level;
  assert.ok(Math.abs(noAudio - 1) < 0.02, 'without an audio frame the kind runs on the clock');
});

test("volume gate responds to reactive audio", () => {
  const gate = { curve: 'cut', attack: 0, hold: 8, release: 0 };
  const loud = { ...silence, party: { full: 0.5, bass: 0.5, mid: 0.5, high: 0.5 } };
  const g = render('hd.volumeGateWash', 1, room4(), gate, {}, { audioMode: 'reactive', audio: loud })[0].level;
  assert.ok(g > 0.2 && g < 1, `${g}`);
});

test("changing tempo preserves admitted burst events", () => {
  // The admission converts event starts to ms with the tempo in force; a tempo change must not re-admit or drop an event already decided.
  const room = room4();
  const stepper = new EffectStepper();
  const p = { ...HD_DEFAULTS['hd.frequencyBurst'].params, probability: 1, curve: 'cut', attack: 0, hold: 0.5, release: 0, loopLength: 1 };
  const spec = validateSpec({ kind: 'hd.frequencyBurst', params: p });
  const inst = { id: 'fb', spec, seed: seedFrom('hd'), anchorBeat: 0, startedAtMs: 0, targets: null };
  const at = (beatPos, bpm, nowMs) => { const out = Array.from({ length: 4 }, () => ({ colour: PAL[0], level: 0, strength: 0 })); renderEffect(inst, frame(beatPos, { bpm, nowMs }), room, stepper, out); return out; };
  const before = at(2.1, 120, 1050);
  const after = at(2.15, 128, 1050 + 23);           // the tap landed between two frames
  assert.deepStrictEqual(before.map((s) => s.level > 0), after.map((s) => s.level > 0), 'the lit set is unchanged across the tempo change');
});

test("Simple ADSR normalizes its RGB envelopes", () => {
  const env = { attack: 0.1, hold: 0.1, decay: 0.1, sustain: 0.5, release: 0.2 };
  const p = { rgbEnvelope: { colourMode: 'all', singleColour: '#FFFFFF', r: env, g: { ...env, sustain: 0 }, b: { ...env, sustain: 0 }, brightness: env } };
  const out = render('hd.simpleAdsr', 0.1, room4(), p, { scope: 'singleBeat' });   // loop 1 beat, progress 0.1 = end of attack → full
  assert.strictEqual(out[0].colour.r, 255);
  assert.ok(out[0].level > 0.99);
});

test('one lamp, one colour: every family renders finite values', () => {
  const room = buildRoom(1, () => 0.5, () => 0.5, () => 0.5, null);
  for (const kind of Object.keys(HD_DEFAULTS)) {
    const out = [{ colour: PAL[0], level: 0, strength: 0 }];
    renderEffect({ id: kind, spec: validateSpec({ kind }), seed: seedFrom('one'), anchorBeat: 0, startedAtMs: 0, targets: null }, frame(0.3, { lookPalette: [PAL[0]] }), room, new EffectStepper(), out);
    assert.ok(Number.isFinite(out[0].level) && Number.isFinite(out[0].colour.r), kind);
  }
});

test("target ordering follows position, track or seeded random order", () => {
  const room = buildRoom(3, (i) => [1, 0, 0.5][i], () => 0.5, () => 0.5, null);
  const p = HD_DEFAULTS['hd.positionChase'].params;
  assert.deepStrictEqual(orderTargets({ ...p, order: 'position' }, room, seedFrom('o')), [1, 2, 0]);
  assert.deepStrictEqual(orderTargets({ ...p, order: 'track' }, room, seedFrom('o')), [0, 1, 2]);
});

const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-10, `${message ?? ''}: ${actual} != ${expected}`);
const steady = { curve: 'cut', attack: 0, hold: 4, release: 0, stagger: 0, direction: 'forward', loopLength: 4, trigger: { ...HD_BASE.trigger } };

test('all recommended values are separate family settings, with nested capabilities', () => {
  const expected = {
    'hd.positionChase': { curve: 'easeOut', attack: 80 / 960, hold: 160 / 960, release: 400 / 960 },
    'hd.radialPulse': { attack: 1.5, hold: 0.5, release: 2 },
    'hd.spatialWash': { attack: 2, hold: 1, release: 2, direction: 'alternate' },
    'hd.bouncingScan': { direction: 'alternate', trail: 360 / 960 },
    'hd.streak': { direction: 'random', probability: 0.68, trail: 1 },
    'hd.twinkle': { attack: 40 / 960, hold: 240 / 960, release: 720 / 960, probability: 0.35 },
    'hd.breathingFade': { attack: 1.5, hold: 0.5, release: 1.5, curve: 'easeInOut' },
    'hd.volumeGateWash': { release: 1 },
    'hd.frequencyBurst': { attack: 40 / 960, hold: 160 / 960, release: 440 / 960, probability: 0.75 },
  };
  for (const [kind, params] of Object.entries(expected)) {
    for (const [key, value] of Object.entries(params)) assert.strictEqual(HD_DEFAULTS[kind].params[key], value, `${kind}.${key}`);
    assert.strictEqual(HD_DEFAULTS[kind].scope, 'measure');
  }
  assert.strictEqual(Object.keys(HD_DEFAULTS).length, 10);
  assert.strictEqual(HD_CAPABILITIES['hd.positionChase']['spatial.angle'], true);
  assert.strictEqual(HD_CAPABILITIES['hd.positionChase']['spatial.radius'], false);
  assert.strictEqual(HD_CAPABILITIES['hd.radialPulse']['spatial.x'], true);
  assert.strictEqual(HD_CAPABILITIES['hd.radialPulse']['spatial.angle'], false);
  assert.strictEqual(HD_CAPABILITIES['hd.simpleAdsr']['trigger.beatInterval'], false);
  assert.strictEqual(HD_CAPABILITIES['hd.breathingFade'].direction, false);
  assert.notStrictEqual(HD_DEFAULTS['hd.streak'].params.spatial, HD_DEFAULTS['hd.bouncingScan'].params.spatial);
});

test("HD schemas reject invalid controls", () => {
  for (const params of [{ attack: -1 }, { hold: Infinity }, { curve: 'wrong' }, { repetitions: 1.5 }, { repetitions: 0 },
    { probability: 1.01 }, { trail: -1 }, { loopLength: 0 }, { spatial: { x: -0.1 } }, { spatial: { radius: 1.1 } },
    { spatial: { angle: NaN } }, { trigger: { threshold: -0.1 } }, { trigger: { beatInterval: 0 } },
    { rgbEnvelope: { r: { peak: -0.1 } } }, { rgbEnvelope: { singleColour: 'red' } }]) {
    assert.throws(() => validateSpec({ kind: 'hd.simpleAdsr', params }), JSON.stringify(params));
  }
});

test("HD schemas fill partial nested defaults", () => {
  const spec = validateSpec({ kind: 'hd.radialPulse', params: { spatial: { angle: 45 }, trigger: { threshold: 0.995 } } });
  assert.strictEqual(spec.params.spatial.radius, 1);
  assert.strictEqual(spec.params.trigger.band, 'bass');
  assert.strictEqual(spec.params.trigger.threshold, 0.995);
  assert.deepStrictEqual(validateSpec(spec), spec);
});

test("HD schemas preserve custom wire envelopes", () => {
  const custom = validateSpec({ kind: 'hd.simpleAdsr', params: { rgbEnvelope: { r: { attack: 0.8, hold: 0.8, peak: 0.2, sustain: 0.9 } } } });
  assert.strictEqual(custom.params.rgbEnvelope.r.attack, 0.8);
  assert.strictEqual(custom.params.rgbEnvelope.r.sustain, 0.9);
  assert.deepStrictEqual(validateSpec(custom), custom);
});

test("HD families retain their level and palette formulas", () => {
  const room = room4();
  const seed = seedFrom('hd');
  const progress = 0.25;
  const wave = render('hd.spatialWash', 1, room, { ...steady, spatial: { ...HD_BASE.spatial, radius: 1 } });
  const gate = render('hd.volumeGateWash', 1, room, steady);
  const bounce = render('hd.bouncingScan', 1, room, { ...steady, trail: 1.6 });
  const streak = render('hd.streak', 1, room, { ...steady, trail: 1, probability: 1 });
  const twinkle = render('hd.twinkle', 1, room, { ...steady, probability: 0.5 });
  for (let i = 0; i < room.n; i++) {
    const phase = room.X[i] - progress;
    const raised = Math.max(...[0, 1 / 3, 2 / 3].map((shift) => (Math.cos((phase + shift) * Math.PI * 2) + 1) / 2));
    near(wave[i].level, 0.55 + 0.45 * raised);
    near(gate[i].level, 0.72 + 0.28 * raised);
    assert.deepStrictEqual(wave[i].colour, samplePalette(PAL, phase));
    near(bounce[i].level, Math.exp(-4.5 * ((i / 3 - 0.5) / 0.4) ** 2));
    assert.deepStrictEqual(bounce[i].colour, samplePalette(PAL, 0.5 + i / 3));
    const age = progress - i / 3;
    near(streak[i].level, age >= 0 && age <= 1 ? Math.exp(-3.2 * age / 0.25) : 0);
    assert.deepStrictEqual(streak[i].colour, samplePalette(PAL, progress + i / 3 + hash01(seed, 0, 0)));
    near(twinkle[i].level, hash01(seed, i, 0) <= 0.5 ? 1 : 0);
    assert.deepStrictEqual(twinkle[i].colour, samplePalette(PAL, hash01(seed, i, 0)));
  }
  const breathing = render('hd.breathingFade', 1, room, steady);
  assert.deepStrictEqual(breathing[0].colour, samplePalette(PAL, progress));
  assert.deepStrictEqual(render('hd.breathingFade', 1, room, { ...steady, direction: 'reverse' }), breathing);
});

test("direction reverses applicable progress once", () => {
  const room = room4();
  const chase = { ...steady, hold: 0.125, stagger: 0.125, direction: 'reverse' };
  assert.deepStrictEqual(render('hd.positionChase', 0.0625, room, chase).map((s) => s.level), [0, 0, 0, 1]);
  const wash = render('hd.spatialWash', 1, room, { ...steady, direction: 'reverse', spatial: { ...HD_BASE.spatial, radius: 1 } });
  assert.deepStrictEqual(wash[0].colour, samplePalette(PAL, -0.75));
  const seed = seedFrom('order');
  assert.deepStrictEqual(orderTargets({ ...HD_BASE, order: 'random' }, room, seed),
    [0, 1, 2, 3].sort((a, b) => hash01(seed, a, 0) - hash01(seed, b, 0) || a - b));
  const tied = buildRoom(3, () => 0.5, () => 0.5, (i) => [1, 0, 0.5][i], null);
  assert.deepStrictEqual(orderTargets(HD_BASE, tied, seed), [1, 2, 0]);
});

test('gate threshold uses the exact formula below one and its finite limit at one', () => {
  const master = { ...HD_MASTER_DEFAULTS, threshold: 0.995 };
  near(gateStrength(0.9975, master, HD_BASE.trigger), 0.5);
  near(gateStrength(0.5, HD_MASTER_DEFAULTS, { ...HD_BASE.trigger, threshold: 0.25 }), 1 / 3);
  assert.strictEqual(gateStrength(1, { ...master, threshold: 1 }, HD_BASE.trigger), 1);
  assert.strictEqual(gateStrength(0.9999, { ...master, threshold: 1 }, HD_BASE.trigger), 0);
});

function live(kind, params = {}, over = {}, room = room4()) {
  const stepper = new EffectStepper();
  const spec = validateSpec({ kind, params, brightness: 1, ...over });
  const inst = { id: kind, spec, seed: seedFrom('hd'), anchorBeat: 0, startedAtMs: 0, targets: null };
  return { stepper, inst, at(beatPos, frameOver = {}, engine = stepper) {
    const out = Array.from({ length: room.n }, () => ({ colour: PAL[0], level: 0, strength: 0 }));
    renderEffect(inst, frame(beatPos, frameOver), room, engine, out);
    return out;
  } };
}

test("volume followers retain state across tempo changes and clones", () => {
  const room = buildRoom(1, () => 0.5, () => 0.5, () => 0.5, null);
  const params = { curve: 'linear', attack: 1, hold: 1, release: 1, loopLength: 8,
    trigger: { mode: 'volumeGate', band: 'full', threshold: 0, reactiveDepth: 1 } };
  const gate = live('hd.volumeGateWash', params, {}, room);
  const at = (beat, level, bpm = 120, stepper = gate.stepper) => gate.at(beat, { bpm, audioMode: 'reactive', master: { ...HD_MASTER_DEFAULTS, threshold: 0 },
    audio: { ...silence, party: { ...silence.party, full: level } } }, stepper)[0].level;
  const plain = (beat) => render('hd.volumeGateWash', beat, room, params)[0].level;
  near(at(0, 1), 0);
  near(at(0.5, 1) / plain(0.5), 0.5);
  near(at(1, 1, 128) / plain(1), 1);
  near(at(1.1, 0) / plain(1.1), 1);
  near(at(1.6, 0, 128) / plain(1.6), 1);
  const clone = gate.stepper.clone();
  near(at(2.6, 0, 120) / plain(2.6), 0.5);
  near(at(2.6, 0, 120, clone) / plain(2.6), 0.5);
  const accent = { ...params, trigger: { ...params.trigger, mode: 'beatAccent' } };
  const halfAudio = { ...silence, party: { ...silence.party, full: 0.5 } };
  const half = render('hd.volumeGateWash', 0.5, room, accent, {}, { audioMode: 'reactive', audio: halfAudio });
  const full = render('hd.volumeGateWash', 0.5, room, accent);
  near(half[0].level / full[0].level, 0.5, 'beat accent reads audio directly without a follower attack');
});

test("rapid admission retains spacing across long-session tempo changes", () => {
  for (const [beforeBpm, afterBpm] of [[120, 128], [128, 120]]) {
    const show = live('hd.frequencyBurst', { ...steady, hold: 0.25, probability: 1, loopLength: 1,
      trigger: { ...HD_BASE.trigger, mode: 'beatAccent', beatInterval: 1 } });
    const nowMs = 1200 * 60000 / beforeBpm;
    assert.ok(show.at(1200.01, { bpm: beforeBpm, nowMs: nowMs + 0.01 * 60000 / beforeBpm }).every((s) => s.level === 1));
    assert.ok(show.at(1201.01, { bpm: afterBpm, nowMs: nowMs + 1.01 * 60000 / afterBpm }).every((s) => s.level === 1));
    const cloned = show.stepper.clone();
    const f = { bpm: afterBpm, nowMs: nowMs + 2.01 * 60000 / afterBpm };
    assert.deepStrictEqual(show.at(1202.01, f), show.at(1202.01, f, cloned));
  }
});

test("rapid non-burst events retain admission spacing", () => {
  const show = live('hd.breathingFade', { ...steady, hold: 0.1, loopLength: 1, repetitions: 4 }, { rapidFlash: true, minFlashIntervalMs: 400 });
  assert.strictEqual(show.at(0.01)[0].level, 1);
  assert.strictEqual(show.at(0.26)[0].level, 0);
  assert.strictEqual(show.at(1.01)[0].level, 1);
  assert.strictEqual(show.at(1.01, { acknowledged: false })[0].strength, 0);
});

test("Simple ADSR uses acknowledgement without event spacing", () => {
  const flat = { attack: 0, hold: 1, decay: 0, release: 0, sustain: 1, peak: 1 };
  const adsr = live('hd.simpleAdsr', { loopLength: 0.0625, rgbEnvelope: { colourMode: 'all', r: flat, g: flat, b: flat } }, { rapidFlash: true });
  assert.strictEqual(adsr.at(0.01)[0].level, 1);
  assert.strictEqual(adsr.at(0.08)[0].level, 1);
  assert.strictEqual(adsr.at(0.08, { acknowledged: false })[0].strength, 0);
});

test("AHDSR sampling preserves serialized envelope parameters", () => {
  const env = { attack: 0.1, hold: 0.1, decay: 0.2, release: 0.2, sustain: 0.2, peak: 0.8 };
  const zero = { ...env, peak: 0, sustain: 0.9 };
  const show = live('hd.simpleAdsr', { curve: 'linear', rgbEnvelope: { colourMode: 'all', r: env, g: zero, b: zero } });
  for (const [pos, level] of [[0.05, 0.4], [0.15, 0.8], [0.3, 0.5], [0.6, 0.2], [0.9, 0.1]]) {
    const slot = show.at(pos)[0]; near(slot.level, level);
    assert.deepStrictEqual(slot.colour, parseHex('#FF0000'));
  }
  const large = { attack: 0.8, hold: 0.8, decay: 0, release: 0, sustain: 0.9, peak: 0.4 };
  const normalized = live('hd.simpleAdsr', { curve: 'linear', rgbEnvelope: { colourMode: 'all', r: large, g: zero, b: zero } });
  const before = structuredClone(normalized.inst.spec);
  near(normalized.at(0.25)[0].level, 0.2);
  near(normalized.at(0.9)[0].level, 0.4);
  assert.deepStrictEqual(normalized.inst.spec, before);
});

test("single-colour envelopes normalize dim RGB", () => {
  const flat = { attack: 0, hold: 1, decay: 0, release: 0, sustain: 1 };
  const out = render('hd.simpleAdsr', 0.5, room4(), { rgbEnvelope: { colourMode: 'singleColour', singleColour: '#804020', r: flat, g: flat, b: flat, brightness: flat } });
  near(out[0].level, 128 / 255);
  assert.deepStrictEqual(out[0].colour, { r: 255, g: 128, b: 64, w: 0, a: 0, uv: 0 });
});

test("cut envelope ramps jump at the phase start", () => {
  const flat = { attack: 0, hold: 1, decay: 0, release: 0, sustain: 1 };
  const cut = render('hd.simpleAdsr', 0, room4(), { curve: 'cut', rgbEnvelope: { colourMode: 'all', r: { ...flat, attack: 0.2, hold: 0.8 }, g: flat, b: flat } });
  assert.strictEqual(cut[0].level, 1);
});
