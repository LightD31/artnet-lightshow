// The palettes saved on this server (src/server/palette-store.ts), in
// config/palettes.json: up to eight colours each, a "random" entry kept as
// the sentinel the effects roll.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { PaletteStore, MAX_PALETTES } from '../../src/server/palette-store.ts';
import { BUILTIN_PALETTES } from '../../src/shared/effects/index.ts';

function place(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'palette-store-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, file: path.join(dir, 'palettes.json') };
}

const quietly = (t) => t.mock.method(console, 'warn', () => {});
const invalidIn = (dir) => fs.readdirSync(dir).filter((f) => f.includes('.invalid-'));
const onDisk = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const RANDOM = { random: true };

test("creating palettes normalizes colours and persists Random sentinels", (t) => {
  const { file } = place(t);
  const store = new PaletteStore(file).load();
  let heard = 0;
  store.onChange(() => { heard++; });
  const created = store.create({ name: 'Sunset', colours: ['#ff8800', 'random', '#abc', RANDOM, '#FF000080', '#00ff0000'] });
  assert.match(created.id, /^user\.[0-9a-f]{16}$/);
  assert.deepEqual(created, { id: created.id, name: 'Sunset', colours: ['#FF8800', RANDOM, '#AABBCC', RANDOM, '#FF000080', '#00FF00'] });
  assert.deepEqual(onDisk(file), { palettes: [created] });
  assert.deepEqual(new PaletteStore(file).load().list(), [created], 'a restart reads it back');
  assert.equal(heard, 1);
});

test("updating palette colours and names publishes each change", (t) => {
  const { file } = place(t);
  const store = new PaletteStore(file).load();
  let heard = 0;
  store.onChange(() => { heard++; });
  const created = store.create({ name: 'Sunset', colours: ['#ff8800', 'random', '#abc', RANDOM, '#FF000080', '#00ff0000'] });
  const recoloured = store.update(created.id, { colours: ['random'] });
  assert.deepEqual(recoloured, { ...created, colours: [RANDOM] });
  const renamed = store.update(created.id, { name: 'Dusk' });
  assert.deepEqual(renamed, { ...created, name: 'Dusk', colours: [RANDOM] });
  assert.equal(heard, 3);
});

test("unchanged palette updates avoid writes and notifications", (t) => {
  const { file } = place(t);
  const store = new PaletteStore(file).load();
  let heard = 0;
  store.onChange(() => { heard++; });
  const created = store.create({ name: 'Sunset', colours: ['#ff8800', 'random', '#abc', RANDOM, '#FF000080', '#00ff0000'] });
  store.update(created.id, { colours: ['random'] });
  const renamed = store.update(created.id, { name: 'Dusk' });
  const write = t.mock.method(store, 'write');
  assert.deepEqual(store.update(created.id, { name: 'Dusk', colours: [RANDOM] }), renamed);
  assert.deepEqual(store.update(created.id, {}), renamed);
  assert.equal(write.mock.callCount(), 0);
  assert.equal(heard, 3);
  write.mock.restore();
});

test("returned palette lists cannot mutate stored colours", (t) => {
  const { file } = place(t);
  const store = new PaletteStore(file).load();
  const created = store.create({ name: 'Sunset', colours: ['#ff8800', 'random', '#abc', RANDOM, '#FF000080', '#00ff0000'] });
  store.update(created.id, { colours: ['random'] });
  store.list()[0].colours.push('#FFFFFF');
  assert.deepEqual(store.list()[0].colours, [RANDOM]);
});

test("invalid palette edits preserve the saved collection", (t) => {
  const { file } = place(t);
  const store = new PaletteStore(file).load();
  let heard = 0;
  store.onChange(() => { heard++; });
  const created = store.create({ name: 'Sunset', colours: ['#ff8800', 'random', '#abc', RANDOM, '#FF000080', '#00ff0000'] });
  store.update(created.id, { colours: ['random'] });
  const renamed = store.update(created.id, { name: 'Dusk' });
  const refused = (fn) => assert.throws(fn, (err) => err.status === 400);
  const nine = Array.from({ length: 9 }, () => '#FFFFFF');
  refused(() => store.create({ name: 'Nine', colours: nine }));
  refused(() => store.update(created.id, { colours: nine }));
  refused(() => store.create({ name: 'None', colours: [] }));
  refused(() => store.create({ name: 'Word', colours: ['red'] }));
  refused(() => store.create({ name: 'Short', colours: ['#12345'] }));
  refused(() => store.create({ name: 'Half', colours: [{ random: false }] }));
  refused(() => store.create({ name: 'Extra', colours: [{ random: true, hue: 3 }] }));
  refused(() => store.create({ colours: ['#FFFFFF'] }));
  refused(() => store.create({ name: 'Mine', colours: ['#FFFFFF'], id: 'mine' }));
  assert.deepEqual(store.list(), [renamed]);
  assert.equal(heard, 3);
});

test("palettes accept eight colours", (t) => {
  const { file } = place(t);
  const store = new PaletteStore(file).load();
  const nine = Array.from({ length: 9 }, () => '#FFFFFF');
  const eight = store.create({ name: 'Eight', colours: nine.slice(1) });
  assert.equal(eight.colours.length, 8);
});

test("removing palettes persists deletion and ignores absent records", (t) => {
  const { file } = place(t);
  const store = new PaletteStore(file).load();
  let heard = 0;
  store.onChange(() => { heard++; });
  const created = store.create({ name: 'Sunset', colours: ['#ff8800', 'random', '#abc', RANDOM, '#FF000080', '#00ff0000'] });
  store.update(created.id, { colours: ['random'] });
  store.update(created.id, { name: 'Dusk' });
  const nine = Array.from({ length: 9 }, () => '#FFFFFF');
  const eight = store.create({ name: 'Eight', colours: nine.slice(1) });
  assert.equal(store.remove(created.id), true);
  assert.equal(store.remove(created.id), false);
  assert.equal(store.update(created.id, { name: 'Gone' }), null);
  assert.deepEqual(onDisk(file), { palettes: [eight] });
  assert.equal(heard, 5);
});

test("built-in palettes cannot be updated or removed", (t) => {
  const { file } = place(t);
  const store = new PaletteStore(file).load();
  assert.equal(store.update('redCyan', { name: 'Mine' }), null);
  assert.equal(store.remove('redCyan'), false);
});

test('one palette by id, built-in or saved, as a copy', (t) => {
  const { file } = place(t);
  const store = new PaletteStore(file).load();
  const saved = store.create({ name: 'Mine', colours: ['#FF0000', 'random'] });
  assert.deepEqual(store.get(saved.id), { source: 'user', palette: saved });
  const builtin = BUILTIN_PALETTES.find((p) => p.id === 'redCyan');
  assert.deepEqual(store.get('redCyan'), { source: 'builtin', palette: JSON.parse(JSON.stringify(builtin)) });
  assert.equal(store.get('no-such-palette'), null);

  // Changing what came back changes nothing here, nor the built-in.
  store.get(saved.id).palette.colours.push('#FFFFFF');
  store.get('redCyan').palette.colours.push('#FFFFFF');
  assert.deepEqual(store.get(saved.id).palette, saved);
  assert.deepEqual(builtin.colours, ['#FF0000', '#00BFFF']);
  store.remove(saved.id);
  assert.equal(store.get(saved.id), null);
});

test('the 129th palette is refused', (t) => {
  const { file } = place(t);
  const store = new PaletteStore(file).load();
  for (let i = 0; i < MAX_PALETTES; i++) store.create({ name: `P${i}`, colours: ['#FFFFFF'] });
  assert.equal(MAX_PALETTES, 128);
  assert.throws(() => store.create({ name: 'One too many', colours: ['#FFFFFF'] }), (err) => err.status === 400);
  assert.equal(store.list().length, 128);
  assert.equal(onDisk(file).palettes.length, 128);
});

test('a failed write changes nothing', (t) => {
  const { file } = place(t);
  const store = new PaletteStore(file).load();
  const kept = store.create({ name: 'Kept', colours: ['#FFFFFF'] });
  let heard = 0;
  store.onChange(() => { heard++; });
  quietly(t);
  t.mock.method(store, 'write', () => { throw new Error('disk full'); });
  const failed = (fn) => assert.throws(fn, (err) => err.status === 500);
  failed(() => store.create({ name: 'Lost', colours: ['#000000'] }));
  failed(() => store.update(kept.id, { colours: ['#000000'] }));
  failed(() => store.remove(kept.id));
  assert.deepEqual(store.list(), [kept]);
  assert.deepEqual(onDisk(file), { palettes: [kept] });
  assert.equal(heard, 0);
});

test("invalid palette files are quarantined", (t) => {
  const { dir, file } = place(t);
  quietly(t);
  const good = { id: 'user.0000000000000001', name: 'Good', colours: ['#FFFFFF', 'random'] };
  const cases = [
    ['a bad colour', [good, { ...good, id: 'user.2', colours: ['white'] }]],
    ['nine colours', [{ ...good, colours: Array(9).fill('#FFFFFF') }]],
    ['no colours', [{ ...good, colours: [] }]],
    ['a duplicate id', [good, good]],
    ['a built-in id', [{ ...good, id: 'redCyan' }]],
    ['too many', Array.from({ length: MAX_PALETTES + 1 }, (_, i) => ({ ...good, id: `user.${i}` }))],
    ['an unknown field', [{ ...good, createdAt: 'yesterday' }]],
  ];
  for (const [what, palettes] of cases) {
    const bytes = JSON.stringify({ palettes });
    fs.writeFileSync(file, bytes);
    const store = new PaletteStore(file).load();
    assert.deepEqual(store.list(), [], what);
    assert.equal(invalidIn(dir).length, 1, what);
    assert.equal(fs.readFileSync(path.join(dir, invalidIn(dir)[0]), 'utf8'), bytes, `${what}: recoverable`);
    for (const f of invalidIn(dir)) fs.rmSync(path.join(dir, f));
  }
});

test("legacy Random words migrate to sentinels when saved", (t) => {
  const { file } = place(t);
  const good = { id: 'user.0000000000000001', name: 'Good', colours: ['#FFFFFF', 'random'] };
  fs.writeFileSync(file, JSON.stringify({ palettes: [good] }));
  const store = new PaletteStore(file).load();
  assert.deepEqual(store.list(), [{ ...good, colours: ['#FFFFFF', RANDOM] }]);
  store.update(good.id, { name: 'Better' });
  assert.deepEqual(onDisk(file), { palettes: [{ ...good, name: 'Better', colours: ['#FFFFFF', RANDOM] }] });
});
