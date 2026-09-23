// A bar profile from the numbers on the back of its manual.

import test from 'node:test';
import assert from 'node:assert';
import { barProfile } from '../../src/server/bar-profile.ts';

test('eight RGBW cells after a dimmer and a strobe', () => {
  const p = barProfile({ id: 'acme-bar-8', name: 'Acme Bar', cells: 8, firstChannel: 3, order: 'RGBW', dimmer: 1, strobe: 2 });
  assert.strictEqual(p.channelCount, 34);
  assert.deepStrictEqual(p.channelMap, { dimmer: 0, strobe: 1 });
  assert.strictEqual(p.cells.length, 8);
  assert.deepStrictEqual(p.cells[0].channelMap, { red: 2, green: 3, blue: 4, white: 5 });
  assert.deepStrictEqual(p.cells[7].channelMap, { red: 30, green: 31, blue: 32, white: 33 });
  assert.deepStrictEqual(p.channelList.slice(0, 3).map((c) => c.name), ['Dimmer', 'Strobe', 'Cell 1 Red']);
  assert.strictEqual(p.channelList[2].cell, 0);
  assert.strictEqual(p.modeName, '8 × RGBW');
});

test('cells with their own dimmer, spaced wider than their channels', () => {
  const p = barProfile({ id: 'gap-bar', name: 'Gap', cells: 4, firstChannel: 1, order: 'DRGB', stride: 5 });
  assert.deepStrictEqual(p.cells[1].channelMap, { dimmer: 5, red: 6, green: 7, blue: 8 });
  assert.strictEqual(p.channelCount, 19, 'the gap after the last cell is not part of it');
  assert.deepStrictEqual(p.channelMap, {});
});

test('numbers that do not describe a bar that fits are refused', () => {
  const base = { id: 'x', name: 'X', cells: 8, firstChannel: 1, order: 'RGB' };
  assert.throws(() => barProfile({ ...base, cells: 1025 }), /cells/, 'no more than 1,024');
  assert.throws(() => barProfile({ ...base, order: 'RGBR' }), /each letter once/);
  assert.throws(() => barProfile({ ...base, order: 'D' }), /at least one colour/);
  assert.throws(() => barProfile({ ...base, stride: 2 }), /cannot start 2 apart/);
  assert.doesNotThrow(() => barProfile({ ...base, cells: 170, firstChannel: 3 }), 'ends exactly on 512');
  assert.throws(() => barProfile({ ...base, cells: 170, firstChannel: 4 }), /past the 512-channel universe/);
  assert.throws(() => barProfile({ ...base, dimmer: 2 }), /fixture-level channel/, 'a shared channel inside a cell');
  assert.throws(() => barProfile({ ...base, id: 'Has Spaces' }), /lowercase/);
  assert.throws(() => barProfile({ ...base, extra: 1 }), /Unrecognized/);
});
