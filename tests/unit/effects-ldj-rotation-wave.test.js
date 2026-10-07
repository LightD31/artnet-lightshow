import test from 'node:test';
import assert from 'node:assert/strict';
import { createNoiseField } from '../../src/shared/effects/ldj-rotation.ts';
import { kindOf, validateSpec } from '../../src/shared/effects/registry.ts';
import { LDJ_FRAME_MS } from '../../src/shared/effects/ldj-engine.ts';
import { seedFrom } from '../../src/shared/effects/hash.ts';
import { hsbToColour, parseHex } from '../../src/shared/effects/palette.ts';
import { buildRoom } from '../../src/shared/room.ts';
import { harness, square, row, RED, CYAN } from '../helpers/ldj-harness.js';

const names = 'Swirl Rotation Beacon Perlin NorthernLights GrooveWave Ascent Vortex Impact BigRoomWave DoubleWave Swagger'.split(' ');
const at = (frame, bpm = 120) => ({ nowMs: frame * LDJ_FRAME_MS, beatPos: frame * LDJ_FRAME_MS * bpm / 60000, bpm });
const close = (actual, expected, epsilon = 1e-7) => assert.ok(Math.abs(actual - expected) < epsilon, `${actual} != ${expected}`);
const levels = (slots) => slots.map((slot) => slot.level);
const near = (actual, expected) => actual.forEach((v, i) => close(v, expected[i]));
const centreSquare = () => buildRoom(5, (i) => [0, 1, 1, 0, .5][i], (i) => [0, 0, 1, 1, .5][i], () => .5, null);

for (const name of names) test(`${name} uses an authored full-colour gradient`, () => {
  const colour = parseHex('#102030405060');
  const palette = { colours: ['#FF0000', '#00FFFF'], gradients: [{ name: 'fixed', space: 'step', wrap: false,
    stops: [{ at: 0, colour: '#102030405060' }, { at: 1, colour: '#102030405060' }] }] };
  const h = harness(`ldj.${name}`, square(), { spec: { palette } });
  const out = h.draw(at(5));
  const coloured = out.filter((slot) => Object.values(slot.colour).some((v) => v > 0));
  assert.ok(coloured.length > 0);
  for (const slot of coloured) assert.deepEqual(slot.colour, colour);
});

test('Rotation uses authored stop positions across its angular phase', () => {
  const room = { ...row(4), ringDegrees: [0, 179, 180, 359] };
  const palette = { colours: ['#00000000FF', '#0000000000FF'], gradients: [{ name: 'split', space: 'step', wrap: false,
    stops: [{ at: 0, slot: 0 }, { at: .5, slot: 1 }] }] };
  const out = harness('ldj.Rotation', room, { spec: { palette } }).draw(at(0));
  assert.deepEqual(out.map((s) => [s.colour.a, s.colour.uv]), [[255, 0], [255, 0], [0, 255], [0, 255]]);
});

test('twelve rotation and wave kinds have strict, idempotent defaults', () => {
  for (const name of names) {
    const kind = kindOf(`ldj.${name}`);
    assert.ok(kind?.stateful, name);
    const spec = validateSpec({ kind: kind.kind });
    assert.equal(spec.params.beats, 32);
    assert.deepEqual(validateSpec(spec), spec);
    assert.throws(() => validateSpec({ kind: kind.kind, params: { unknown: 1 } }));
  }
  for (const phase of [-1, 4, .5, NaN, Infinity]) assert.throws(() => validateSpec({ kind: 'ldj.BigRoomWave', params: { phase } }));
  assert.throws(() => validateSpec({ kind: 'ldj.BigRoomWave', params: { once: 1 } }));
  assert.throws(() => validateSpec({ kind: 'ldj.DoubleWave', params: { once: true } }));
});

test('Swirl samples its initial primary colour and only advances on whole lamp frames', () => {
  const h = harness('ldj.Swirl', square());
  const start = h.draw(at(0));
  near(levels(start), [.1464466154575348, .8535534143447876, .8535534143447876, .1464466154575348]);
  assert.ok(start.every((s) => s.colour.g === 255));
  assert.deepEqual(h.draw(at(.5)), start);
  near(levels(h.draw(at(90))), [.8535534143447876, .8535534143447876, .1464466154575348, .1464466154575348]);
  assert.deepEqual(h.draw(at(90)), h.draw(at(90)));
});

test('Swirl random primary and Rotation random sectors use their angular hues', () => {
  const h = harness('ldj.Swirl', square(), { spec: { palette: ['#FF0000', { random: true }] } });
  const start = h.draw(at(0));
  assert.deepEqual(levels(start), [1, 1, 1, 1]);
  assert.deepEqual(start[0].colour, hsbToColour(315 / 360, 1, 1));
  assert.deepEqual(h.draw(at(1))[0].colour, hsbToColour(316 / 360, 1, 1));
  const overridden = h.draw({ ...at(1), paletteOverride: [RED, CYAN] });
  assert.deepEqual(overridden[0].colour, CYAN);
  assert.ok(overridden[0].level < 1);
  const rotation = harness('ldj.Rotation', square(), { spec: { palette: [{ random: true }, '#FF0000'] } });
  const output = rotation.draw(at(1));
  assert.deepEqual(output[1].colour, hsbToColour(48 / 360, 1, 1));
  assert.deepEqual(output[0].colour, RED);
});

test("Rotation completes palette sectors in ninety frames", () => {
  const room = { ...row(4), ringDegrees: [0, 179, 180, 359] };
  const h = harness('ldj.Rotation', room);
  const start = h.draw(at(0));
  assert.deepEqual(start.map((s) => s.colour), [RED, RED, CYAN, CYAN]);
  assert.deepEqual(h.draw(at(90)), start);
});

test('Beacon interleaves black sectors and ramps to each lit sector centre', () => {
  const room = { ...row(5), ringDegrees: [0, 45, 90, 135, 180] };
  const out = harness('ldj.Beacon', room, { palette: [RED] }).draw(at(0));
  near(levels(out), [0, .5, 1, .5, 0]);
  assert.deepEqual(out[4].colour, parseHex('#000000'));
  const random = harness('ldj.Beacon', room, { spec: { palette: [{ random: true }] } });
  const fixed = harness('ldj.Beacon', room, { palette: [0, 36, 60, 120, 195, 250, 280, 325].map((h) => hsbToColour(h / 360, 1, 1)) });
  assert.deepEqual(random.draw(at(0)), fixed.draw(at(0)));
  assert.deepEqual(random.draw({ ...at(0), paletteOverride: [RED] }), out);
});

test('the seeded noise lattice has inclusive extent and exact float32 samples', () => {
  const seed = seedFrom('review-waves'), field = createNoiseField(seed);
  assert.equal(field.rows, 301);
  assert.equal(field.columns, 301);
  for (const [x, y, value] of [[0, 0, .5], [1, 1, .4663500189781189], [29, 29, .5332980155944824],
    [30, 30, .5], [207, 147, .5000659227371216], [186, 146, .49782830476760864], [300, 300, .5]]) assert.equal(field.at(x, y), value);
  assert.equal(field.at(301, 0), undefined, 'nothing past the edge');
  const rows = (f) => [1, 2, 3].map((x) => Array.from({ length: 301 }, (_, y) => f.at(x, y)));
  for (let word = 0; word < 4; word++) {
    const changed = [...seed]; changed[word] ^= 1;
    assert.notDeepEqual(rows(createNoiseField(changed)), rows(field), `seed word ${word}`);
  }
});

test('the noise field cannot be changed, so a clone shares it', () => {
  const field = createNoiseField(seedFrom('review-waves'));
  assert.ok(Object.isFrozen(field));
  assert.throws(() => { field.rows = 2; }, TypeError);
  assert.throws(() => { field.extra = 1; }, TypeError);
  assert.deepStrictEqual(Object.keys(field).sort(), ['columns', 'rows'], 'its values are not on it');
  assert.equal(field.at(1, 1), .4663500189781189, 'unchanged');
});

test("noise sampling preserves field coordinates and interpolation", () => {
  const perlin = harness('ldj.Perlin', row(1), { seed: 'review-waves' });
  assert.deepEqual(perlin.draw(at(0))[0].colour, CYAN);
  const table = perlin.state().noise;
  perlin.draw(at(1)); perlin.draw(at(2));
  assert.strictEqual(perlin.state().noise, table, 'the artifact is generated once');
  const northern = harness('ldj.NorthernLights', row(1), { seed: 'review-waves' });
  assert.deepEqual(northern.draw(at(0))[0].colour, parseHex('#817E7E'));
  for (const name of ['Perlin', 'NorthernLights']) {
    const random = harness(`ldj.${name}`, row(1), { seed: 'review-waves', spec: { palette: [{ random: true }] } });
    const fixed = harness(`ldj.${name}`, row(1), { seed: 'review-waves', palette: [0, 36, 60, 120, 195, 250, 280, 325].map((h) => hsbToColour(h / 360, 1, 1)) });
    assert.deepEqual(random.draw(at(0)), fixed.draw(at(0)));
    const overridden = random.draw({ ...at(0), paletteOverride: [RED] });
    assert.deepEqual(overridden, harness(`ldj.${name}`, row(1), { seed: 'review-waves', palette: [RED] }).draw(at(0)));
  }
});

test('constant-tempo rotation and noise cold samples equal stepped samples', () => {
  for (const name of ['Swirl', 'Rotation', 'Beacon', 'Perlin', 'NorthernLights']) {
    const stepped = harness(`ldj.${name}`, square(), { seed: 'review-waves' });
    let output;
    for (let frame = 0; frame <= 90; frame++) output = stepped.draw(at(frame));
    const cold = harness(`ldj.${name}`, square(), { seed: 'review-waves' });
    assert.deepEqual(cold.draw(at(90)), output, name);
    const clone = stepped.stepper.clone();
    assert.deepEqual(stepped.draw(at(91), clone), stepped.draw(at(91)), `${name} clone`);
    // The constant noise field is shared; everything the kind steps is its own.
    if (name === 'Perlin') {
      const copied = clone.get(stepped.inst.id, () => null, 0);
      assert.strictEqual(copied.noise, stepped.state().noise);
      assert.notStrictEqual(copied, stepped.state());
    }
  }
});

test("Groove retains initial phase and secondary-first colour", () => {
  const h = harness('ldj.GrooveWave', centreSquare());
  const start = h.draw(at(0));
  near(levels(start), [.9115049839019775, .24369803071022034, .2588604688644409, .9178358316421509, .644576370716095]);
  assert.ok(start.every((s) => s.colour.r === 255));
  near(levels(h.draw(at(11))), [.9995142817497253, .596293568611145, .6087954640388489, .9998798370361328, .8880876898765564]);
  near(levels(harness('ldj.GrooveWave', centreSquare(), { bpm: 128 }).draw(at(0, 128))),
    [.9249593019485474, .27652570605278015, .2915455400943756, .9307993650436401, .6701931357383728]);
});

test('radial waves use raw cube distance, opposite travel and the sine sign colour', () => {
  const impact = harness('ldj.Impact', centreSquare()), vortex = harness('ldj.Vortex', centreSquare());
  near(levels(impact.draw(at(0))), [.44401583075523376, .44401583075523376, .44401583075523376, .44401583075523376, 1]);
  const ahead = impact.draw(at(11)), back = vortex.draw(at(11));
  close(ahead[0].level, .9475476741790771); assert.deepEqual(ahead[0].colour, CYAN);
  close(back[0].level, .319614440202713); assert.deepEqual(back[0].colour, RED);
  close(harness('ldj.Impact', square(), { bpm: 128 }).draw(at(1, 128))[0].level, .5097338557243347);
  close(harness('ldj.Vortex', square(), { bpm: 128 }).draw(at(1, 128))[0].level, .3758147060871124);
});

test('Ascent has heading99 and sine phases retain integer history across a tempo edit', () => {
  const room = centreSquare(), h = harness('ldj.Ascent', room);
  const length = room.waveLength(99), distance = room.waveDistance(99);
  near(levels(h.draw(at(0))), distance.map((d) => Math.fround(Math.abs(Math.sin((length - d) / length * Math.PI / 2)))));
  h.draw(at(5));
  const noTick = h.draw({ ...at(5), bpm: 128 });
  assert.deepEqual(noTick, h.draw({ ...at(5), bpm: 128 }));
  const next = h.draw({ ...at(6), bpm: 128 });
  near(levels(next), distance.map((d) => Math.fround(Math.abs(Math.sin(((length - d) + 6 / 21 * length) / length * Math.PI / 2)))));
});

test('sine waves queue their selective refresh after sampling once per whole frame', () => {
  for (const [name, first, second] of [['Ascent', 20, 66], ['Impact', 20, 66], ['GrooveWave', 22, 112]]) {
    const h = harness(`ldj.${name}`, square(), { spec: { palette: [{ random: true }, { random: true }] } });
    h.draw(at(first - 1));
    const prepared = h.stepper.palette(h.inst.id, h.inst.spec, 0);
    assert.deepEqual(prepared.pending, []);
    h.draw(at(first)); assert.deepEqual(prepared.pending, [1], name);
    const before = [...prepared.counters];
    h.draw(at(first)); assert.deepEqual(prepared.pending, []);
    assert.equal(prepared.counters[1], before[1] + 1);
    h.draw(at(first)); assert.deepEqual(prepared.pending, []);
    h.draw(at(second)); assert.deepEqual(prepared.pending, [0], name);
  }
  const vortex = harness('ldj.Vortex', square(), { spec: { palette: [{ random: true }] } });
  vortex.draw(at(200));
  assert.deepEqual(vortex.stepper.palette(vortex.inst.id, vortex.inst.spec, 0).pending, []);
});

test('transition fronts use real RGB interpolation and own black', () => {
  const room = { ...row(5), waveLength: () => 1, waveDistance: () => [0, .375, .75, 1, 1.125] };
  const h = harness('ldj.BigRoomWave', room, { params: { once: true } });
  const start = h.draw(at(0));
  assert.deepEqual(start.map((s) => s.colour), [CYAN, parseHex('#808080'), RED, RED, RED]);
  assert.ok(start.every((s) => s.level === 1 && s.strength === 1));
  const after = h.draw(at(11));
  assert.deepEqual(after[3].colour, CYAN);
  assert.deepEqual(harness('ldj.BigRoomWave', room, { params: { once: true }, palette: [RED, parseHex('#000000')] }).draw(at(0))[0],
    { colour: parseHex('#000000'), level: 1, strength: 1 });
});

test('transition progress accumulates the tempo of each whole local frame', () => {
  const h = harness('ldj.BigRoomWave', square(), { params: { once: true } });
  h.draw(at(0)); h.draw(at(5)); close(h.state().progress, 5 / 11);
  h.draw({ ...at(5), bpm: 128 }); close(h.state().progress, 5 / 11);
  h.draw({ ...at(6), bpm: 128 }); close(h.state().progress, .5515151515151515);
  const faster = harness('ldj.BigRoomWave', square(), { params: { once: true }, bpm: 128 });
  faster.draw(at(11, 128)); close(faster.state().progress, 16 / 15);
});

test('recreation resets the front and its local frame clock at the musical deadline', () => {
  for (const [name, cadence] of [['BigRoomWave', .9], ['DoubleWave', .5], ['Swagger', 1]]) {
    const h = harness(`ldj.${name}`, square());
    h.draw(0); h.draw(cadence - 1e-5);
    assert.equal(h.state().recreation, 0);
    h.draw(cadence); assert.equal(h.state().recreation, 1); close(h.state().progress, 0);
    h.draw({ nowMs: cadence * 500 + LDJ_FRAME_MS / 2, beatPos: cadence + LDJ_FRAME_MS / 1000, bpm: 120 });
    close(h.state().progress, 0);
    h.draw({ nowMs: cadence * 500 + LDJ_FRAME_MS, beatPos: cadence + LDJ_FRAME_MS / 500, bpm: 120 });
    close(h.state().progress, 1 / 11);
  }
});

test('transition recreation preserves all direction and alternating endpoint phases', () => {
  const h = harness('ldj.DoubleWave', square());
  const headings = [], colours = [];
  for (const beatPos of [0, .5, 1, 1.5, 2]) {
    h.draw(beatPos); headings.push(h.state().heading); colours.push(h.state().phase % 2);
  }
  assert.deepEqual(headings, [0, 0, 180, 180, 0]); assert.deepEqual(colours, [0, 1, 0, 1, 0]);
  const swagger = harness('ldj.Swagger', square());
  for (let i = 0; i < 14; i++) { swagger.draw(i); close(swagger.state().heading, (180 / 7 + 360 * (i % 7) / 7) % 360); }
});

test('BigRoom one-shot phases remain independent and do not recreate or refresh later', () => {
  for (let phase = 0; phase < 4; phase++) {
    const h = harness('ldj.BigRoomWave', square(), { params: { phase, once: true }, spec: { palette: [{ random: true }, { random: true }] } });
    h.draw(0);
    const prepared = h.stepper.palette(h.inst.id, h.inst.spec, 0);
    assert.deepEqual(prepared.pending, [phase % 2 ? 0 : 1]);
    h.draw(0); const counters = [...prepared.counters];
    h.draw(4); assert.equal(h.state().recreation, 0); assert.equal(h.state().phase, phase);
    assert.equal(h.state().heading, phase < 2 ? 0 : 180);
    assert.deepEqual(prepared.pending, []); assert.deepEqual(prepared.counters, counters);
    close(h.state().progress, 4);
    const copy = h.stepper.clone(); assert.deepEqual(h.draw(5, copy), h.draw(5));
  }
  const cold = harness('ldj.BigRoomWave', square(), { params: { phase: 1, once: true } });
  const output = cold.draw(4); assert.ok(output.every((s) => s.colour.r === 255));
  assert.deepEqual(harness('ldj.BigRoomWave', square()).draw(0), harness('ldj.BigRoomWave', square(), { params: { phase: 0, once: false } }).draw(0));
});

test('authored transition gradients retain their captured random slots', () => {
  const palette = { colours: [{ random: true }, { random: true }], gradients: [{ name: 'front', space: 'rgb', wrap: false,
    stops: [{ at: 0, slot: 0 }, { at: 1, slot: 1 }] }] };
  const h = harness('ldj.BigRoomWave', square(), { params: { once: true }, spec: { palette } });
  h.draw(at(0));
  const captured = h.draw(at(0));
  const prepared = h.stepper.palette(h.inst.id, h.inst.spec, 0);
  prepared.pending.push(0, 1);
  assert.deepEqual(h.draw(at(0)), captured);
  assert.deepEqual(h.draw(at(0), h.stepper.clone()), captured);
});

test("transition endpoints capture pending refreshes once", () => {
  const room = { ...row(2), waveLength: () => 1, waveDistance: () => [0, 1] };
  const h = harness('ldj.BigRoomWave', room, { params: { once: true }, spec: { palette: [{ random: true }, { random: true }] } });
  const initial = h.draw(at(0)), pendingClone = h.stepper.clone();
  const captured = h.draw(at(0));
  assert.notDeepEqual(captured[0].colour, initial[0].colour, 'the new behind colour appears on the next render');
  assert.deepEqual(h.draw(at(0), pendingClone), captured, 'pending capture survives clone');
  h.stepper.palette(h.inst.id, h.inst.spec, 0).pending.push(0, 1);
  assert.deepEqual(h.draw(at(0)), captured, 'later random rolls leave this front endpoints alone');
  const override = h.draw({ ...at(0), paletteOverride: [RED, CYAN] });
  assert.deepEqual(override.map((s) => s.colour), [CYAN, RED]);
  close(h.state().progress, 0);
  const restored = h.draw(at(0));
  assert.notDeepEqual(restored, override);
  assert.deepEqual(h.draw(at(0)), restored);
  h.inst.spec.palette = ['#FFFFFF', '#000000'];
  assert.deepEqual(h.draw(at(0)).map((s) => s.colour), [parseHex('#000000'), parseHex('#FFFFFF')]);
});

test("sparse transitions interpolate recreation time through tempo edits", () => {
  const h = harness('ldj.DoubleWave', square());
  h.draw(0); h.draw({ nowMs: 200, beatPos: .4, bpm: 120 });
  h.draw({ nowMs: 400, beatPos: .4 + 200 * 128 / 60000, bpm: 128 });
  assert.equal(h.state().recreation, 1);
  close(h.state().frontMs, 246.875);
  close(h.state().progress, 3 * 16 / 165);
});

test('wave geometry retains integer projection and finite normalized heading caches', () => {
  const room = centreSquare();
  assert.deepEqual(room.waveDistance(90), [2, 2, 0, 0, 1]);
  assert.deepEqual(room.waveDistance(270), [0, 0, 2, 2, 1]);
  assert.equal(room.waveLength(90), 2.75);
  assert.equal(room.waveLength(0), 1.75);
  assert.deepEqual(room.waveDistance(0), room.waveDistance(360));
  assert.equal(room.waveLength(0, 1), room.waveLength(0, 4));
  near(room.waveDistance(0), [.7853582896777438, 2.792385029965311, 2.7574802170907446, .7504534768031773, 1.7801454566028858]);
});

test("wave relaunches retain whole-frame identity", () => {
  const shifted = harness('ldj.Swirl', square(), { startedAtMs: 12345 });
  const original = harness('ldj.Swirl', square());
  for (const frame of [0, .5, 1, 10]) assert.deepEqual(shifted.draw({ ...at(frame), nowMs: 12345 + frame * LDJ_FRAME_MS }), original.draw(at(frame)));
  const room = square(), h = harness('ldj.DoubleWave', room, { spec: { palette: [{ random: true }, { random: true }] } });
  h.draw(0); h.draw(0);
  h.draw(2);
  assert.equal(h.state().recreation, 4);
  const prepared = h.stepper.palette(h.inst.id, h.inst.spec, 0);
  assert.deepEqual(prepared.pending, [0, 1, 0, 1]);
  const clone = h.stepper.clone();
  assert.deepEqual(h.draw(2, clone), h.draw(2));
  assert.equal(h.state().pendingCapture, false);
  assert.deepEqual(prepared.pending, []);
});

test("rotation and wave kinds render finite output on small rigs", () => {
  for (const name of names) for (const n of [0, 1]) {
    const h = harness(`ldj.${name}`, row(n), { palette: [RED] });
    for (const frame of [0, .5, 1, 50]) {
      const out = h.draw(at(frame)); assert.equal(out.length, n);
      for (const slot of out) {
        assert.ok(Number.isFinite(slot.level) && slot.level >= 0 && slot.level <= 1, name);
        assert.ok(Object.values(slot.colour).every((v) => Number.isFinite(v) && v >= 0 && v <= 255), name);
      }
    }
  }
});

test('invalid clocks fail before an unbounded replay', () => {
  for (const name of ['Swirl', 'GrooveWave', 'BigRoomWave']) for (const nowMs of [NaN, Infinity, Number.MAX_VALUE]) {
    assert.throws(() => harness(`ldj.${name}`, square()).draw({ nowMs, beatPos: 0, bpm: 120 }));
  }
});
