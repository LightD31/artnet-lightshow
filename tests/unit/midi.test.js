'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');

const MidiController = require('../../src/midi');

// A stand-in for the state the controller reads and the callbacks it drives, so
// these tests need neither a MIDI port nor the engine.
function harness(map) {
  const state = {
    bpm: 120,
    beatDivision: 1,
    running: true,
    pattern: 'chase',
    colorA: 0, colorB: 6, colorC: 4, colorD: 8,
    masterDimmer: 255,
    masterBlackout: false,
    strobeSpeed: 0,
    strobeFunction: 'standard',
    energyOverride: null,
    fixtures: [
      { id: 0, label: 'PAR 1', override: null },
      { id: 1, label: 'PAR 2', override: null },
    ],
  };

  const patches = [];
  const overrides = [];
  const taps = [];
  const leds = [];

  const midi = new MidiController(state, (p) => { patches.push(p); Object.assign(state, p); }, () => taps.push(Date.now()));
  midi.overrideFixture = (id, override) => overrides.push({ id, override });

  // Stand in for the easymidi Input/Output, which need a real port.
  const input = new EventEmitter();
  midi.input = input;
  midi.output = { send: (type, msg) => leds.push({ type, ...msg }) };
  if (map) midi.setMap(map);
  midi._bindInput();

  return { midi, state, input, patches, overrides, taps, leds };
}

test('a mapped note fires its action', () => {
  const h = harness({ cc: {}, notes: { 40: { action: 'toggleBlackout' } } });

  h.input.emit('noteon', { note: 40, velocity: 127, channel: 0 });

  assert.deepStrictEqual(h.patches, [{ masterBlackout: true }]);
});

test('an unmapped note does nothing', () => {
  const h = harness({ cc: {}, notes: {} });

  h.input.emit('noteon', { note: 40, velocity: 127, channel: 0 });

  assert.deepStrictEqual(h.patches, []);
});

// A controller whose second layer repeats the same note numbers on another
// channel was previously indistinguishable from the first.
test('a binding with a channel only fires on that channel', () => {
  const h = harness({ cc: {}, notes: { 40: { action: 'togglePlay', channel: 5 } } });

  h.input.emit('noteon', { note: 40, velocity: 127, channel: 0 });
  assert.deepStrictEqual(h.patches, [], 'wrong channel is ignored');

  h.input.emit('noteon', { note: 40, velocity: 127, channel: 5 });
  assert.deepStrictEqual(h.patches, [{ running: false }]);
});

test('a binding with no channel fires on any channel', () => {
  const h = harness({ cc: {}, notes: { 40: { action: 'tap' } } });

  h.input.emit('noteon', { note: 40, velocity: 127, channel: 9 });

  assert.strictEqual(h.taps.length, 1);
});

test('a relative encoder nudges and clamps', () => {
  const h = harness({ cc: { 10: { action: 'adjustBpm', type: 'relative', scale: 2 } }, notes: {} });

  h.input.emit('cc', { controller: 10, value: 3, channel: 0 });     // +3 * 2
  assert.strictEqual(h.state.bpm, 126);

  h.input.emit('cc', { controller: 10, value: 126, channel: 0 });   // -2 * 2
  assert.strictEqual(h.state.bpm, 122);

  h.state.bpm = 299;
  h.input.emit('cc', { controller: 10, value: 20, channel: 0 });
  assert.strictEqual(h.state.bpm, 300, 'clamped at the top of the range');
});

test('an absolute fader scales 0-127 onto the control range', () => {
  const h = harness({ cc: { 9: { action: 'setMasterDimmer', type: 'absolute' } }, notes: {} });

  h.input.emit('cc', { controller: 9, value: 127, channel: 0 });
  assert.strictEqual(h.state.masterDimmer, 255);

  h.input.emit('cc', { controller: 9, value: 0, channel: 0 });
  assert.strictEqual(h.state.masterDimmer, 0);
});

test('a BPM fader spans the usable tempo range, not 0-255', () => {
  const h = harness({ cc: { 5: { action: 'setBpm', type: 'absolute' } }, notes: {} });

  h.input.emit('cc', { controller: 5, value: 0, channel: 0 });
  assert.strictEqual(h.state.bpm, 20);

  h.input.emit('cc', { controller: 5, value: 127, channel: 0 });
  assert.strictEqual(h.state.bpm, 300);
});

test('an energy button is momentary: held on, released off', () => {
  const h = harness({ cc: {}, notes: { 7: { action: 'energyHold', value: 'blinder' } } });

  h.input.emit('noteon', { note: 7, velocity: 127, channel: 0 });
  assert.strictEqual(h.state.energyOverride, 'blinder');

  h.input.emit('noteoff', { note: 7, channel: 0 });
  assert.strictEqual(h.state.energyOverride, null);
});

// Many controllers send note-on with velocity 0 rather than a note-off.
test('note-on with velocity 0 releases a held energy button', () => {
  const h = harness({ cc: {}, notes: { 7: { action: 'energyHold' } } });

  h.input.emit('noteon', { note: 7, velocity: 127, channel: 0 });
  assert.strictEqual(h.state.energyOverride, 'white-strobe');

  h.input.emit('noteon', { note: 7, velocity: 0, channel: 0 });
  assert.strictEqual(h.state.energyOverride, null);
});

test('cue recall goes through the callback the server wires in', () => {
  const h = harness({ cc: {}, notes: { 50: { action: 'recallCue', value: 'abc123' } } });
  const recalled = [];
  h.midi.recallCue = (id) => recalled.push(id);

  h.input.emit('noteon', { note: 50, velocity: 127, channel: 0 });

  assert.deepStrictEqual(recalled, ['abc123']);
});

test('a cue button on a rig with no cue store does nothing rather than throwing', () => {
  const h = harness({ cc: {}, notes: { 50: { action: 'recallCue', value: 'abc123' } } });

  assert.doesNotThrow(() => h.input.emit('noteon', { note: 50, velocity: 127, channel: 0 }));
});

// ── Learn mode ──────────────────────────────────────────────────────────────

test('learn captures the next note and does not fire the action bound to it', async () => {
  const h = harness({ cc: {}, notes: { 40: { action: 'toggleBlackout' } } });

  const pending = h.midi.startLearn({ action: 'tap' });
  assert.strictEqual(h.midi.learning, true);

  h.input.emit('noteon', { note: 40, velocity: 127, channel: 3 });
  const captured = await pending;

  assert.deepStrictEqual(captured, {
    kind: 'notes', number: 40, channel: 3, binding: { action: 'tap' },
  });
  assert.deepStrictEqual(h.patches, [], 'the message was consumed, not dispatched');
  assert.strictEqual(h.midi.learning, false);
});

test('learn captures a CC as well as a note', async () => {
  const h = harness({ cc: { 10: { action: 'adjustBpm', type: 'relative' } }, notes: {} });

  const pending = h.midi.startLearn({ action: 'setMasterDimmer', type: 'absolute' });
  h.input.emit('cc', { controller: 10, value: 64, channel: 0 });
  const captured = await pending;

  assert.strictEqual(captured.kind, 'cc');
  assert.strictEqual(captured.number, 10);
  assert.strictEqual(h.state.bpm, 120, 'the encoder did not also move the BPM');
});

test('cancelling learn resolves with nothing and re-arms normal dispatch', async () => {
  const h = harness({ cc: {}, notes: { 40: { action: 'toggleBlackout' } } });

  const pending = h.midi.startLearn({ action: 'tap' });
  h.midi.cancelLearn();
  assert.strictEqual(await pending, null);

  h.input.emit('noteon', { note: 40, velocity: 127, channel: 0 });
  assert.deepStrictEqual(h.patches, [{ masterBlackout: true }], 'messages dispatch again');
});

// Arming a second learn while one is pending used to leave the first waiting
// forever, and its caller's request with it.
test('arming a second learn releases the first', async () => {
  const h = harness({ cc: {}, notes: {} });

  const first = h.midi.startLearn({ action: 'tap' });
  const second = h.midi.startLearn({ action: 'togglePlay' });

  assert.strictEqual(await first, null);

  h.input.emit('noteon', { note: 41, velocity: 127, channel: 0 });
  assert.deepStrictEqual((await second).binding, { action: 'togglePlay' });
});

test('learn listeners see arming, capture and cancellation', async () => {
  const h = harness({ cc: {}, notes: {} });
  const events = [];
  h.midi.onLearn((e) => events.push(e.status));

  const pending = h.midi.startLearn({ action: 'tap' });
  h.input.emit('noteon', { note: 41, velocity: 127, channel: 0 });
  await pending;

  const second = h.midi.startLearn({ action: 'tap' });
  h.midi.cancelLearn();
  await second;

  assert.deepStrictEqual(events, ['armed', 'captured', 'armed', 'cancelled']);
});

// ── LED feedback ────────────────────────────────────────────────────────────

// Feedback used to be a hardcoded note list, so a relearned layout kept
// lighting the buttons the X-Touch originally had.
test('feedback lights the notes the map actually binds', () => {
  const h = harness({
    cc: {},
    notes: {
      70: { action: 'setPattern', value: 'chase' },
      71: { action: 'setPattern', value: 'solid' },
      72: { action: 'togglePlay' },
      73: { action: 'toggleBlackout' },
    },
  });

  h.leds.length = 0;
  h.midi.sendFeedback();

  const lit = Object.fromEntries(h.leds.map((l) => [l.note, l.velocity]));
  assert.strictEqual(lit[70], 127, 'the live pattern is lit');
  assert.strictEqual(lit[71], 0, 'the others are not');
  assert.strictEqual(lit[72], 127, 'running');
  assert.strictEqual(lit[73], 0, 'not blacked out');
});

test('feedback says nothing about a button with no on/off state', () => {
  const h = harness({ cc: {}, notes: { 80: { action: 'tap' } } });

  h.leds.length = 0;
  h.midi.sendFeedback();

  assert.deepStrictEqual(h.leds, [], 'tap tempo has no state to show');
});
