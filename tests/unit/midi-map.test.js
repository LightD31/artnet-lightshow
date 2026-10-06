import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

import { MidiMapStore, DEFAULT_MAP, ACTIONS, defaultTypeFor, sameControl, mapSchema } from '../../src/server/midi-map.ts';
import MidiController, { MIDI_HOLD_MAX_MS } from '../../src/midi.ts';

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

test('a padPress binding names its pad, and the pad is part of which control it is', () => {
  assert.ok(ACTIONS.some((a) => a.id === 'padPress'));
  assert.ok(ACTIONS.some((a) => a.id === 'energyHold') && ACTIONS.some((a) => a.id === 'cycleEnergyEffect'));
  assert.ok(mapSchema.safeParse({ cc: {}, notes: { 40: { action: 'padPress', bank: 1, slot: 7 } } }).success);
  assert.ok(!mapSchema.safeParse({ cc: {}, notes: { 40: { action: 'padPress', bank: 2, slot: 0 } } }).success);
  assert.ok(!mapSchema.safeParse({ cc: {}, notes: { 40: { action: 'padPress' } } }).success, 'no pad, no binding');
  assert.ok(!sameControl({ action: 'padPress', bank: 0, slot: 1 }, { action: 'padPress', bank: 0, slot: 2 }));
  assert.ok(sameControl({ action: 'padPress', bank: 0, slot: 1 }, { action: 'padPress', bank: 0, slot: 1 }));
});

test('MIDI padPress maps a note to a pad press/release', () => {
  const midi = new MidiController({ fixtures: [] }, () => {}, () => {});
  const calls = [];
  midi.pads = {
    press: (bank, slot, owner, token) => calls.push(['press', bank, slot, owner, token]),
    release: (bank, slot, owner, token) => calls.push(['release', bank, slot, owner, token]),
  };
  const input = new EventEmitter();
  midi.input = input;
  midi.setMap({ cc: {}, notes: { 40: { action: 'padPress', bank: 1, slot: 2 }, 41: { action: 'padPress', bank: 0, slot: 0 } } });
  midi._bindInput();

  input.emit('noteon', { note: 40, velocity: 100, channel: 0 });
  input.emit('noteon', { note: 40, velocity: 100, channel: 0 });
  assert.equal(calls.filter((c) => c[0] === 'press').length, 1, 'a repeated note-on never presses again');
  const [, bank, slot, owner, token] = calls[0];
  assert.deepStrictEqual([bank, slot], [1, 2]);

  input.emit('noteon', { note: 41, velocity: 100, channel: 0 });
  // The map changes under the held note: its release still finds the pad it pressed.
  midi.setMap({ cc: {}, notes: {} });
  input.emit('noteoff', { note: 40, channel: 0 });
  assert.deepStrictEqual(calls.at(-1), ['release', 1, 2, owner, token]);
  input.emit('noteon', { note: 41, velocity: 0, channel: 0 });
  assert.deepStrictEqual(calls.at(-1).slice(0, 3), ['release', 0, 0]);
  assert.equal(calls.length, 4);
  midi.close();
});

// A pad bench: `launch` answers what each press launched; renew answers `live`.
function padBench(t, launch) {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const midi = new MidiController({ fixtures: [] }, () => {}, () => {});
  const calls = [];
  const c = { live: true, strobeMs: 2000 };
  midi.pads = {
    press: (bank, slot) => { calls.push(['press', bank, slot]); return launch(bank, slot); },
    renew: (bank, slot) => { calls.push(['renew', bank, slot]); return c.live; },
    release: (bank, slot) => calls.push(['release', bank, slot]),
    strobeMaxMs: () => c.strobeMs,
  };
  const input = new EventEmitter();
  midi.input = input;
  midi.setMap({ cc: {}, notes: { 40: { action: 'padPress', bank: 0, slot: 1 } } });
  midi._bindInput();
  const count = (kind) => calls.filter((x) => x[0] === kind).length;
  return { midi, input, calls, c, count };
}
const HOLD = { mode: 'hold', spec: { kind: 'chase' } };

test('MIDI padPress presses once and renews only a hold, through the renewal: a loop toggles and a once fires on the note-on alone', (t) => {
  const modes = { hold: HOLD, loop: { mode: 'latched', spec: { kind: 'chase' } }, once: { mode: 'once', spec: { kind: 'chase' } }, off: null };
  for (const [name, voice] of Object.entries(modes)) {
    const { midi, input, count } = padBench(t, () => voice);
    input.emit('noteon', { note: 40, velocity: 100, channel: 0 });
    t.mock.timers.tick(4000);
    assert.equal(count('press'), 1, `${name}: pressed once`);
    assert.equal(count('renew'), name === 'hold' ? 10 : 0, `${name}: renewals`);
    input.emit('noteoff', { note: 40, channel: 0 });
    t.mock.timers.tick(4000);
    assert.deepEqual([count('press'), count('renew') <= 10], [1, true], `${name}: nothing after the note-off`);
    midi.close();
    t.mock.timers.reset();
  }
});

test('MIDI padPress stops renewing and lets go when the hold ended, the input port went or the ceiling came: the strobe cap for a strobe pad, MIDI_HOLD_MAX_MS for any other', (t) => {
  // The hold ended on the server (an off, a stop-all): no renewal brings it back.
  let b = padBench(t, () => HOLD);
  b.input.emit('noteon', { note: 40, velocity: 100, channel: 0 });
  b.c.live = false;
  t.mock.timers.tick(400);
  t.mock.timers.tick(4000);
  assert.deepEqual([b.count('press'), b.count('renew'), b.count('release')], [1, 1, 1]);
  b.midi.close();
  t.mock.timers.reset();

  // The controller unplugged with the note down: the next renewal sees the port gone.
  b = padBench(t, () => HOLD);
  b.input.emit('noteon', { note: 40, velocity: 100, channel: 0 });
  t.mock.timers.tick(800);
  b.midi._portGone = () => true;
  t.mock.timers.tick(400);
  t.mock.timers.tick(4000);
  assert.deepEqual([b.count('renew'), b.count('release')], [2, 1]);
  b.midi.close();
  t.mock.timers.reset();

  // A strobe pad held past the strobe's cap (2 s here).
  b = padBench(t, () => ({ mode: 'hold', spec: { kind: 'strobe' } }));
  b.input.emit('noteon', { note: 40, velocity: 100, channel: 0 });
  t.mock.timers.tick(1600);
  assert.deepEqual([b.count('renew'), b.count('release')], [4, 0]);
  t.mock.timers.tick(400);
  assert.deepEqual([b.count('renew'), b.count('release')], [4, 1], 'let go at the cap');
  b.midi.close();
  t.mock.timers.reset();

  // Any other hold: the fixed ceiling.
  b = padBench(t, () => HOLD);
  b.input.emit('noteon', { note: 40, velocity: 100, channel: 0 });
  t.mock.timers.tick(MIDI_HOLD_MAX_MS - 400);
  assert.equal(b.count('release'), 0);
  t.mock.timers.tick(400);
  assert.equal(b.count('release'), 1);
  t.mock.timers.tick(4000);
  assert.equal(b.count('renew'), MIDI_HOLD_MAX_MS / 400 - 1);
  b.midi.close();
});
