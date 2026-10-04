// tests/unit/effects-palette.test.js
import test from 'node:test';
import assert from 'node:assert';
import { parseHex, toHex, hsbToColour, samplePalette, resolvePalette } from '../../src/shared/effects/palette.ts';
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
  const spec = { kind: 'x', params: {}, palette: [parseHex('#FF0000')] };
  assert.deepStrictEqual(resolvePalette(spec, null, look, seedFrom('s'), 0), [parseHex('#FF0000')]);
  assert.deepStrictEqual(resolvePalette({ ...spec, palette: null }, null, look, seedFrom('s'), 0), look);
  assert.deepStrictEqual(resolvePalette(spec, [parseHex('#0000FF')], look, seedFrom('s'), 0), [parseHex('#0000FF')]);
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
