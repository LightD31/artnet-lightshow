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
    palette: null,
    autoIntensity: 50,
    fixtures: [
      { id: 0, label: 'PAR 1', override: null, maxBrightness: 255 },
      { id: 1, label: 'PAR 2', override: null, maxBrightness: 255 },
    ],
  };

  const patches = [];
  const overrides = [];
  const maxes = [];
  const taps = [];
  const leds = [];

  const midi = new MidiController(state, (p) => { patches.push(p); Object.assign(state, p); }, () => taps.push(Date.now()));
  midi.overrideFixture = (id, override) => overrides.push({ id, override });
  midi.setFixtureMax = (id, value) => {
    maxes.push({ id, value });
    state.fixtures[id].maxBrightness = value;
  };

  // Stand in for the easymidi Input/Output, which need a real port.
  const input = new EventEmitter();
  midi.input = input;
  const sent = [];
  midi.output = { send: (type, msg) => { sent.push({ type, ...msg }); if (type === 'noteon') leds.push({ type, ...msg }); } };
  if (map) midi.setMap(map);
  midi._bindInput();

  const cc = () => sent.filter((m) => m.type === 'cc');

  return { midi, state, input, patches, overrides, maxes, taps, leds, sent, cc };
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

// ── Motorised faders and encoder rings ──────────────────────────────────────
// The X-Touch Compact's faders are motorised and its encoders have LED rings,
// and both move by being sent the CC they would have sent us. Without this the
// surface only ever pushed state: change the master dimmer in the browser and
// the physical fader stayed put, so the next touch snapped the rig back.

test('a fader is driven to the position of what it controls', () => {
  const h = harness({ cc: { 9: { action: 'setMasterDimmer', type: 'absolute' } }, notes: {} });
  // The map is applied in the harness, which already drove the fader to the
  // starting master of 255. Move it somewhere else and watch it follow.
  h.sent.length = 0;

  h.state.masterDimmer = 0;
  h.midi.sendFeedback();
  assert.deepStrictEqual(h.cc(), [{ type: 'cc', controller: 9, value: 0, channel: 0 }]);

  h.sent.length = 0;
  h.state.masterDimmer = 255;
  h.midi.sendFeedback();
  assert.deepStrictEqual(h.cc(), [{ type: 'cc', controller: 9, value: 127, channel: 0 }]);
});

// Connecting drives the whole surface to the show, rather than leaving the
// faders wherever they were physically left.
test('applying a map pushes every mapped control at once', () => {
  const h = harness({
    cc: {
      9: { action: 'setMasterDimmer', type: 'absolute' },
      5: { action: 'setBpm', type: 'absolute' },
    },
    notes: {},
  });

  // The harness applied the map, which is what connect() does.
  assert.deepStrictEqual(h.cc().map((m) => m.controller).sort(), [5, 9]);
});

test('a relative encoder gets a value too, for its LED ring', () => {
  const h = harness({ cc: { 10: { action: 'adjustBpm', type: 'relative' } }, notes: {} });
  h.sent.length = 0;

  h.state.bpm = 160;   // (160-20)/280 = 0.5
  h.midi.sendFeedback();

  assert.strictEqual(h.cc()[0].value, 64);
});

/**
 * A fader whose feedback disagrees with what it sends would drift every time
 * the operator touched it.
 *
 * It cannot round-trip exactly in the middle of the range: a 7-bit fader has
 * 128 positions for 281 BPM values, so one step is ~2.2 BPM and 160 comes back
 * as 161. That is the hardware, not the mapping — what matters is that the
 * fader sits at the *nearest* position, so touching it moves the tempo by at
 * most one step rather than jumping.
 *
 * Fresh harness per case: a control that has sent us something is suppressed
 * for a moment afterwards, which is the point of the test below.
 */
test('the BPM fader sits at the nearest position to the live tempo', () => {
  const STEP_BPM = 280 / 127;

  for (const bpm of [20, 90, 160, 240, 300]) {
    const h = harness({ cc: { 5: { action: 'setBpm', type: 'absolute' } }, notes: {} });
    h.sent.length = 0;

    h.state.bpm = bpm;
    h.midi.sendFeedback();
    const value = h.cc()[0].value;

    // Feed that position back in as if the fader had been moved there.
    h.input.emit('cc', { controller: 5, value, channel: 0 });
    assert.ok(
      Math.abs(h.state.bpm - bpm) <= Math.ceil(STEP_BPM),
      `round trip at ${bpm} BPM landed on ${h.state.bpm}, more than one fader step away`,
    );
  }
});

test('the ends of the BPM fader are exact', () => {
  for (const bpm of [20, 300]) {
    const h = harness({ cc: { 5: { action: 'setBpm', type: 'absolute' } }, notes: {} });
    h.sent.length = 0;
    h.state.bpm = bpm;
    h.midi.sendFeedback();

    h.input.emit('cc', { controller: 5, value: h.cc()[0].value, channel: 0 });
    assert.strictEqual(h.state.bpm, bpm);
  }
});

// No override means the pattern engine owns the fixture and it is at full,
// which is where the fader should sit — ready to pull it down.
test('a fixture with no override reads as full, which is where the fader belongs', () => {
  const h = harness({ cc: { 1: { action: 'setFixtureDim', type: 'absolute', fixture: 0 } }, notes: {} });

  h.state.fixtures[0].override = { enabled: true, dim: 0 };
  h.midi.sendFeedback();
  h.sent.length = 0;

  h.state.fixtures[0].override = null;
  h.midi.sendFeedback();

  assert.strictEqual(h.cc()[0].value, 127);
});

// A motor re-driven to where it already is, at the broadcast rate, hums.
test('an unchanged position is not sent again', () => {
  const h = harness({ cc: { 9: { action: 'setMasterDimmer', type: 'absolute' } }, notes: {} });

  h.midi.sendFeedback();
  h.sent.length = 0;
  h.midi.sendFeedback();
  h.midi.sendFeedback();

  assert.deepStrictEqual(h.cc(), [], 'nothing changed, so nothing was sent');

  h.state.masterDimmer = 0;
  h.midi.sendFeedback();
  assert.strictEqual(h.cc().length, 1, 'but a real change is');
});

// Driving a fader back while a hand is on it makes the operator fight the motor.
test('a control that just sent us something is left alone', () => {
  const h = harness({ cc: { 9: { action: 'setMasterDimmer', type: 'absolute' } }, notes: {} });

  h.input.emit('cc', { controller: 9, value: 100, channel: 0 });
  h.sent.length = 0;

  // Something else moves the master while the fader is still being touched.
  h.state.masterDimmer = 12;
  h.midi.sendFeedback();

  assert.deepStrictEqual(h.cc(), [], 'the touched fader is not driven');
});

test('an untouched control is still driven while another is being moved', () => {
  const h = harness({
    cc: {
      9: { action: 'setMasterDimmer', type: 'absolute' },
      1: { action: 'setFixtureDim', type: 'absolute', fixture: 0 },
    },
    notes: {},
  });
  h.midi.sendFeedback();
  h.input.emit('cc', { controller: 9, value: 100, channel: 0 });
  h.sent.length = 0;

  h.state.masterDimmer = 5;
  h.state.fixtures[0].override = { enabled: true, dim: 0 };
  h.midi.sendFeedback();

  assert.deepStrictEqual(h.cc().map((m) => m.controller), [1], 'only the untouched one moves');
});

test('a trigger action has no position, so nothing is sent for it', () => {
  const h = harness({ cc: { 20: { action: 'tap' } }, notes: {} });
  h.sent.length = 0;

  h.midi.sendFeedback();

  assert.deepStrictEqual(h.cc(), []);
});

// A MIDI loopback would echo our feedback back in as operator input.
test('feedback can be switched off entirely', () => {
  const h = harness({ cc: { 9: { action: 'setMasterDimmer', type: 'absolute' } }, notes: {} });
  h.midi.setControlFeedback(false);
  h.sent.length = 0;

  h.state.masterDimmer = 3;
  h.midi.sendFeedback();

  assert.deepStrictEqual(h.cc(), []);

  h.midi.setControlFeedback(true);
  assert.strictEqual(h.cc().length, 1, 'and back on again resends the position');
});

// A relearned map means what we last sent no longer describes the control.
test('remapping forgets what was sent, so the surface is redriven', () => {
  const h = harness({ cc: { 9: { action: 'setMasterDimmer', type: 'absolute' } }, notes: {} });
  h.midi.sendFeedback();
  h.sent.length = 0;

  h.midi.setMap({ cc: { 9: { action: 'setMasterDimmer', type: 'absolute' } }, notes: {} });

  assert.strictEqual(h.cc().length, 1);
});

// ── Fixture max brightness ──────────────────────────────────────────────────
// A trim is not an override: a fader that pulls a lamp's ceiling down must not
// also take it out of the pattern engine.

test('a fader bound to fixture max brightness trims without overriding', () => {
  const h = harness({ cc: { 5: { action: 'setFixtureMax', type: 'absolute', fixture: 1 } }, notes: {} });

  h.input.emit('cc', { controller: 5, value: 64, channel: 0 });

  assert.deepStrictEqual(h.maxes, [{ id: 1, value: 129 }]);
  assert.deepStrictEqual(h.overrides, [], 'the fixture must not be pushed into override mode');
  assert.deepStrictEqual(h.patches, [], 'and nothing else about the show changes');
});

test('an encoder nudges fixture max brightness and clamps at the ends', () => {
  const h = harness({ cc: { 12: { action: 'adjustFixtureMax', type: 'relative', scale: 4, fixture: 0 } }, notes: {} });

  h.input.emit('cc', { controller: 12, value: 127, channel: 0 });   // one step CCW → -4
  assert.deepStrictEqual(h.maxes.at(-1), { id: 0, value: 251 });

  h.state.fixtures[0].maxBrightness = 2;
  h.input.emit('cc', { controller: 12, value: 127, channel: 0 });
  assert.deepStrictEqual(h.maxes.at(-1), { id: 0, value: 0 }, 'clamped at zero');

  h.state.fixtures[0].maxBrightness = 254;
  h.input.emit('cc', { controller: 12, value: 1, channel: 0 });     // one step CW → +4
  assert.deepStrictEqual(h.maxes.at(-1), { id: 0, value: 255 }, 'clamped at full');
});

test('a max-brightness control is driven to the trim it holds', () => {
  const h = harness({ cc: { 5: { action: 'setFixtureMax', type: 'absolute', fixture: 0 } }, notes: {} });
  h.sent.length = 0;

  h.state.fixtures[0].maxBrightness = 0;
  h.midi.sendFeedback();
  assert.deepStrictEqual(h.cc(), [{ type: 'cc', controller: 5, value: 0, channel: 0 }]);
});

// ── Auto-show intensity ─────────────────────────────────────────────────────
// The energy slider is a percentage, not a DMX level, so the fader scales to
// 0-100 rather than the 0-255 every other absolute action uses.

test('a fader bound to auto-show intensity sends 0-100, not 0-255', () => {
  const h = harness({ cc: { 8: { action: 'setAutoIntensity', type: 'absolute' } }, notes: {} });

  h.input.emit('cc', { controller: 8, value: 127, channel: 0 });
  assert.deepStrictEqual(h.patches.at(-1), { autoIntensity: 100 });

  h.input.emit('cc', { controller: 8, value: 0, channel: 0 });
  assert.deepStrictEqual(h.patches.at(-1), { autoIntensity: 0 });

  h.input.emit('cc', { controller: 8, value: 64, channel: 0 });
  assert.deepStrictEqual(h.patches.at(-1), { autoIntensity: 50 });
});

test('an encoder nudges auto-show intensity within 0-100', () => {
  const h = harness({ cc: { 17: { action: 'adjustAutoIntensity', type: 'relative', scale: 5 } }, notes: {} });

  h.input.emit('cc', { controller: 17, value: 1, channel: 0 });     // +5
  assert.deepStrictEqual(h.patches.at(-1), { autoIntensity: 55 });

  h.state.autoIntensity = 98;
  h.input.emit('cc', { controller: 17, value: 1, channel: 0 });
  assert.deepStrictEqual(h.patches.at(-1), { autoIntensity: 100 }, 'clamped at 100');

  h.state.autoIntensity = 2;
  h.input.emit('cc', { controller: 17, value: 127, channel: 0 });   // -5
  assert.deepStrictEqual(h.patches.at(-1), { autoIntensity: 0 }, 'clamped at 0');
});

test('an intensity control is driven to the slider position', () => {
  const h = harness({ cc: { 8: { action: 'setAutoIntensity', type: 'absolute' } }, notes: {} });
  h.sent.length = 0;

  h.state.autoIntensity = 100;
  h.midi.sendFeedback();
  assert.deepStrictEqual(h.cc(), [{ type: 'cc', controller: 8, value: 127, channel: 0 }]);
});

// ── Palettes ────────────────────────────────────────────────────────────────

test('a button bound to a palette selects it', () => {
  const h = harness({ cc: {}, notes: { 40: { action: 'setPalette', value: 'arctic' } } });

  h.input.emit('noteon', { note: 40, velocity: 127, channel: 0 });

  assert.deepStrictEqual(h.patches, [{ palette: 'arctic' }]);
});

test('a palette button with no palette bound does nothing', () => {
  const h = harness({ cc: {}, notes: { 40: { action: 'setPalette' } } });

  h.input.emit('noteon', { note: 40, velocity: 127, channel: 0 });

  assert.deepStrictEqual(h.patches, []);
});

test('the palette button for the look on stage is the one that lights', () => {
  const h = harness({
    cc: {},
    notes: {
      40: { action: 'setPalette', value: 'arctic' },
      41: { action: 'setPalette', value: 'volcanic' },
    },
  });
  h.state.palette = 'volcanic';
  h.leds.length = 0;

  h.midi.sendFeedback();

  assert.deepStrictEqual(
    h.leds.map((m) => [m.note, m.velocity]),
    [[40, 0], [41, 127]],
  );
});

// The map's `value` is loose — it is a pattern id, a colour index, a cue id or
// a palette name depending on the action — so a hand-edited midi-map.json can
// hold one the server rejects. This handler runs inside an easymidi callback:
// unguarded, one wrong entry takes the server down when that button is pressed.
test('a binding the server refuses leaves the surface alive', () => {
  const h = harness({ cc: {}, notes: { 40: { action: 'setPalette', value: 'not-a-look' } } });
  h.midi.apply = () => { throw new Error('patch: palette is not a known palette'); };

  assert.doesNotThrow(() => h.input.emit('noteon', { note: 40, velocity: 127, channel: 0 }));
});

test('a fader whose action the server refuses does not take the process down', () => {
  const h = harness({ cc: { 9: { action: 'setMasterDimmer', type: 'absolute' } }, notes: {} });
  h.midi.apply = () => { throw new Error('patch: masterDimmer out of range'); };

  assert.doesNotThrow(() => h.input.emit('cc', { controller: 9, value: 64, channel: 0 }));
});

// ── Relative encoder encodings ──────────────────────────────────────────────
//
// An endless encoder sends "moved a bit, this way", and there are two ways to
// spell it. Which one a controller uses is a device setting; nothing in the
// message says which. This only decoded two's complement, so a Behringer
// X-Touch — which sends binary offset, increment 65 and decrement 1 — had every
// detent read as ±63 and threw the parameter to an end stop on the first click.

test('an X-Touch encoder nudges by one detent, not to an end stop', () => {
  // Binary offset: 65 is one click clockwise, 63 is one click back.
  const h = harness({ cc: { 10: { action: 'adjustBpm', type: 'relative' } }, notes: {} });

  h.input.emit('cc', { controller: 10, value: 65, channel: 0 });
  assert.strictEqual(h.state.bpm, 121, 'clockwise is +1, not -63');

  h.input.emit('cc', { controller: 10, value: 63, channel: 0 });
  assert.strictEqual(h.state.bpm, 120, 'anticlockwise is -1, not +63');

  // A faster spin is a few detents, still not the whole range.
  h.input.emit('cc', { controller: 10, value: 67, channel: 0 });
  assert.strictEqual(h.state.bpm, 123);
});

test('the reported symptom: one click no longer pins the value at its maximum', () => {
  // Master dimmer carries a scale of 4, so the old decode moved it ±252 per
  // click — the whole 0–255 range, in either direction, from one detent.
  const h = harness({
    cc: { 11: { action: 'adjustMasterDimmer', type: 'relative', scale: 4 } }, notes: {},
  });
  h.state.masterDimmer = 128;

  h.input.emit('cc', { controller: 11, value: 63, channel: 0 });
  assert.strictEqual(h.state.masterDimmer, 124, 'down by one detent × scale');
  assert.notStrictEqual(h.state.masterDimmer, 255);

  h.input.emit('cc', { controller: 11, value: 65, channel: 0 });
  assert.strictEqual(h.state.masterDimmer, 128, 'and back up again');
});

test('a two’s-complement encoder still decodes the other way round', () => {
  const h = harness({ cc: { 10: { action: 'adjustBpm', type: 'relative' } }, notes: {} });

  h.input.emit('cc', { controller: 10, value: 1, channel: 0 });
  assert.strictEqual(h.state.bpm, 121, 'clockwise is 1 here, not 65');

  h.input.emit('cc', { controller: 10, value: 127, channel: 0 });
  assert.strictEqual(h.state.bpm, 120, 'and anticlockwise is 127');
});

test('each encoder is judged on its own values', () => {
  // A surface can mix encoder types, and one control's encoding says nothing
  // about another's.
  const h = harness({
    cc: {
      10: { action: 'adjustBpm', type: 'relative' },
      16: { action: 'adjustStrobeSpeed', type: 'relative' },
    },
    notes: {},
  });

  h.input.emit('cc', { controller: 10, value: 65, channel: 0 });   // binary offset
  h.input.emit('cc', { controller: 16, value: 1, channel: 0 });    // two's complement

  assert.strictEqual(h.state.bpm, 121, 'up one');
  assert.strictEqual(h.state.strobeSpeed, 1, 'also up one');
});

test('a no-movement message is not an edit', () => {
  // 64 means "didn't move" in binary offset. Dispatching it as a change would
  // clear the palette label and fight the control's own feedback.
  const h = harness({ cc: { 10: { action: 'adjustBpm', type: 'relative' } }, notes: {} });

  h.input.emit('cc', { controller: 10, value: 64, channel: 0 });

  assert.deepStrictEqual(h.patches, [], 'nothing sent');
  assert.strictEqual(h.state.bpm, 120);
});

test('an ambiguous first value does not lock in the wrong encoding', () => {
  // Mid-range values are reachable by a fast spin under either encoding, so
  // they are not evidence. The next unambiguous detent still settles it.
  const h = harness({ cc: { 10: { action: 'adjustBpm', type: 'relative' } }, notes: {} });

  h.input.emit('cc', { controller: 10, value: 20, channel: 0 });   // no evidence
  h.state.bpm = 120;

  h.input.emit('cc', { controller: 10, value: 65, channel: 0 });
  assert.strictEqual(h.state.bpm, 121, 'settled on binary offset by the real detent');
});
