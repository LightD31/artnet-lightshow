// tests/unit/effects-hash.test.js
import test from 'node:test';
import assert from 'node:assert';
import { hash01, seedFrom, pickNotLast, pickExcluding, permutation } from '../../src/shared/effects/hash.ts';

test("hash01 returns fractions in [0,1)", () => {
  const s = seedFrom('neon-domino');
  const a = hash01(s, 0, 0), b = hash01(s, 1, 0), c = hash01(s, 0, 1);
  for (const v of [a, b, c]) assert.ok(v >= 0 && v < 1);
});

test("hash01 repeats the same seed and keys", () => {
  const s = seedFrom('neon-domino');
  const a = hash01(s, 0, 0);
  assert.strictEqual(a, hash01(s, 0, 0));
});

test("hash01 distinguishes lamp and event keys", () => {
  const s = seedFrom('neon-domino');
  const a = hash01(s, 0, 0), b = hash01(s, 1, 0), c = hash01(s, 0, 1);
  assert.notStrictEqual(a, b);
  assert.notStrictEqual(a, c);
});

test('hash01 matches the FNV-1a reference for an all-zero seed', () => {
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < 16 + 4 + 8; i++) h = (h * 0x100000001b3n) & 0xffffffffffffffffn;   // every byte is 0, so ^= 0
  const expected = Number(h >> 11n) * 2 ** -53;
  assert.ok(Math.abs(hash01([0, 0, 0, 0], 0, 0) - expected) < 1e-15);
});

test("pickNotLast excludes the previous lamp", () => {
  const s = seedFrom('x');
  for (let i = 0; i < 200; i++) assert.notStrictEqual(pickNotLast(s, i, 5, 2), 2);
});

test("pickNotLast returns the only lamp", () => {
  const s = seedFrom('x');
  assert.strictEqual(pickNotLast(s, 3, 1, 0), 0);
});

test("pickExcluding avoids excluded lamps", () => {
  const s = seedFrom('y');
  for (let i = 0; i < 200; i++) assert.ok(![1, 3].includes(pickExcluding(s, i, 5, [1, 3])));
});

test("pickExcluding falls back when every lamp is excluded", () => {
  const s = seedFrom('y');
  assert.ok(pickExcluding(s, 0, 2, [0, 1]) < 2);
});

test("permutation contains every lamp once", () => {
  const s = seedFrom('z');
  const p0 = permutation(s, 0, 6);
  assert.deepStrictEqual([...p0].sort(), [0, 1, 2, 3, 4, 5]);
});

test("permutation changes between seeded passes", () => {
  const s = seedFrom('z');
  const p0 = permutation(s, 0, 6), p1 = permutation(s, 1, 6);
  assert.notDeepStrictEqual(p0, p1);
});
