// MIDI clock out: twenty-four pulses a beat, counted off the pattern clock's
// beat position so they cannot drift from it, and no burst when the music jumps.

import test from 'node:test';
import assert from 'node:assert';

import MidiClock, { PULSES_PER_BEAT } from '../../src/midi-clock.ts';
import { Conductor } from '../../src/server/conductor.ts';

function rig({ ports = ['loopMIDI Port'] } = {}) {
  const sent = [];
  let beat = 0;
  let timer = null;
  const opened = [];
  const clock = new MidiClock({
    open: (name) => {
      if (!ports.includes(name)) return null;
      opened.push(name);
      return { send: (type) => sent.push(type), close: () => sent.push('closed') };
    },
    beatPos: () => beat,
    setInterval: (fn) => { timer = fn; return 1; },
    clearInterval: () => { timer = null; },
  });
  return {
    clock, sent, opened,
    set beat(b) { beat = b; },
    tick: () => timer && timer(),
    get ticking() { return !!timer; },
    clocks: () => sent.filter((s) => s === 'clock').length,
  };
}

test('a beat is twenty-four pulses, however the ticks fall', () => {
  const r = rig();
  r.clock.setPort('loopMIDI Port');
  assert.deepStrictEqual(r.sent, ['start']);
  assert.ok(r.ticking);
  r.beat = 10;
  r.tick();                                   // the first reading sets the count
  assert.strictEqual(r.clocks(), 0);
  // Four beats in uneven steps, as timers deliver them.
  for (const b of [10.013, 10.2, 10.21, 11.5, 12.99, 13.0, 14]) { r.beat = b; r.tick(); }
  assert.strictEqual(r.clocks(), 4 * PULSES_PER_BEAT);
  r.beat = 13.9;                              // a hair back: wait, send nothing
  r.tick();
  assert.strictEqual(r.clocks(), 96);
});

test('a jump resets the count instead of emptying a burst of pulses', () => {
  const r = rig();
  r.clock.setPort('loopMIDI Port');
  r.beat = 0; r.tick();
  r.beat = 1; r.tick();
  assert.strictEqual(r.clocks(), 24);
  r.beat = 64;                                // a seek forward
  r.tick();
  assert.strictEqual(r.clocks(), 24, 'no burst');
  r.beat = 65; r.tick();
  assert.strictEqual(r.clocks(), 48, 'and counting on from there');
  r.beat = 12;                                // a new track
  r.tick();
  r.beat = 12.5; r.tick();
  assert.strictEqual(r.clocks(), 60);
});

test('the port opens once, says start and stop, and an absent one is reported', () => {
  const r = rig();
  r.clock.setPort('loopMIDI Port');
  r.clock.setPort('loopMIDI Port');
  assert.deepStrictEqual(r.opened, ['loopMIDI Port']);
  r.clock.setPort('');
  assert.deepStrictEqual(r.sent.slice(-2), ['stop', 'closed']);
  assert.strictEqual(r.ticking, false);
  assert.deepStrictEqual(r.clock.status(), { port: null, running: false, error: null });

  r.clock.setPort('Unplugged Synth');
  assert.deepStrictEqual(r.clock.status(), { port: 'Unplugged Synth', running: false, error: 'MIDI port "Unplugged Synth" is not available' });
  assert.strictEqual(r.ticking, false);
});

test('the conductor can be read without moving it', () => {
  let now = 0;
  const c = new Conductor({ now: () => now, bpm: 120 });
  const tempos = [];
  c.onTempo((bpm) => tempos.push(bpm));
  now = 1000;
  const peeked = c.peek();
  assert.deepStrictEqual([peeked.source, peeked.bpm], ['tap', 120]);
  assert.ok(Math.abs(peeked.beatPos - 2) < 1e-9);
  assert.deepStrictEqual(tempos, [], 'no tempo report from a peek');
  assert.strictEqual(c.now().epoch, 0);
});
