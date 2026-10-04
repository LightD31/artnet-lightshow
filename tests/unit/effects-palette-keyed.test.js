import test from 'node:test';
import assert from 'node:assert/strict';
import { createPaletteAccess, preparePalette, resolvePalette, hsbToColour, parseHex } from '../../src/shared/effects/palette.ts';
import { seedFrom } from '../../src/shared/effects/hash.ts';

const spec = { kind: 'test', params: {}, palette: [{ random: true }] };
const hue = (degrees) => hsbToColour(degrees / 360, 1, 1);
const seed = seedFrom('review-selective');
const access = (state, override = null, source = spec, roll = 0) => createPaletteAccess(source, override, [], seed, roll, state);

test('ordered keyed refreshes keep the current frame and consume repeated keys once next frame', () => {
  const state = preparePalette(spec), a = access(state);
  const before = [0, 1, 6, 7].map((key) => a.colour(0, key));
  assert.deepEqual(before, [250, 0, 280, 280].map(hue));
  a.refresh(1); a.refresh(1); a.refresh(6);
  assert.deepEqual([0, 1, 6, 7].map((key) => a.colour(0, key)), before);
  const b = access(state);
  assert.deepEqual([0, 1, 6, 7].map((key) => b.colour(0, key)), [250, 60, 195, 280].map(hue));
  assert.equal(state.pending.length, 0);
  const snapshot = structuredClone(state);
  access(state);
  assert.deepEqual(state, snapshot, 'consumed requests cannot replay a second time');
});

test('pending keyed colours clone independently and fixed colours and overrides win', () => {
  const source = { ...spec, palette: ['#123456', { random: true }] };
  const state = preparePalette(source), a = access(state, null, source);
  const old = a.colour(1, 9);
  a.refresh(9);
  const clone = structuredClone(state);
  const blue = parseHex('#00F');
  const overridden = access(clone, [blue], source);
  assert.deepEqual(overridden.colour(0, 9), blue);
  assert.deepEqual(overridden.colour(5, 99), blue);
  assert.deepEqual(a.colour(1, 9), old, 'clone consumption cannot mutate the original');
  const b = access(state, null, source);
  assert.notDeepEqual(b.colour(1, 9), old);
  assert.deepEqual(b.colour(0, 9), parseHex('#123456'));
  assert.deepEqual(access(clone, null, source).colour(1, 9), b.colour(1, 9));
});

test('legacy whole-roll palette vectors stay equal when no keyed changes are requested', () => {
  const source = { ...spec, palette: Array.from({ length: 8 }, () => ({ random: true })) };
  const state = preparePalette(source);
  for (let roll = 0; roll < 20; roll++) {
    assert.deepEqual(access(state, null, source, roll).palette, resolvePalette(source, null, [], seed, roll));
  }
});

test('keyed cache exclusions cover first four keys and the refreshed key own previous hue', () => {
  const state = preparePalette(spec);
  let a = access(state);
  for (let key = 0; key < 10; key++) a.colour(0, key);
  for (let event = 0; event < 30; event++) {
    const key = event % 10, old = a.colour(0, key);
    const first = [0, 1, 2, 3].map((k) => a.colour(0, k));
    a.refresh(key); a = access(state);
    const next = a.colour(0, key);
    assert.notDeepEqual(next, old);
    for (const value of first) assert.notDeepEqual(next, value);
    assert.equal(state.pending.length, 0);
  }
  assert.throws(() => a.refresh(-1));
  assert.throws(() => a.colour(0, Infinity));
});

test('renderer checkpoints, spec changes, reset and expiry own the complete pending cache', async () => {
  const { harness, row } = await import('../helpers/ldj-harness.js');
  const h = harness('ldj.BLStrobeCycle', row(5), { spec: { palette: [{ random: true }, { random: true }] } });
  const initial = h.draw(0);
  const state = h.stepper.palette(h.inst.id, h.inst.spec, 0);
  assert.deepEqual(state.pending, [0, 1]);
  const before = structuredClone(state), clone = h.stepper.clone();
  const resumed = h.draw(.1, clone);
  assert.deepEqual(state, before, 'consuming the clone leaves live requests and counters intact');
  assert.deepEqual(h.draw(.1), resumed);
  assert.equal(state.pending.length, 0);
  h.stepper.reset();
  assert.deepEqual(h.draw(0), initial, 'reset starts with the same seed and no retained requests');
  h.stepper.sweep(2500);
  assert.deepEqual(h.draw(0), initial, 'expiry removes pending requests and kind state together');
  h.inst.spec.palette = ['#123456'];
  h.draw(.1);
  const replaced = h.stepper.palette(h.inst.id, h.inst.spec, 50);
  assert.deepEqual(replaced.entries, [parseHex('#123456')]);
  assert.equal(replaced.pending.length, 0);
  assert.ok(h.draw(1).every((s) => JSON.stringify(s.colour) === JSON.stringify(parseHex('#123456'))));
});

test('ordinary cycling wraps its cache key while explicit lamp keys stay independent', () => {
  const source = { ...spec, palette: [{ random: true }, { random: true }, '#123456'] };
  const state = preparePalette(source), a = access(state, null, source);
  assert.deepEqual(a.colour(-3), a.colour(0));
  assert.deepEqual(a.colour(30001), a.colour(1));
  assert.deepEqual(a.colour(-1), parseHex('#123456'));
  assert.equal(state.hues.length, 3, 'palette turns do not grow the cache');
  const independent = a.colour(30001, 17);
  assert.equal(state.hues.length, 18);
  a.refresh(17);
  const next = access(state, null, source);
  assert.notDeepEqual(next.colour(1, 17), independent);
  assert.deepEqual(next.colour(1), a.palette[1]);
});

test('frame colours draw independently without changing cached hues or refresh requests', () => {
  const state = preparePalette(spec), a = access(state);
  a.refresh(0);
  const before = structuredClone(state);
  const first = Array.from({ length: 8 }, (_, lamp) => a.frameColour(0, lamp, 0));
  assert.ok(new Set(first.map((c) => JSON.stringify(c))).size > 1);
  assert.deepEqual(Array.from({ length: 8 }, (_, lamp) => a.frameColour(0, lamp, 0)), first);
  assert.notDeepEqual(Array.from({ length: 8 }, (_, lamp) => a.frameColour(0, lamp, 1)), first);
  assert.deepEqual(state, before);
  const colours = Array.from({ length: 80 }, (_, frame) => a.frameColour(0, 3, frame));
  assert.ok(colours.some((c, i) => i > 0 && JSON.stringify(c) === JSON.stringify(colours[i - 1])), 'uncached draws allow repeats');
  const blue = parseHex('#00F'), override = access(preparePalette(spec), [blue]);
  assert.deepEqual(override.frameColour(0, 3, 17), blue);
});
