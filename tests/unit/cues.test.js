'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { CueStore, captureLook, recallLook, MAX_CUES } = require('../../src/server/cues');
const { state } = require('../../src/server/state');
const { applyPatch, applyOverride } = require('../../src/server/patch');
const { stopEngine } = require('../../src/server/engine');

let dir;
let file;

test.beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cues-'));
  file = path.join(dir, 'cues.json');
});
test.afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

// applyPatch re-arms the beat timer, which would otherwise hold the event loop
// open and keep this process running after the last assertion.
test.after(() => stopEngine());

function store() { return new CueStore(file).load(); }

test('a missing file is a fresh, empty stack rather than an error', () => {
  assert.deepStrictEqual(store().list(), []);
});

test('cues survive a reload', () => {
  const a = store();
  const cue = a.create({ name: 'Verse' });

  const b = store();
  assert.strictEqual(b.list().length, 1);
  assert.strictEqual(b.get(cue.id).name, 'Verse');
  assert.deepStrictEqual(b.get(cue.id).look, cue.look);
});

// A hand-edit that went wrong should not stop the show, and should not throw
// the operator's other cues away either.
test('a corrupt file is moved aside and the server starts with no cues', () => {
  fs.writeFileSync(file, '{ this is not json');
  const s = store();

  assert.deepStrictEqual(s.list(), []);
  const salvaged = fs.readdirSync(dir).filter((f) => f.includes('.invalid-'));
  assert.strictEqual(salvaged.length, 1, 'the bad file is kept for recovery');
});

test('a file that fails validation is quarantined, not loaded half-way', () => {
  fs.writeFileSync(file, JSON.stringify({ cues: [{ id: 'x', name: 'no look' }] }));
  const s = store();

  assert.deepStrictEqual(s.list(), []);
  assert.ok(fs.readdirSync(dir).some((f) => f.includes('.invalid-')));
});

// Renaming used to be the moment a carefully built look got replaced by
// whatever happened to be on stage.
test('a rename leaves the stored look alone', () => {
  const s = store();
  applyPatch({ pattern: 'chase', bpm: 128 });
  const cue = s.create({ name: 'Verse' });

  applyPatch({ pattern: 'strobe', bpm: 174 });
  s.update(cue.id, { name: 'Chorus' });

  assert.strictEqual(s.get(cue.id).name, 'Chorus');
  assert.strictEqual(s.get(cue.id).look.pattern, 'chase', 'the look is untouched');
  assert.strictEqual(s.get(cue.id).look.bpm, 128);
});

test('recapture overwrites the look with what is on stage now', () => {
  const s = store();
  applyPatch({ pattern: 'chase', bpm: 128 });
  const cue = s.create({ name: 'Verse' });

  applyPatch({ pattern: 'strobe', bpm: 174 });
  s.update(cue.id, { recapture: true });

  assert.strictEqual(s.get(cue.id).look.pattern, 'strobe');
  assert.strictEqual(s.get(cue.id).look.bpm, 174);
});

test('recall puts the whole look back, including per-fixture overrides', () => {
  applyPatch({ pattern: 'chase', bpm: 128, colorA: 2, masterDimmer: 200, strobeSpeed: 0 });
  applyOverride(0, { enabled: true, r: 255, g: 0, b: 0, w: 0, a: 0, uv: 0, dim: 128, strobe: 0, blackout: false });
  const saved = captureLook();

  applyPatch({ pattern: 'rainbow', bpm: 90, colorA: 5, masterDimmer: 40 });
  applyOverride(0, null);
  applyOverride(1, { enabled: true, r: 0, g: 255, b: 0, w: 0, a: 0, uv: 0, dim: 255, strobe: 0, blackout: false });

  recallLook(saved);

  assert.strictEqual(state.pattern, 'chase');
  assert.strictEqual(state.bpm, 128);
  assert.strictEqual(state.colorA, 2);
  assert.strictEqual(state.masterDimmer, 200);
  assert.strictEqual(state.fixtures[0].override.r, 255, 'the saved override is restored');
  assert.strictEqual(state.fixtures[0].override.dim, 128);
  // A cue is the whole rig: a fixture the cue says nothing about must be
  // cleared, not left holding whatever the previous look put on it.
  assert.strictEqual(state.fixtures[1].override, null, 'fixtures outside the cue are cleared');

  applyOverride(0, null);
});

test('recall reports an unknown id instead of blacking the rig out', () => {
  const s = store();
  assert.strictEqual(s.recall('nope'), false);
  assert.strictEqual(s.remove('nope'), null);
  assert.strictEqual(s.update('nope', { name: 'x' }), null);
});

// Undo means "put that cue back", not "make a new one that looks like it": the
// delete answer has to carry enough to restore the id and the position.
test('delete hands back the cue it removed and where it was', () => {
  const s = store();
  s.create({ name: 'A' });
  const b = s.create({ name: 'B' });
  s.create({ name: 'C' });

  const removed = s.remove(b.id);

  assert.strictEqual(removed.index, 1);
  assert.strictEqual(removed.cue.id, b.id);
  assert.deepStrictEqual(s.list().map((c) => c.name), ['A', 'C']);
});

test('a restored cue keeps its id and goes back in its old slot', () => {
  const s = store();
  s.create({ name: 'A' });
  const b = s.create({ name: 'B' });
  s.create({ name: 'C' });

  const { cue, index } = s.remove(b.id);
  s.insert(cue, index);

  assert.deepStrictEqual(s.list().map((c) => c.name), ['A', 'B', 'C']);
  assert.strictEqual(s.list()[1].id, b.id, 'the same cue, not a copy');
});

// Pressing undo twice, or on a cue that has since been re-created, must not
// leave two rows claiming one id.
test('restoring a cue that is already there is refused, not duplicated', () => {
  const s = store();
  const a = s.create({ name: 'A' });
  const { cue, index } = s.remove(a.id);

  assert.ok(s.insert(cue, index));
  assert.strictEqual(s.insert(cue, index), null, 'the second undo is a no-op');
  assert.strictEqual(s.list().length, 1);
});

test('a restore survives a reload, like any other write', () => {
  const a = store();
  const cue = a.create({ name: 'Verse' });
  const { cue: removed, index } = a.remove(cue.id);
  a.insert(removed, index);

  assert.deepStrictEqual(store().list().map((c) => c.name), ['Verse']);
});

// The index is a hint from a client that may be working from a stale list.
test('an out-of-range index clamps instead of throwing', () => {
  const s = store();
  s.create({ name: 'A' });
  const b = s.create({ name: 'B' });
  const { cue } = s.remove(b.id);

  s.insert(cue, 99);

  assert.deepStrictEqual(s.list().map((c) => c.name), ['A', 'B']);
});

test('a restore is validated like any other stored cue', () => {
  const s = store();
  assert.throws(() => s.insert({ id: 'x', name: 'no look' }, 0));
  assert.strictEqual(s.list().length, 0);
});

test('reorder follows the given order and keeps ids the caller left out', () => {
  const s = store();
  const a = s.create({ name: 'A' });
  s.create({ name: 'B' });
  const c = s.create({ name: 'C' });

  // A stale client that has never seen C must not be able to drop it.
  s.reorder([c.id, a.id]);

  assert.deepStrictEqual(s.list().map((x) => x.name), ['C', 'A', 'B']);
});

test('reorder ignores ids that are not in the stack', () => {
  const s = store();
  const a = s.create({ name: 'A' });
  const b = s.create({ name: 'B' });

  s.reorder(['ghost', b.id, a.id]);

  assert.deepStrictEqual(s.list().map((x) => x.name), ['B', 'A']);
});

// Summaries ride every state broadcast, so they carry the swatch and nothing
// heavier — the per-fixture overrides stay on disk until someone asks.
test('summaries carry identity and a swatch, not the stored overrides', () => {
  const s = store();
  applyPatch({ colorA: 1, colorB: 2, colorC: 3, colorD: 4, pattern: 'chase' });
  s.create({ name: 'Verse' });

  const [summary] = s.summaries();
  assert.deepStrictEqual(Object.keys(summary).sort(),
    ['blackout', 'bpm', 'colors', 'id', 'name', 'pattern', 'updatedAt']);
  assert.deepStrictEqual(summary.colors, [1, 2, 3, 4]);
  assert.strictEqual(summary.pattern, 'chase');
});

test('the stack is capped so a stuck client cannot grow the file without bound', () => {
  const s = store();
  for (let i = 0; i < MAX_CUES; i++) s.create({ name: `Cue ${i}` });

  assert.throws(() => s.create({ name: 'one too many' }), /Cue stack is full/);
  assert.strictEqual(s.list().length, MAX_CUES);
});

// Nothing about the patch belongs in a look: recalling a cue must never
// re-address the rig or move a fixture to another universe mid-show.
test('a look holds no patch data', () => {
  const look = captureLook();
  for (const key of ['fixtures', 'artnet', 'profiles', 'universes']) {
    assert.strictEqual(look[key], undefined, `${key} must not be part of a cue`);
  }
});
