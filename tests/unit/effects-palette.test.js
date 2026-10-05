// tests/unit/effects-palette.test.js
import test from 'node:test';
import assert from 'node:assert';
import { parseHex, toHex, hsbToColour, samplePalette, preparePalette, resolvePalette } from '../../src/shared/effects/palette.ts';
import { seedFrom } from '../../src/shared/effects/hash.ts';

test('hex round-trips, with and without white', () => {
  assert.deepStrictEqual(parseHex('#A855F7'), { r: 168, g: 85, b: 247, w: 0, a: 0, uv: 0 });
  assert.strictEqual(toHex(parseHex('#a855f7')), '#A855F7');
  assert.strictEqual(parseHex('#FFFFFF80').w, 128);
  assert.throws(() => parseHex('red'));
});

test('HSB white, off and red', () => {
  assert.deepStrictEqual(hsbToColour(0, 0, 1), { r: 255, g: 255, b: 255, w: 0, a: 0, uv: 0 });
  assert.deepStrictEqual(hsbToColour(0.5, 1, 0), { r: 0, g: 0, b: 0, w: 0, a: 0, uv: 0 });
  assert.deepStrictEqual(hsbToColour(0, 1, 1), { r: 255, g: 0, b: 0, w: 0, a: 0, uv: 0 });
});

test('samplePalette wraps and interpolates linearly in RGB', () => {
  const red = parseHex('#FF0000'), blue = parseHex('#0000FF');
  assert.deepStrictEqual(samplePalette([red, blue], 0), red);
  assert.deepStrictEqual(samplePalette([red, blue], 1), red);
  assert.deepStrictEqual(samplePalette([red, blue], 0.25), { r: 128, g: 0, b: 128, w: 0, a: 0, uv: 0 });
  assert.deepStrictEqual(samplePalette([red], 0.7), red);
});

test('resolvePalette: override beats the effect palette beats the look', () => {
  const look = [parseHex('#00FF00')];
  const spec = { kind: 'x', params: {}, palette: ['#FF0000'] };
  assert.deepStrictEqual(resolvePalette(spec, null, look, seedFrom('s'), 0), [parseHex('#FF0000')]);
  assert.deepStrictEqual(resolvePalette({ ...spec, palette: null }, null, look, seedFrom('s'), 0), look);
  assert.deepStrictEqual(resolvePalette(spec, [parseHex('#0000FF')], look, seedFrom('s'), 0), [parseHex('#0000FF')]);
});

test('prepared palettes parse hex once per instance and keep the spec serializable', () => {
  const spec = { kind: 'x', params: {}, palette: ['#F00', '#11223344', { random: true }] };
  const before = structuredClone(spec);
  const prepared = preparePalette(spec);
  const seed = seedFrom('prepared');
  const first = resolvePalette(spec, null, [], seed, 0, prepared);
  const next = resolvePalette(spec, null, [], seed, 1, prepared);
  assert.deepStrictEqual(first.slice(0, 2), [parseHex('#F00'), parseHex('#11223344')]);
  assert.strictEqual(first[0], next[0], 'a fixed colour reuses its instance preparation');
  assert.deepStrictEqual(spec, before, 'no parsed colours or random results enter the spec');
});

test('Light DJ random hues avoid the first four cached slots and their own previous hue', () => {
  const seed = seedFrom('s');
  const spec = { kind: 'x', params: {}, palette: Array.from({ length: 8 }, () => ({ random: true })) };
  const prepared = preparePalette(spec);
  let previous = [];
  for (let roll = 0; roll < 60; roll++) {
    const current = resolvePalette(spec, null, [], seed, roll, prepared).map(toHex);
    assert.strictEqual(new Set(current.slice(0, 4)).size, 4);
    for (let index = 0; index < current.length; index++) {
      const cached = Array.from({ length: 4 }, (_, slot) => slot < index ? current[slot] : previous[slot]);
      cached.push(previous[index]);
      assert.ok(!cached.includes(current[index]), `slot ${index} repeated a cached hue on roll ${roll}`);
    }
    previous = current;
  }
});

test('a lone random colour changes on every roll', () => {
  const spec = { kind: 'x', params: {}, palette: [{ random: true }] };
  const prepared = preparePalette(spec);
  const seed = seedFrom('0');
  let previous;
  for (let roll = 0; roll < 80; roll++) {
    const current = toHex(resolvePalette(spec, null, [], seed, roll, prepared)[0]);
    assert.notStrictEqual(current, previous);
    previous = current;
  }
});

test('palette replay, seek, clone and instance isolation agree', () => {
  const spec = { kind: 'x', params: {}, palette: [{ random: true }, '#00FF00', { random: true }, { random: true }, { random: true }] };
  const seed = seedFrom('replay');
  const prepared = preparePalette(spec);
  for (let roll = 0; roll <= 12; roll++) {
    const incremental = resolvePalette(spec, null, [], seed, roll, prepared);
    assert.deepStrictEqual(incremental, resolvePalette(spec, null, [], seed, roll));
    assert.deepStrictEqual(resolvePalette(spec, null, [], seed, roll, prepared), incremental);
  }
  const clone = structuredClone(prepared);
  const cloneBefore = structuredClone(clone);
  resolvePalette(spec, null, [], seed, 20, prepared);
  assert.deepStrictEqual(clone, cloneBefore, 'another instance does not share the hue cache');
  assert.deepStrictEqual(resolvePalette(spec, null, [], seed, 20, clone), resolvePalette(spec, null, [], seed, 20, prepared));
  assert.deepStrictEqual(resolvePalette(spec, null, [], seed, 3, prepared), resolvePalette(spec, null, [], seed, 3));
  const otherSeed = seedFrom('other');
  assert.deepStrictEqual(resolvePalette(spec, null, [], otherSeed, 4, prepared), resolvePalette(spec, null, [], otherSeed, 4));
});

test('a random entry resolves to one of Light DJ\'s eight hues, stable per roll and changing with it', () => {
  const spec = { kind: 'x', params: {}, palette: [{ random: true }, { random: true }] };
  const a = resolvePalette(spec, null, [], seedFrom('s'), 3);
  assert.deepStrictEqual(a, resolvePalette(spec, null, [], seedFrom('s'), 3));
  const hues = [0, 36, 60, 120, 195, 250, 280, 325].map((h) => JSON.stringify(hsbToColour(h / 360, 1, 1)));
  for (const c of a) assert.ok(hues.includes(JSON.stringify(c)));
  assert.notStrictEqual(JSON.stringify(a[0]), JSON.stringify(a[1]), 'two random entries in one roll differ');
  const rolls = new Set(Array.from({ length: 16 }, (_, r) => JSON.stringify(resolvePalette(spec, null, [], seedFrom('s'), r))));
  assert.ok(rolls.size > 1, 'a new roll re-rolls');
});
