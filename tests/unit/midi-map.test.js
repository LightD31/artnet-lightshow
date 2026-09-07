'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  MidiMapStore, DEFAULT_MAP, ACTIONS, defaultTypeFor, sameControl, mapSchema,
} = require('../../src/server/midi-map');

let dir;
let file;

test.beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'midimap-'));
  file = path.join(dir, 'midi-map.json');
});
test.afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function store() { return new MidiMapStore(file).load(); }

test('the built-in default is a valid map', () => {
  assert.doesNotThrow(() => mapSchema.parse(DEFAULT_MAP));
});

test('every default binding names an action in the catalogue', () => {
  const known = new Set(ACTIONS.map((a) => a.id));
  for (const side of ['cc', 'notes']) {
    for (const [number, binding] of Object.entries(DEFAULT_MAP[side])) {
      assert.ok(known.has(binding.action), `${side} ${number} → unknown action "${binding.action}"`);
    }
  }
});

// No file is the normal state until the operator changes something, and until
// then the X-Touch layout has to keep working exactly as it did.
test('with no stored file the default map is live and unmarked', () => {
  const s = store();
  assert.deepStrictEqual(s.get(), DEFAULT_MAP);
  assert.strictEqual(s.snapshot().customised, false);
});

test('a stored map survives a reload and is marked as customised', () => {
  const a = store();
  a.setBinding('notes', 60, { action: 'tap' });

  const b = store();
  assert.deepStrictEqual(b.get().notes['60'], { action: 'tap' });
  assert.strictEqual(b.snapshot().customised, true);
});

// A bad hand-edit should cost you your mapping, not your show.
test('a corrupt file is moved aside and the default map is used', () => {
  fs.writeFileSync(file, 'not json at all');
  const s = store();

  assert.deepStrictEqual(s.get(), DEFAULT_MAP);
  assert.strictEqual(s.snapshot().customised, false);
  assert.ok(fs.readdirSync(dir).some((f) => f.includes('.invalid-')));
});

test('a map naming an action that does not exist is quarantined', () => {
  fs.writeFileSync(file, JSON.stringify({ cc: {}, notes: { 1: { action: 'launchTheMissiles' } } }));
  const s = store();

  assert.deepStrictEqual(s.get(), DEFAULT_MAP);
  assert.ok(fs.readdirSync(dir).some((f) => f.includes('.invalid-')));
});

// Relearning "tap tempo" onto another button should leave one tap button, not
// two — the old one would otherwise keep firing from wherever it used to be.
test('relearning an action moves it instead of duplicating it', () => {
  const s = store();
  s.setBinding('notes', 60, { action: 'tap' });
  s.setBinding('notes', 61, { action: 'tap' });

  assert.strictEqual(s.get().notes['60'], undefined, 'the old button is released');
  assert.deepStrictEqual(s.get().notes['61'], { action: 'tap' });
});

test('an action moves across message kinds too', () => {
  const s = store();
  s.setBinding('cc', 20, { action: 'setMasterDimmer', type: 'absolute' });
  s.setBinding('notes', 20, { action: 'setMasterDimmer' });

  assert.strictEqual(s.get().cc['20'], undefined, 'the fader is released');
  assert.ok(s.get().notes['20']);
});

// Two "fixture dimmer" bindings for different fixtures are genuinely different
// controls, and rebinding one must not silently unbind the other.
test('bindings that differ by parameter are left alone', () => {
  const s = store();
  s.setBinding('cc', 30, { action: 'adjustFixtureDim', type: 'relative', fixture: 0 });
  s.setBinding('cc', 31, { action: 'adjustFixtureDim', type: 'relative', fixture: 1 });

  assert.ok(s.get().cc['30'], 'fixture 0 keeps its encoder');
  assert.ok(s.get().cc['31'], 'fixture 1 gets its own');
});

test('sameControl compares the action and its parameters', () => {
  assert.ok(sameControl({ action: 'tap' }, { action: 'tap' }));
  assert.ok(sameControl({ action: 'setPattern', value: 'chase' }, { action: 'setPattern', value: 'chase' }));
  assert.ok(!sameControl({ action: 'setPattern', value: 'chase' }, { action: 'setPattern', value: 'solid' }));
  assert.ok(!sameControl({ action: 'setFixtureDim', fixture: 0 }, { action: 'setFixtureDim', fixture: 1 }));
  assert.ok(!sameControl({ action: 'tap' }, { action: 'togglePlay' }));
});

test('a binding can be cleared', () => {
  const s = store();
  s.setBinding('notes', 60, { action: 'tap' });
  s.setBinding('notes', 60, null);

  assert.strictEqual(s.get().notes['60'], undefined);
});

test('reset restores the default and removes the stored file', () => {
  const s = store();
  s.setBinding('notes', 60, { action: 'tap' });
  assert.ok(fs.existsSync(file));

  s.reset();

  assert.deepStrictEqual(s.get(), DEFAULT_MAP);
  assert.strictEqual(s.snapshot().customised, false);
  assert.strictEqual(fs.existsSync(file), false);
});

test('replace validates the whole map before adopting it', () => {
  const s = store();
  assert.throws(() => s.replace({ cc: {}, notes: { 1: { action: 'nope' } } }));
  assert.deepStrictEqual(s.get(), DEFAULT_MAP, 'a rejected map leaves the live one alone');
});

test('listeners see every change', () => {
  const s = store();
  const seen = [];
  s.onChange((map) => seen.push(Object.keys(map.notes).length));

  s.setBinding('notes', 60, { action: 'tap' });
  s.reset();

  assert.strictEqual(seen.length, 2);
});

// A learned CC has to know whether it came from an encoder or a fader, and the
// action it was learned for is the best guess available.
test('the default control type follows the action', () => {
  assert.strictEqual(defaultTypeFor('adjustBpm'), 'relative', 'encoders are relative');
  assert.strictEqual(defaultTypeFor('setMasterDimmer'), 'absolute', 'faders are absolute');
  assert.strictEqual(defaultTypeFor('nonsense'), 'absolute');
});

test('a snapshot cannot be used to mutate the live map', () => {
  const s = store();
  const snap = s.snapshot();
  snap.map.notes['99'] = { action: 'tap' };

  assert.strictEqual(s.get().notes['99'], undefined);
});
