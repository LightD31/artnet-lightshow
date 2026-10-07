// The sequencer's transport (src/server/sequencer.ts): playing, pausing,
// stopping and moving a loaded sequence; Light DJ's command rows and its
// tempo and brightness automation; what the renderer then plays from the
// transport each frame (src/shared/effects/sequence.ts).

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { z } from 'zod';

import { Sequencer, automationValue, MAX_FRAME_OPERATIONS } from '../../src/server/sequencer.ts';
import { createRenderer } from '../../src/server/renderer.ts';
import * as universes from '../../src/server/universes.ts';
import { getProfile, profilesRevision, BUILTIN_PROFILE_ID } from '../../src/server/profiles.ts';
import { FRAME_MS, hrtimeMs } from '../../src/server/frame-clock.ts';
import { transmitConfig } from '../../src/server/output.ts';
import { BUILTIN_PALETTES } from '../../src/shared/effects/index.ts';
import { registerKind, validateSpec } from '../../src/shared/effects/registry.ts';
import { playingClips, resyncPosition, sequencePlace } from '../../src/shared/effects/sequence.ts';
import { seedFrom } from '../../src/shared/effects/hash.ts';

// A kind that paints its first colour.
registerKind({
  kind: 'test.trPaint', app: 'own', schema: z.object({}).strict(), defaults: { params: {}, palette: ['#FFFFFF'] },
  init: () => null,
  render(_params, _state, room, frame, out) {
    for (let i = 0; i < room.n; i++) out[i] = { colour: { ...frame.palette[0] }, level: 1, strength: 1 };
  },
});
// A kind that moves every frame: its red counts its renders, its blue its lap.
const probeLog = [];
registerKind({
  kind: 'test.trProbe', app: 'own', schema: z.object({}).strict(), defaults: { params: {} }, stateful: true,
  init: () => ({ renders: 0 }),
  render(_params, s, room, frame, out) {
    s.renders++;
    probeLog.push({ id: frame.instanceId, renders: s.renders, anchorBeat: frame.anchorBeat });
    for (let i = 0; i < room.n; i++) out[i] = { colour: { r: s.renders % 256, g: 0, b: 7, w: 0, a: 0, uv: 0 }, level: 1, strength: 1 };
  },
});

const PAINT = validateSpec({ kind: 'test.trPaint', palette: ['#00FF00'] });
const PROBE = validateSpec({ kind: 'test.trProbe' });

const lane = (id, extra = {}) => ({ id, kind: 'shared', name: id, mute: false, solo: false, ...extra });
const clip = (id, laneId, startBeat, lengthBeats, extra = {}) => ({
  id, laneId, startBeat, lengthBeats, loopBeats: lengthBeats, effect: PAINT, targets: 'lane', mute: false, ...extra,
});
const sequence = (extra = {}) => ({ id: 'set-1', name: 'Set one', lanes: [lane('a')], clips: [], ...extra });
const reading = (beatPos, { bpm = 120, epoch = 0 } = {}) => ({ beatPos, bpm, source: 'tap', epoch });

// Each built-in palette's colours as the stand-in palette store hands them out.
const PALETTE_HEX = Object.fromEntries(BUILTIN_PALETTES.map((p) => [p.id, p.colours.map((c) => (typeof c === 'string' ? c : '#123456'))]));

/**
 * A sequencer on stand-in actions: what it applies is logged and taken as the
 * live master and tempo; the clock in milliseconds is the test's.
 */
function rig({ master = 255, bpm = 120, seed = [1, 2, 3, 4], admit = () => {}, musicMode = null, onRun } = {}) {
  const live = { master, bpm, paletteOverride: null, paletteOverrideId: null, ms: 0 };
  const applied = [];
  const modes = [];
  const s = new Sequencer({
    resolve: () => null,
    palette: (id) => PALETTE_HEX[id] ?? null,
    apply: (patch) => {
      applied.push(patch);
      if (patch.masterDimmer !== undefined) live.master = patch.masterDimmer;
      if (patch.bpm !== undefined) live.bpm = patch.bpm;
      // As applyPatch: colours without a palette's name name none.
      if (patch.paletteOverride !== undefined) {
        live.paletteOverride = patch.paletteOverride;
        live.paletteOverrideId = patch.paletteOverride === null ? null : patch.paletteOverrideId ?? null;
      }
    },
    current: () => ({ masterDimmer: live.master, bpm: live.bpm, paletteOverride: live.paletteOverride, paletteOverrideId: live.paletteOverrideId }),
    musicMode: musicMode ?? ((mode) => modes.push(mode)),
    admit,
    now: () => live.ms,
    seed,
    onRun,
  });
  /** One frame at the music's beat; the sequence's position then, or null. */
  const at = (beat, opts) => {
    const frame = s.frame(reading(beat, opts));
    if (!frame.transport) return null;
    return frame.transport.hold ? frame.transport.hold.position : sequencePlace(frame.transport, beat)?.position ?? null;
  };
  /** The row or clip on top of the first lane, as the status says. */
  const top = () => s.status().lanes[0]?.clip ?? null;
  return { s, live, applied, modes, at, top };
}

const close = (actual, expected, eps = 1e-9) => assert.ok(Math.abs(actual - expected) < eps, `${actual} ≉ ${expected}`);

// ── Playlists ───────────────────────────────────────────────────────────────

const ROWS = { mode: 'playlist', lanes: [lane('rows')], clips: [clip('A', 'rows', 0, 4), clip('B', 'rows', 4, 4), clip('C', 'rows', 8, 4)] };

test('playlist semantics: one shared lane, autoplay advances at each clip\'s end; autoplay off loops the clip; next skips; shuffle picks ≠ current', () => {
  // Autoplay (the default): each row plays for its own length, then the next.
  const on = rig();
  on.s.load(sequence(ROWS));
  assert.equal(on.at(100), null, 'loaded is not playing');
  on.s.play();
  assert.equal(on.at(100), 0);
  assert.equal(on.top(), 'A');
  on.at(103.9);
  assert.equal(on.top(), 'A');
  assert.equal(on.at(104), 4);
  assert.equal(on.top(), 'B', 'A ended: B');
  on.at(109);
  assert.equal(on.top(), 'C');

  // Autoplay off: the row repeats, each time round a lap of its own, until next.
  const off = rig();
  off.s.load(sequence({ ...ROWS, options: { autoplay: false } }));
  off.s.play();
  off.at(100);
  const t = () => off.s.frame(reading(off.beat)).transport;
  off.beat = 103;
  assert.deepEqual(playingClips(off.s.table(), t(), 103, [1]).map((c) => c.id), ['clip:A:1.0.0']);
  off.beat = 105;
  assert.equal(sequencePlace(t(), 105).position, 1, 'A again, not B');
  assert.equal(off.top(), 'A');
  assert.deepEqual(playingClips(off.s.table(), t(), 105, [1]).map((c) => c.id), ['clip:A:1.1.0'], 'a fresh lap');
  // Next skips at once, to B's start, and B then repeats in its turn.
  off.s.next();
  assert.equal(off.at(105.5), 4);
  assert.equal(off.top(), 'B');
  assert.equal(off.at(109.25), 7.75);
  assert.equal(off.at(109.5), 4, 'B repeats');
  assert.equal(off.top(), 'B');
  // Next from the last row comes round to the first; prev goes back.
  off.s.next();
  off.at(110);
  assert.equal(off.top(), 'C');
  off.s.next();
  assert.equal(off.at(110.5), 0);
  assert.equal(off.top(), 'A');
  off.s.prev();
  off.at(111);
  assert.equal(off.top(), 'C');

  // Shuffle: another row each time, never the one playing; all the others in time.
  let beat = 112;
  const seen = new Set();
  for (let i = 0; i < 24; i++) {
    const before = off.top();
    off.s.shuffle();
    off.at(beat += 0.5);
    assert.notEqual(off.top(), before, `shuffle ${i} picked the row playing`);
    seen.add(off.top());
  }
  assert.deepEqual([...seen].sort(), ['A', 'B', 'C']);
  // One row: nothing else to pick, so nothing moves.
  const one = rig();
  one.s.load(sequence({ mode: 'playlist', lanes: [lane('rows')], clips: [clip('A', 'rows', 0, 4)] }));
  one.s.play();
  one.at(100);
  one.s.shuffle();
  assert.equal(one.at(101), 1, 'still where it was, no seek');
});

test('playlist shuffle mode: each row\'s end goes to another row, seeded', () => {
  const runs = [1, 2].map(() => {
    const r = rig({ seed: [9, 9, 9, 9] });
    r.s.load(sequence({ ...ROWS, options: { shuffle: true } }));
    r.s.play();
    r.at(100);
    const order = [r.top()];
    for (let b = 100.5; b < 140; b += 0.5) {
      r.at(b);
      if (r.top() !== order.at(-1)) order.push(r.top());
    }
    return order;
  });
  assert.deepEqual(runs[0], runs[1], 'the same seed, the same order');
  assert.ok(runs[0].length >= 9);
  for (let i = 1; i < runs[0].length; i++) assert.notEqual(runs[0][i], runs[0][i - 1]);
});

// ── The loop region ─────────────────────────────────────────────────────────

test('loop region wraps the beat', () => {
  const r = rig();
  // Two levels in turn, so each one fired is a write (an unchanged level is not written again).
  const cmds = [
    { id: 'start', atBeat: 4, type: 'brightness', value: 10 },
    { id: 'mid', atBeat: 6, type: 'brightness', value: 20 },
    // On the loop's end, which looping never reaches: a palette, so no other command of the frame hides it.
    { id: 'end', atBeat: 8, type: 'palette', value: 'redCyan' },
  ];
  r.s.load(sequence({ clips: [clip('A', 'a', 0, 4), clip('B', 'a', 4, 4, { effect: PROBE })], loop: { on: true, startBeat: 4, endBeat: 8 }, commands: cmds }));
  r.s.play();
  assert.equal(r.at(100), 0);
  assert.equal(r.at(104.5), 4.5);
  assert.equal(r.at(106.5), 6.5);
  assert.equal(r.at(108), 4, 'the end is never reached');
  assert.equal(r.at(110.5), 6.5);
  assert.equal(r.at(111.5), 7.5);
  assert.equal(r.at(112), 4);
  assert.equal(r.s.status().beat, 4);
  assert.deepEqual(r.s.status().loop, { on: true, startBeat: 4, endBeat: 8 });
  assert.deepEqual(r.applied.map((p) => p.masterDimmer), [10, 20, 10, 20, 10], 'its start each time round');
  assert.ok(r.applied.every((p) => p.paletteOverride === undefined), 'its end never');
  // Each time round is a traversal of its own: B's laps are fresh activations.
  const t = r.s.frame(reading(112.5)).transport;
  assert.deepEqual(playingClips(r.s.table(), t, 112.5, [1]).map((c) => c.id), ['clip:B:1.2.0']);
  // Switched off, it plays on to its end, the bar line after the last clip: from 4.5 to 8, where it is over.
  r.s.setLoop({ on: false, startBeat: 4, endBeat: 8 });
  assert.equal(r.at(113), 5, 'from the position it had');
  assert.equal(r.at(116), null);
  assert.deepEqual(r.applied.at(-1), { masterDimmer: 20 }, 'its end plays now');
  assert.equal(r.s.status().ended, true);
  // A region set on the ended sequence: the next play, from the top, loops it.
  r.s.setLoop({ on: true, startBeat: 0, endBeat: 2 });
  r.s.play();
  assert.equal(r.at(117), 0);
  assert.equal(r.at(120.5), 1.5);
  assert.equal(r.s.current().loop.endBeat, 2, 'the loaded sequence keeps the region');
});

// ── Palettes ────────────────────────────────────────────────────────────────

test('initialPalette sets the override on play; randomPaletteOnLoop changes it at each wrap', () => {
  const r = rig();
  r.s.load(sequence({
    clips: [clip('A', 'a', 0, 2)], loop: { on: true, startBeat: 0, endBeat: 2 },
    options: { initialPalette: 'greenPink', randomPaletteOnLoop: true },
    bpm: 128, musicMode: 'reactive',
  }));
  r.s.play();
  // A real start: the palette, the tempo and the music mode go on at once.
  assert.deepEqual(r.applied, [{ paletteOverride: PALETTE_HEX.greenPink, paletteOverrideId: 'greenPink' }, { bpm: 128 }]);
  assert.deepEqual(r.modes, ['reactive']);
  r.at(100);
  r.at(101.5);
  assert.equal(r.applied.length, 2, 'nothing more inside the first time round');
  // Every wrap: another built-in palette, never the one on.
  const palettes = ['greenPink'];
  for (let k = 1; k <= 12; k++) {
    r.at(100 + 2 * k + 0.25);
    const last = r.applied.at(-1).paletteOverride;
    const id = Object.keys(PALETTE_HEX).find((p) => PALETTE_HEX[p] === last || JSON.stringify(PALETTE_HEX[p]) === JSON.stringify(last));
    assert.ok(id, `wrap ${k} put on a built-in palette`);
    assert.equal(r.applied.length, 2 + k, `one palette for wrap ${k}`);
    assert.notEqual(id, palettes.at(-1), `wrap ${k} picked the palette that was on`);
    palettes.push(id);
  }
  assert.ok(new Set(palettes).size > 4);
  // Whichever built-in palette starts it, the first wrap picks another.
  for (const first of Object.keys(PALETTE_HEX)) {
    const one = rig();
    one.s.load(sequence({ clips: [clip('A', 'a', 0, 2)], loop: { on: true, startBeat: 0, endBeat: 2 }, options: { initialPalette: first, randomPaletteOnLoop: true } }));
    one.s.play();
    one.at(0);
    one.at(2.5);
    assert.equal(one.applied.length, 2, first);
    assert.notDeepEqual(one.applied[1].paletteOverride, PALETTE_HEX[first], `after ${first}`);
  }
  // Many more wraps, one a frame: never the palette that was on.
  let beat = 100 + 24 + 0.25;
  for (let k = 0; k < 300; k++) {
    const before = JSON.stringify(r.applied.at(-1).paletteOverride);
    r.at(beat += 2);
    assert.notEqual(JSON.stringify(r.applied.at(-1).paletteOverride), before, `wrap ${k}`);
  }
  // Three wraps inside one frame: three palettes picked, the last one put on.
  const count = r.applied.length;
  r.at(beat += 6);
  assert.equal(r.applied.length, count + 1);
  // A hand put another palette on since: the next wrap picks neither that one, whichever seed.
  const idOf = (hex) => Object.keys(PALETTE_HEX).find((p) => JSON.stringify(PALETTE_HEX[p].map((c) => c.toUpperCase())) === JSON.stringify(hex.map((c) => c.toUpperCase())));
  for (let seed = 1; seed <= 60; seed++) {
    const h = rig({ seed: [seed, 2, 3, 4] });
    h.s.load(sequence({ clips: [clip('A', 'a', 0, 2)], loop: { on: true, startBeat: 0, endBeat: 2 }, options: { initialPalette: 'greenPink', randomPaletteOnLoop: true } }));
    h.s.play();
    h.at(0);
    h.live.paletteOverride = PALETTE_HEX.redCyan.map((c) => c.toLowerCase());
    h.live.paletteOverrideId = null;
    h.at(2.5);
    assert.equal(h.applied.length, 2, `seed ${seed}`);
    assert.notEqual(idOf(h.applied[1].paletteOverride), 'redCyan', `seed ${seed}: the one on`);
    // Cleared by hand: any built-in palette may go on.
    h.live.paletteOverride = null;
    h.live.paletteOverrideId = null;
    h.at(4.5);
    assert.equal(h.applied.length, 3, `seed ${seed}: a palette each wrap`);
  }
  // Play again, pause and resume: no real start, so nothing goes on again.
  const before = r.applied.length;
  r.s.play();
  r.s.pause();
  r.at(beat += 0.25);
  r.s.play();
  r.at(beat + 0.25);
  assert.equal(r.applied.length, before);
  assert.deepEqual(r.modes, ['reactive']);
});

test('random loop palettes exclude the named random override', () => {
  for (let seed = 1; seed <= 60; seed++) {
    const r = rig({ seed: [seed, 2, 3, 4] });
    r.live.paletteOverride = ['#2A0088', '#EF6900'];
    r.live.paletteOverrideId = 'randomRandom';
    r.s.load(sequence({ clips: [clip('A', 'a', 0, 2)], loop: { on: true, startBeat: 0, endBeat: 2 }, options: { randomPaletteOnLoop: true } }));
    r.s.play();
    r.at(0);
    r.at(2.5);
    assert.notEqual(r.live.paletteOverrideId, 'randomRandom');
  }
});

const PALETTE_COMMAND = { id: 'pal', atBeat: 2, type: 'palette', value: 'redCyan' };
const paletteState = (r) => [r.live.paletteOverride, r.live.paletteOverrideId];
function paletteRun({ options = {}, before = [null, null], commands = [PALETTE_COMMAND] } = {}) {
  const r = rig();
  [r.live.paletteOverride, r.live.paletteOverrideId] = before;
  r.s.load(sequence({ clips: [clip('A', 'a', 0, 8)], commands, options }));
  r.s.play();
  r.at(100);
  r.at(102.25);
  return r;
}

for (const blackout of [false, true]) {
  test(`stop restores the previous palette with blackout=${blackout}`, () => {
    const r = paletteRun();
    r.s.stop({ blackout });
    assert.deepEqual(paletteState(r), [null, null]);
    r.at(102.5);
    assert.deepEqual(paletteState(r), [null, null]);
    r.at(103);
    assert.equal(r.applied.filter((p) => p.paletteOverride !== undefined).length, 2);
  });
}

test('palette restoration supports current-state providers without ids', () => {
  const r = paletteRun();
  const current = r.s._current;
  r.s._current = () => ({ ...current(), paletteOverrideId: undefined });
  r.s.stop();
  assert.deepEqual(paletteState(r), [null, null]);
});

test('unload restores the palette beneath initial and command palettes', () => {
  const before = [['#123456'], 'mine'];
  const r = paletteRun({ options: { initialPalette: 'greenPink' }, before });
  r.s.unload();
  assert.deepEqual(paletteState(r), before);
});

test('loading another sequence restores the prior palette', () => {
  const before = [['#123456'], 'mine'];
  const r = paletteRun({ before });
  r.s.load(sequence({ id: 'set-2', clips: [clip('B', 'a', 0, 8)] }));
  assert.deepEqual(paletteState(r), before);
});

test('a replay restores its prior palette on the next stop', () => {
  const before = [['#123456'], 'mine'];
  const r = paletteRun({ before });
  r.s.stop();
  r.at(103);
  r.s.play();
  r.at(104);
  r.at(106.25);
  r.s.stop();
  r.at(107);
  assert.deepEqual(paletteState(r), before);
});

test('stop and replay between frames retain the new initial palette', () => {
  const r = paletteRun({ options: { initialPalette: 'greenPink' } });
  r.s.stop();
  r.s.play();
  r.at(103);
  assert.deepEqual(paletteState(r), [PALETTE_HEX.greenPink, 'greenPink']);
  r.s.stop();
  assert.deepEqual(paletteState(r), [null, null]);
});

test('pause preserves the sequence palette', () => {
  const r = paletteRun();
  r.s.pause();
  r.at(103);
  assert.deepEqual(paletteState(r), [PALETTE_HEX.redCyan, 'redCyan']);
});

for (const hand of [['#ABCDEF'], null]) {
  test(`stop preserves a manually ${hand ? 'changed' : 'cleared'} palette`, () => {
    const r = paletteRun({ before: [['#123456'], 'mine'] });
    r.live.paletteOverride = hand;
    r.live.paletteOverrideId = null;
    r.s.handEdit({ paletteOverride: true });
    r.s.stop();
    r.at(103);
    r.s.unload();
    assert.deepEqual(paletteState(r), [hand, null]);
  });
}

test('reselecting the same palette transfers ownership to the operator', () => {
  const r = paletteRun();
  r.s.handEdit({ paletteOverride: true });
  r.s.stop();
  r.at(103);
  assert.deepEqual(paletteState(r), [PALETTE_HEX.redCyan, 'redCyan']);
});

test('a palette command due on the stop frame never changes the override', () => {
  const r = rig();
  r.s.load(sequence({ clips: [clip('A', 'a', 0, 8)], commands: [PALETTE_COMMAND] }));
  r.s.play();
  r.at(100);
  r.s.stop();
  r.at(102.25);
  assert.equal(r.live.paletteOverride, null);
  assert.ok(r.applied.every((p) => p.paletteOverride === undefined));
});

test('a sequence without palette commands leaves the override untouched', () => {
  const before = [['#123456'], 'mine'];
  const r = paletteRun({ before, commands: [] });
  r.s.stop();
  r.at(103);
  r.s.unload();
  assert.deepEqual(paletteState(r), before);
  assert.ok(r.applied.every((p) => p.paletteOverride === undefined));
});

// ── Command rows ────────────────────────────────────────────────────────────

test('commands fire once when the beat passes them: palette override set, tempo applied, brightness applied, goto jumps', () => {
  const r = rig();
  r.s.load(sequence({
    clips: [clip('A', 'a', 0, 16)],
    commands: [
      { id: 'zero', atBeat: 0, type: 'brightness', value: 200 },
      { id: 'pal', atBeat: 2, type: 'palette', value: 'redCyan' },
      { id: 'tempo', atBeat: 3, type: 'tempo', value: 128 },
      { id: 'bright', atBeat: 3, type: 'brightness', value: 40 },
      { id: 'jump', atBeat: 6, type: 'goto', value: 1 },
    ],
  }));
  r.s.play();
  r.at(100);
  assert.deepEqual(r.applied, [{ masterDimmer: 200 }], 'a command on the start beat, once');
  r.at(100.5);
  r.at(101.9);
  assert.equal(r.applied.length, 1);
  r.at(102.25);
  assert.deepEqual(r.applied.at(-1), { paletteOverride: PALETTE_HEX.redCyan, paletteOverrideId: 'redCyan' });
  r.at(102.5);
  assert.equal(r.applied.length, 2, 'passed once, fired once');
  // Two on one beat, crossed in one frame: in their order, applied together.
  r.at(103.5);
  assert.deepEqual(r.applied.at(-1), { bpm: 128, masterDimmer: 40 });
  assert.equal(r.applied.length, 3);
  // The goto at 6 jumps to 1: the quarter beat past it carries on from there.
  assert.equal(r.at(106.25), 1.25);
  const gen = r.s.frame(reading(106.25)).transport.generation;
  // The way back over 2 is a new pass: the palette goes on again. The tempo
  // and the master at 3 fire too, but are already what they set: no write.
  r.at(107.5);
  assert.deepEqual(r.applied.slice(3), [{ paletteOverride: PALETTE_HEX.redCyan, paletteOverrideId: 'redCyan' }]);
  r.at(108.5);
  assert.equal(r.applied.length, 4);
  assert.equal(r.s.frame(reading(108.5)).transport.generation, gen);

  // A seek lands on its beat: what lies before it is not played.
  const seek = rig();
  seek.s.load(sequence({ clips: [clip('A', 'a', 0, 16)], commands: [{ id: 'b', atBeat: 2, type: 'brightness', value: 9 }, { id: 'c', atBeat: 5, type: 'brightness', value: 50 }] }));
  seek.s.play();
  seek.at(100);
  seek.s.seek(5);
  assert.equal(seek.at(100.5), 5);
  assert.deepEqual(seek.applied, [{ masterDimmer: 50 }], 'its own beat\'s command only');

  // Crossed in one long frame, several fire once each in order; the last value is what goes on.
  const long = rig();
  long.s.load(sequence({ clips: [clip('A', 'a', 0, 16)], commands: [1, 2, 3].map((b) => ({ id: `b${b}`, atBeat: b, type: 'brightness', value: b * 10 })) }));
  long.s.play();
  long.at(100);
  long.at(104);
  assert.deepEqual(long.applied, [{ masterDimmer: 30 }]);
  assert.equal(long.s.status().error, null);
});

test('a goto that comes straight back to itself stops the sequence with an error, not a hang', () => {
  const r = rig();
  r.s.load(sequence({
    clips: [clip('A', 'a', 0, 8)],
    commands: [{ id: 'there', atBeat: 4, type: 'goto', value: 2 }, { id: 'back', atBeat: 2, type: 'goto', value: 4 }],
  }));
  r.s.play();
  r.at(100);
  r.at(103);
  r.at(104.5);
  const st = r.s.status();
  assert.equal(st.playing, false);
  assert.equal(st.stopped, 'hold');
  assert.equal(st.error.code, 'goto-cycle');
  assert.match(st.error.message, /there|back/);
});

test('the transport tells when it starts or stops moving: playing or paused it moves, stopped, unloaded, replaced or stopped by itself it stands', () => {
  const told = [];
  const r = rig({
    onRun: () => {
      const st = r.s.status();
      assert.equal(r.s.runs(), st.playing || st.paused, 'what it tells is what its status says');
      told.push(r.s.runs());
    },
  });
  r.s.load(sequence({ clips: [clip('A', 'a', 0, 8)] }));
  assert.equal(r.s.runs(), false, 'loaded is not moving');
  r.s.play();
  assert.deepEqual(told, [true], 'play moves it at once, before the next frame');
  r.at(100);
  r.s.pause();
  assert.equal(r.s.runs(), true, 'paused, its clips play their laps on');
  r.at(101);
  r.s.play();
  r.at(102);
  assert.deepEqual(told, [true], 'pause and resume: still moving, nothing to tell');
  r.s.stop();
  assert.deepEqual(told, [true, false]);
  r.at(103);
  r.s.stop({ blackout: true });
  r.at(104);
  assert.deepEqual(told, [true, false], 'stopped over black: still standing');
  // Another sequence loaded stops the one playing; an edit of it does not.
  r.s.play();
  r.s.load(sequence({ name: 'Edited', clips: [clip('A', 'a', 0, 8)] }));
  assert.equal(r.s.runs(), true);
  r.s.load(sequence({ id: 'set-2', clips: [clip('A', 'a', 0, 8)] }));
  assert.deepEqual(told, [true, false, true, false]);
  r.s.play();
  r.s.unload();
  assert.deepEqual(told, [true, false, true, false, true, false]);
  // Stopped by its own goto cycle, within a frame.
  r.s.load(sequence({
    clips: [clip('A', 'a', 0, 8)],
    commands: [{ id: 'there', atBeat: 4, type: 'goto', value: 2 }, { id: 'back', atBeat: 2, type: 'goto', value: 4 }],
  }));
  r.s.play();
  r.at(200);
  r.at(204.5);
  assert.equal(r.s.status().error.code, 'goto-cycle');
  assert.deepEqual(told, [true, false, true, false, true, false, true, false]);
});

// ── The traversal budget ────────────────────────────────────────────────────

test('a frame does at most 4096 commands, wraps and row advances; the 4097th stops the sequence where it was, and play carries on from there', () => {
  assert.equal(MAX_FRAME_OPERATIONS, 4096);
  const commands = (n) => Array.from({ length: n }, (_, i) => ({ id: `c${i}`, atBeat: 1, type: 'brightness', value: i % 200 }));
  // Exactly 4096 on one beat: all of them, the last value on.
  const fits = rig();
  fits.s.load(sequence({ clips: [clip('A', 'a', 0, 8)], commands: commands(4096) }));
  fits.s.play();
  fits.at(100);
  fits.at(101.5);
  assert.equal(fits.s.status().error, null);
  assert.deepEqual(fits.applied, [{ masterDimmer: 95 }]);
  // 4097: the first 4096 go on, and the sequence stops on that beat with the last still to do.
  const over = rig();
  over.s.load(sequence({ clips: [clip('A', 'a', 0, 8)], commands: commands(4097) }));
  over.s.play();
  over.at(100);
  over.at(101.5);
  const st = over.s.status();
  assert.equal(st.error.code, 'traversal-limit');
  assert.equal(st.stopped, 'hold');
  assert.equal(st.beat, 1);
  assert.deepEqual(over.applied, [{ masterDimmer: 95 }]);
  // Nothing drains on its own while stopped.
  over.at(102);
  over.at(110);
  assert.equal(over.applied.length, 1);
  // Play: on from the command still to do, never one already done.
  over.s.play();
  over.at(111);
  assert.deepEqual(over.applied, [{ masterDimmer: 95 }, { masterDimmer: 96 }]);
  assert.equal(over.s.status().error, null);
  assert.equal(over.at(111.5), 1.5, 'and from that beat');

  // Stopped by hand after the error, play is a real start from the top.
  const reset = rig();
  reset.s.load(sequence({ clips: [clip('A', 'a', 0, 8)], commands: commands(4097), options: { initialPalette: 'redCyan' } }));
  reset.s.play();
  reset.at(100);
  reset.at(101.5);
  assert.equal(reset.s.status().error.code, 'traversal-limit');
  reset.s.stop();
  reset.s.play();
  assert.equal(reset.at(102), 0);
  assert.equal(reset.s.status().error, null);
  assert.equal(reset.applied.filter((p) => p.paletteOverride).length, 2, 'its first palette again');

  // An empty loop too tiny for a frame: each time round counts.
  const tiny = rig();
  tiny.s.load(sequence({ clips: [clip('A', 'a', 0, 8)], loop: { on: true, startBeat: 1, endBeat: 1 + 1e-6 } }));
  tiny.s.play();
  tiny.at(100);
  tiny.at(101.02);
  assert.equal(tiny.s.status().error.code, 'traversal-limit');
  // A seek after the error replaces where it stopped: play starts from there.
  tiny.s.seek(4);
  tiny.s.play();
  assert.equal(tiny.at(103), 4);
  assert.equal(tiny.s.status().error, null);
});

// ── Automation ──────────────────────────────────────────────────────────────

test('automation sine over 8 beats between min and max; tempo automation counts seconds', () => {
  const a = (mode, extra = {}) => ({ mode, period: 8, min: 0, max: 100, growing: true, ...extra });
  // Light DJ's timer shapes, from the current value 25, rising.
  const triangle = [0, 4, 8, 12].map((e) => automationValue(a('triangle'), 25, e));
  assert.deepEqual(triangle.map((v) => Math.round(v * 1e9) / 1e9), [25, 75, 75, 25]);
  const sine = [0, 2, 4, 6, 8].map((e) => automationValue(a('sine'), 25, e));
  [25, 93.30127018922194, 75, 6.698729810778069, 25].forEach((v, i) => close(sine[i], v));
  const saw = [0, 4, 8].map((e) => automationValue(a('sawtooth'), 25, e));
  [25, 75, 25].forEach((v, i) => close(saw[i], v));
  // Falling: the triangle goes down first, the saw down and round.
  close(automationValue(a('triangle', { growing: false }), 25, 2), 0);
  close(automationValue(a('triangle', { growing: false }), 25, 4), 25);
  close(automationValue(a('sawtooth', { growing: false }), 25, 2), 0, 1e-9);
  close(automationValue(a('sawtooth', { growing: false }), 25, 3), 87.5);
  close(automationValue(a('sine', { growing: false }), 25, 4), 75);
  // Target: from the value there to the target over one period, then held.
  const target = { mode: 'target', period: 4, min: 0, max: 255, growing: true, target: 85 };
  assert.deepEqual([0, 2, 4, 9].map((e) => automationValue(target, 25, e)), [25, 55, 85, 85]);
  // A value outside the range starts from its edge; equal bounds hold one finite value.
  close(automationValue(a('triangle'), 300, 0), 100);
  assert.equal(automationValue(a('sine', { min: 40, max: 40 }), 25, 3), 40);
  assert.equal(automationValue(a('none'), 25, 3), null);

  // On the master, in beats: the sine from where the master was.
  const r = rig({ master: 25 });
  r.s.load(sequence({ clips: [clip('A', 'a', 0, 64)], automation: { brightness: a('sine'), tempo: null } }));
  r.s.play();
  r.at(100);
  assert.deepEqual(r.applied, [], 'the value it starts from is not written again');
  const masters = [102, 104, 106, 108].map((b) => { r.at(b); return r.live.master; });
  assert.deepEqual(masters, [93, 75, 7, 25]);
  // A clock that steps back a hair and on again is not counted twice.
  r.at(107.8);
  r.at(108);
  assert.equal(r.live.master, 25);
  // A tempo change does not move its phase: the beats it has counted are kept.
  r.at(110, { bpm: 90 });
  assert.equal(r.live.master, 93);

  // The tempo, in seconds whatever the beats do: a triangle from 120 between 100 and 140.
  const t = rig({ bpm: 120 });
  t.s.load(sequence({ clips: [clip('A', 'a', 0, 64)], automation: { tempo: { mode: 'triangle', period: 8, min: 100, max: 140, growing: true }, brightness: null } }));
  t.s.play();
  t.at(100);
  t.live.ms = 4000;
  t.at(100.5);
  assert.equal(t.live.bpm, 140, 'four seconds in, however few beats');
  t.live.ms = 8000;
  t.at(130);
  assert.equal(t.live.bpm, 120);
  // Paused, it carries on; stopped, it ends.
  t.s.pause();
  t.live.ms = 10000;
  t.at(131);
  assert.equal(t.live.bpm, 110);
  t.s.stop();
  t.live.ms = 12000;
  t.at(132);
  assert.equal(t.live.bpm, 110);
});

test('touching the master cancels the brightness automation', () => {
  const r = rig({ master: 25, bpm: 120 });
  r.s.load(sequence({
    clips: [clip('A', 'a', 0, 64)],
    automation: {
      brightness: { mode: 'triangle', period: 8, min: 0, max: 100, growing: true },
      tempo: { mode: 'sawtooth', period: 10, min: 100, max: 140, growing: true },
    },
  }));
  r.s.play();
  r.at(100);
  r.at(104);
  assert.equal(r.live.master, 75);
  // Its own samples never cancel it.
  r.at(106);
  assert.equal(r.live.master, 100);
  r.at(108);
  assert.equal(r.live.master, 75);
  r.at(110);
  assert.equal(r.live.master, 50);
  // A hand on the master: the brightness automation ends, the tempo's goes on.
  r.live.master = 200;
  r.s.handEdit({ masterDimmer: true });
  r.live.ms = 2500;
  r.at(112);
  assert.equal(r.live.master, 200);
  assert.equal(r.live.bpm, 130, 'the tempo still moves: a quarter of its saw on from 120');
  r.at(116);
  assert.equal(r.live.master, 200);
  // A hand on the tempo ends the tempo's.
  r.s.handEdit({ bpm: true });
  r.live.bpm = 123;
  r.live.ms = 7000;
  r.at(118);
  assert.equal(r.live.bpm, 123);
  // An automation the edit of a playing sequence adds starts from the value on
  // the rig; edited again it starts afresh; edited to none it ends where it is.
  const e = rig({ master: 25 });
  const edit = (brightness) => e.s.load(sequence({ clips: [clip('A', 'a', 0, 64)], automation: { brightness, tempo: null } }));
  edit(null);
  e.s.play();
  e.at(100);
  e.at(101);
  assert.equal(e.live.master, 25);
  edit({ mode: 'triangle', period: 8, min: 0, max: 100, growing: true });
  e.at(102);
  e.at(106);
  assert.equal(e.live.master, 75, 'four beats of a triangle from 25');
  edit({ mode: 'triangle', period: 8, min: 0, max: 100, growing: false });
  e.at(107);
  e.at(109);
  assert.equal(e.live.master, 50, 'afresh from 75, falling');
  edit({ mode: 'none', period: 8, min: 0, max: 100, growing: true });
  e.at(113);
  assert.equal(e.live.master, 50, 'ended where it was');
  // A command for the master replaces its automation as well.
  const c = rig({ master: 25 });
  c.s.load(sequence({
    clips: [clip('A', 'a', 0, 64)], commands: [{ id: 'm', atBeat: 3, type: 'brightness', value: 180 }],
    automation: { brightness: { mode: 'triangle', period: 8, min: 0, max: 100, growing: true }, tempo: null },
  }));
  c.s.play();
  c.at(100);
  c.at(103);
  assert.equal(c.live.master, 180);
  c.at(105);
  assert.equal(c.live.master, 180);
});

// ── Pause and stop on the rig ───────────────────────────────────────────────

const fixture = (id, address) => ({
  id, address, universe: 0, profileId: BUILTIN_PROFILE_ID, maxBrightness: 255, override: null,
  position: null, group: null, geometry: null, hue: false,
});
const PARS = [fixture(10, 1), fixture(11, 13), fixture(12, 25)];
const LOOK = { pattern: 'solid', colorA: 0, colorB: 5, colorC: 0, colorD: 5, beatDivision: 1 };

function stage() {
  const store = universes.createUniverseStore(universes.allocateShared());
  const renderer = createRenderer({ profileOf: getProfile, profilesRevision, now: 0 });
  const read = (fix) => {
    const ch = getProfile(fix).channelMap;
    const dmx = store.getBuffer(fix.universe);
    return {
      dim: dmx[fix.address - 1 + ch.dimmer], r: dmx[fix.address - 1 + ch.red], g: dmx[fix.address - 1 + ch.green], b: dmx[fix.address - 1 + ch.blue],
      strobe: dmx[fix.address - 1 + ch.strobe],
    };
  };
  let handed;
  /** One frame of a sequencer on the rig at the music's beat (120 BPM: 500 ms a beat). */
  return (s, beat, patch = {}) => {
    const frame = s.frame(reading(beat));
    if (frame.table !== handed) renderer.setSequence(frame.table);
    handed = frame.table;
    const input = {
      running: true, ...LOOK, split: null, pixelMap: 'stage', strobeSpeed: 0, strobeFunction: 'standard', masterDimmer: 255,
      masterBlackout: false, energy: null, showDynamics: null, patternAnchor: null, fade: null, syncTest: null, universes: [0],
      fixtures: PARS, sequenceRevision: frame.table?.revision ?? null, sequenceTransport: frame.transport, ...patch,
    };
    renderer.frame(input, { beatPos: beat, bpm: 120, epoch: 0 }, beat * 500, store, 0);
    return Object.fromEntries(PARS.map((f) => [f.id, read(f)]));
  };
}

test('pause holds the clip looping; stop holds the last frame; stop with blackout sends black', () => {
  const show = stage();
  const r = rig();
  // A on 10 and 11 for four beats, looping every two; B after it; a command at 5.
  r.s.load(sequence({
    clips: [clip('A', 'a', 0, 4, { effect: PROBE, loopBeats: 2, targets: [10, 11] }), clip('B', 'a', 4, 4, { targets: [10, 11] })],
    commands: [{ id: 'm', atBeat: 5, type: 'brightness', value: 1 }],
  }));
  r.s.play();
  show(r.s, 100);
  show(r.s, 101);
  // Paused at beat 1.5 of A's first lap: A stays on past its end, and plays its laps on.
  r.s.pause();
  probeLog.length = 0;
  const p1 = show(r.s, 101.5);
  assert.equal(r.s.status().paused, true);
  const p2 = show(r.s, 106);
  assert.notEqual(p1[10].r, p2[10].r, 'the paused clip keeps moving');
  assert.equal(p2[10].b, 7, 'still A, not B');
  assert.equal(p2[12].r, 255, 'the look where no clip plays');
  assert.equal(r.s.status().beat, 1.5);
  assert.deepEqual(r.s.status().lanes, [{ id: 'a', clip: 'A' }]);
  assert.deepEqual([...new Set(probeLog.map((p) => p.id))], ['clip:A:1.0.0', 'clip:A:1.0.3'], 'its laps go on past its end: 1.5 + 4.5 beats is lap 3');
  assert.deepEqual(r.applied, [], 'no command fires while paused');
  // Play: on from the beat it held, A's own lap again.
  r.s.play();
  show(r.s, 107);
  assert.equal(r.s.status().beat, 1.5);
  show(r.s, 110.5);
  assert.deepEqual(r.applied, [{ masterDimmer: 1 }], 'beat 5 is reached three and a half beats later');

  // Stop: the last picture stays, whatever the clip would have done; masters and voices still act.
  const s2 = rig();
  s2.s.load(sequence({ clips: [clip('A', 'a', 0, 8, { effect: PROBE, targets: [10, 11] })] }));
  s2.s.play();
  show(s2.s, 200);
  const last = show(s2.s, 201);
  s2.s.stop();
  const held = [show(s2.s, 201.5), show(s2.s, 203), show(s2.s, 230)];
  for (const frame of held) assert.deepEqual(frame, last);
  assert.equal(s2.s.status().stopped, 'hold');
  assert.equal(s2.s.status().playing, false);
  const dimmed = show(s2.s, 231, { masterDimmer: 128 });
  assert.ok(dimmed[10].dim < last[10].dim, 'the master still dims it');
  const voice = { id: 'pad:1', spec: PAINT, targets: [10], tier: 'voice', launchSeq: 1, startedAtMs: 0, untilMs: null, anchorBeat: 0, seed: seedFrom('pad:1') };
  assert.equal(show(s2.s, 232, { voices: [voice] })[10].g, 255, 'a voice plays above it');
  // Blackout: black under every fixture, the look's too; a voice still above.
  s2.s.stop({ blackout: true });
  const black = show(s2.s, 233);
  assert.deepEqual([black[10].dim, black[11].dim, black[12].dim], [0, 0, 0]);
  assert.equal(s2.s.status().stopped, 'black');
  assert.equal(show(s2.s, 234, { voices: [voice] })[10].g, 255);
  // A new load lets go: the look again.
  s2.s.load(sequence({ id: 'set-2', clips: [] }));
  assert.equal(show(s2.s, 235)[10].r, 255);
  assert.equal(s2.s.status().stopped, null);
  // Play after a stop starts from the top.
  const s3 = rig();
  s3.s.load(sequence({ clips: [clip('A', 'a', 0, 8)] }));
  s3.s.play();
  s3.at(300);
  s3.at(305);
  s3.s.stop();
  s3.at(306);
  s3.s.play();
  assert.equal(s3.at(310), 0);
});

// ── The end ─────────────────────────────────────────────────────────────────

test('an arrangement with no loop ends at the bar line after its last clip or command: it lets go, says so, and plays from the top again', () => {
  const show = stage();
  const r = rig();
  r.s.load(sequence({
    clips: [clip('A', 'a', 0, 5.5, { targets: [10] })],
    automation: { tempo: null, brightness: { mode: 'sine', period: 8, min: 0, max: 255, growing: true } },
  }));
  r.s.play();
  assert.equal(r.at(100), 0);
  assert.equal(r.at(107.5), 7.5, 'the bar of 4/4 its clip ends in plays out');
  assert.equal(r.s.status().playing, true);
  const patches = r.applied.length;
  assert.equal(r.at(108), null, 'at its end: no transport, nothing held');
  const { playing, paused, stopped, ended, beat, bar, lanes } = r.s.status();
  assert.deepEqual({ playing, paused, stopped, ended, beat, bar, lanes }, { playing: false, paused: false, stopped: null, ended: true, beat: 0, bar: 1, lanes: [{ id: 'a', clip: null }] });
  assert.equal(show(r.s, 109)[10].r, 255, 'the look plays');
  r.at(114);
  assert.equal(r.applied.length, patches, 'its automation ended with it');
  // Stop has nothing to hold; play starts from the top.
  r.s.stop();
  assert.equal(r.s.status().stopped, null);
  r.s.play();
  assert.equal(r.at(200), 0);
  assert.equal(r.top(), 'A');
  assert.equal(r.s.status().ended, false);

  // A command past the last clip runs first, and the bar line after it is the end.
  const long = rig();
  long.s.load(sequence({ clips: [clip('A', 'a', 0, 66.5)], commands: [{ id: 'dim', atBeat: 70, type: 'brightness', value: 9 }] }));
  long.s.play();
  long.at(0);
  assert.equal(long.at(71.5), 71.5);
  assert.deepEqual(long.applied.at(-1), { masterDimmer: 9 }, 'the command past the clips runs');
  assert.equal(long.at(72), null);
  // The bar is the sequence's own: in 3/4 a clip to beat 4 ends the sequence at 6.
  const waltz = rig();
  waltz.s.load(sequence({ timeSignature: { beats: 3, unit: 4 }, clips: [clip('A', 'a', 0, 4)] }));
  waltz.s.play();
  waltz.at(0);
  assert.equal(waltz.at(5.5), 5.5);
  assert.equal(waltz.at(6), null);
  // Nothing in it, nothing to play: it ends as it starts.
  const empty = rig();
  empty.s.load(sequence());
  empty.s.play();
  assert.equal(empty.at(0), null);
  assert.equal(empty.s.status().ended, true);

  // While a take runs it plays on past its end, for the take to land in; the take dropped, it ends where it is.
  const take = rig();
  take.s.load(sequence({ clips: [clip('A', 'a', 0, 4)] }));
  take.s.startRecording({ mode: 'overdub', countInBeats: 0, quantise: 1 });
  take.s.play();
  take.at(0);
  assert.equal(take.at(20), 20);
  assert.equal(take.s.status().playing, true);
  take.s.stopRecording(false);
  assert.equal(take.at(21), null);
  assert.equal(take.s.status().ended, true);

  // A goto on its end, or a loop, takes it round; a loop behind the position does not.
  const round = rig();
  round.s.load(sequence({ clips: [clip('A', 'a', 0, 4)], commands: [{ id: 'back', atBeat: 64, type: 'goto', value: 0 }] }));
  round.s.play();
  round.at(0);
  assert.equal(round.at(64.5), 0.5);
  const looped = rig();
  looped.s.load(sequence({ clips: [clip('A', 'a', 0, 4), clip('B', 'a', 8, 4)], loop: { on: true, startBeat: 0, endBeat: 4 } }));
  looped.s.play();
  looped.at(0);
  assert.equal(looped.at(301), 1);
  looped.s.seek(5);
  assert.equal(looped.at(302), 5, 'behind the loop now');
  assert.equal(looped.at(308), 11);
  assert.equal(looped.at(309), null, 'and on to the end');

  // A seek past the end ends it at once.
  const seek = rig();
  seek.s.load(sequence({ clips: [clip('A', 'a', 0, 4)] }));
  seek.s.play();
  seek.at(0);
  seek.s.seek(80);
  assert.equal(seek.at(1), null);
  assert.equal(seek.s.status().ended, true);
  // A seek forgets that it ended.
  seek.s.seek(2);
  assert.deepEqual([seek.s.status().ended, seek.s.status().beat], [false, 2]);
});

test('a playlist ends after its last row; autoplay off or shuffle keep it going', () => {
  const r = rig();
  r.s.load(sequence(ROWS));
  r.s.play();
  r.at(100);
  assert.equal(r.at(111.5), 11.5);
  assert.equal(r.top(), 'C');
  assert.equal(r.at(112), null);
  assert.equal(r.s.status().ended, true);
  for (const options of [{ autoplay: false }, { shuffle: true }]) {
    const on = rig();
    on.s.load(sequence({ ...ROWS, options }));
    on.s.play();
    on.at(100);
    assert.notEqual(on.at(140), null, JSON.stringify(options));
    assert.equal(on.s.status().playing, true);
  }
});

test('play after a pause re-bases the transport and starts nothing again: the lap playing plays on', () => {
  const show = stage();
  const r = rig();
  r.s.load(sequence({ clips: [clip('A', 'a', 0, 8, { effect: PROBE, targets: [10] })] }));
  r.s.play();
  probeLog.length = 0;
  show(r.s, 600);
  show(r.s, 601);
  r.s.pause();
  show(r.s, 601.5);
  show(r.s, 603);
  r.s.play();
  show(r.s, 604);
  show(r.s, 605);
  assert.deepEqual([...new Set(probeLog.map((p) => p.id))], ['clip:A:1.0.0'], 'one activation throughout');
  assert.deepEqual(probeLog.map((p) => p.renders), [1, 2, 3, 4, 5, 6], 'its state kept, never started again');
  // On from the held beat: the sequence is at 1.5 + 1 at the music's 605.
  assert.equal(r.s.status().beat, 2.5);
});

test('a renderer that never saw the sequence play holds the stop\'s own moment, still', () => {
  const show = stage();
  const r = rig();
  r.s.load(sequence({ clips: [clip('A', 'a', 0, 8, { effect: PROBE, targets: [10] })] }));
  r.s.play();
  r.s.frame(reading(400));
  r.s.frame(reading(402));
  r.s.stop();
  const first = show(r.s, 403);
  assert.equal(first[10].b, 7, 'the clip at the stop\'s position');
  assert.deepEqual(show(r.s, 410), first);
});

test('a held picture is a still: a clip that drove a fixture\'s strobe channel leaves it closed once stopped', () => {
  const show = stage();
  const r = rig();
  const acknowledged = { safety: { hdFlashIntervalMs: 350, acknowledged: true } };
  r.s.load(sequence({ clips: [clip('S', 'a', 0, 8, { effect: validateSpec({ kind: 'energy.whiteStrobe' }), targets: [10] })] }));
  r.s.play();
  const playing = show(r.s, 500, acknowledged);
  assert.ok(playing[10].strobe > 0, 'the white strobe opens the channel while it plays');
  r.s.stop();
  const held = show(r.s, 501, acknowledged);
  assert.equal(held[10].strobe, 0, 'stopped, it is closed');
  assert.equal(held[10].dim, playing[10].dim, 'the colour and level held');
  assert.deepEqual([held[10].r, held[10].g, held[10].b], [255, 255, 255]);
});

// ── Resync, seek, epochs ────────────────────────────────────────────────────

test('resync to the bar re-bases the transport', () => {
  // Hue Dynamics' boundaries, in quarter-note beats.
  assert.equal(resyncPosition(13.3, { beats: 4, unit: 4 }, 'bar'), 12);
  assert.equal(resyncPosition(13.6, { beats: 4, unit: 4 }, 'beat'), 14);
  assert.equal(resyncPosition(13.5, { beats: 4, unit: 4 }, 'beat'), 14, 'a tie goes away from zero');
  assert.equal(resyncPosition(13.4, { beats: 4, unit: 4 }, 'beat'), 13);
  assert.equal(resyncPosition(7.9, { beats: 6, unit: 8 }, 'bar'), 6, 'a 6/8 bar is three beats');
  assert.equal(resyncPosition(7.3, { beats: 6, unit: 8 }, 'beat'), 7.5, 'an eighth is half a beat');
  assert.equal(resyncPosition(12, { beats: 4, unit: 4 }, 'bar'), 12);

  const r = rig();
  r.s.load(sequence({ clips: [clip('A', 'a', 0, 64)] }));
  r.s.play();
  r.at(100);
  assert.equal(r.s.status().bar, 1);
  close(r.at(113.3), 13.3);
  assert.equal(r.s.status().bar, 4);
  const before = r.s.frame(reading(113.3)).transport;
  r.s.resync('bar');
  // The bar's start now: the transport counts from here.
  assert.equal(r.at(113.4), 12);
  const after = r.s.frame(reading(113.4)).transport;
  close(sequencePlace(after, 114.4).position, 13);
  assert.equal(after.generation, before.generation + 1, 'a seek, so every clip starts again');
  r.s.resync('beat');
  close(r.at(113.6), 12);
  assert.throws(() => r.s.resync('phrase'), (err) => err.status === 400);
});

test('a jump of the music\'s clock re-bases the sequence: it carries on from where it was, replaying nothing', () => {
  const r = rig();
  r.s.load(sequence({ clips: [clip('A', 'a', 0, 64)], commands: [{ id: 'm', atBeat: 20, type: 'brightness', value: 3 }] }));
  r.s.play();
  r.at(100);
  close(r.at(105.5), 5.5);
  // A new track: the beat count jumps far ahead, in a new epoch.
  close(r.at(900, { epoch: 1 }), 5.5);
  close(r.at(901, { epoch: 1 }), 6.5);
  assert.deepEqual(r.applied, []);
  // A small step back inside one epoch moves nothing back and fires nothing twice.
  close(r.at(900.9, { epoch: 1 }), 6.4);
  close(r.at(901.2, { epoch: 1 }), 6.7);
});

// ── Admission and loading ───────────────────────────────────────────────────

test('play refuses a sequence holding a clip that needs the photosensitivity acknowledgement (409); nothing starts', () => {
  const FAST = validateSpec({ kind: 'ldj.StrobeCycle', params: { cadence: 0.25 } });
  const refused = [];
  const r = rig({ admit: (spec) => { if (spec.kind === 'ldj.StrobeCycle') { refused.push(spec); const e = new Error('photosensitivity acknowledgement required'); e.status = 409; throw e; } } });
  r.s.load(sequence({ clips: [clip('A', 'a', 0, 8), clip('fast', 'a', 8, 8, { effect: FAST })], options: { initialPalette: 'redCyan' } }));
  assert.throws(() => r.s.play(), (err) => err.status === 409);
  assert.equal(r.s.status().playing, false);
  assert.equal(r.at(100), null, 'nothing plays');
  assert.deepEqual(r.applied, [], 'and nothing a start puts on');
  // Playing, an edit that brings one in is refused, and the sequence plays on as it was.
  const ok = rig({ admit: (spec) => { if (spec.kind === 'ldj.StrobeCycle') { const e = new Error('refused'); e.status = 409; throw e; } } });
  ok.s.load(sequence({ clips: [clip('A', 'a', 0, 8)] }));
  ok.s.play();
  ok.at(100);
  const revision = ok.s.revision();
  assert.throws(() => ok.s.load(sequence({ clips: [clip('A', 'a', 0, 8), clip('fast', 'a', 8, 8, { effect: FAST })] })), (err) => err.status === 409);
  assert.equal(ok.s.revision(), revision);
  assert.equal(ok.s.status().playing, true);
});

test('a start whose settings cannot go on starts nothing, and a later play starts it whole', () => {
  let fail = true;
  const r = rig({ musicMode: () => { if (fail) throw new Error('disk full'); } });
  r.s.load(sequence({ clips: [clip('A', 'a', 0, 8)], musicMode: 'tempo' }));
  assert.throws(() => r.s.play(), /disk full/);
  assert.equal(r.s.status().playing, false);
  assert.equal(r.at(100), null, 'nothing queued to start');
  fail = false;
  r.s.play();
  assert.equal(r.at(101), 0);
});

test('an edit of the sequence playing plays on; another sequence loaded stops the one playing', () => {
  const r = rig();
  r.s.load(sequence({ clips: [clip('A', 'a', 0, 64)] }));
  r.s.play();
  r.at(100);
  r.at(103);
  const generation = r.s.frame(reading(103)).transport.generation;
  r.s.load(sequence({ clips: [clip('A', 'a', 0, 64), clip('B', 'a', 10, 4)] }));
  assert.equal(r.at(104), 4, 'on from where it was');
  assert.equal(r.s.frame(reading(104)).transport.generation, generation);
  r.s.load(sequence({ id: 'set-2', clips: [clip('A', 'a', 0, 64)] }));
  assert.equal(r.at(105), null);
  assert.equal(r.s.status().playing, false);
  assert.equal(r.s.status().loaded.id, 'set-2');
});

test('an edit while the sequence stands on a command\'s beat runs nothing of that beat again: paused on it, or stopped on it by the budget', () => {
  // Paused right on beat 4 after a seek: its two commands ran with the seek.
  const r = rig({ master: 255 });
  const at4 = [{ id: 'pal', atBeat: 4, type: 'palette', value: 'redCyan' }, { id: 'dim', atBeat: 4, type: 'brightness', value: 7 }];
  const seq = (name, extra = {}) => sequence({ name, clips: [clip('A', 'a', 0, 16)], commands: at4, ...extra });
  r.s.load(seq('one'));
  r.s.play();
  r.at(100);
  r.s.seek(4);
  r.s.pause();
  r.at(100.5);
  assert.deepEqual(r.applied, [{ paletteOverride: PALETTE_HEX.redCyan, paletteOverrideId: 'redCyan', masterDimmer: 7 }]);
  r.s.load(seq('two'));
  r.live.master = 99;
  r.s.play();
  r.at(101);
  assert.equal(r.applied.length, 1, 'resumed on beat 4: nothing of it again');
  // A command the edit adds on that beat is still due; the next time round the loop runs all three.
  r.s.load(seq('three', { commands: [...at4, { id: 'tempo', atBeat: 4, type: 'tempo', value: 128 }], loop: { on: true, startBeat: 4, endBeat: 5 } }));
  r.at(101.25);
  assert.deepEqual(r.applied.slice(1), [{ bpm: 128 }], 'the new one, not the two done');
  r.live.master = 99;
  r.live.bpm = 100;
  r.at(102.5);
  assert.deepEqual(r.applied.slice(2), [{ paletteOverride: PALETTE_HEX.redCyan, paletteOverrideId: 'redCyan', masterDimmer: 7, bpm: 128 }]);

  // Stopped by the budget on a loop's wrap, its start's three commands run this time round.
  const h = rig({ master: 255, bpm: 120 });
  const at0 = [{ id: 'pal', atBeat: 0, type: 'palette', value: 'redCyan' }, { id: 'dim', atBeat: 0, type: 'brightness', value: 7 }, { id: 'tempo', atBeat: 0, type: 'tempo', value: 128 }];
  const tiny = (name) => sequence({ name, clips: [clip('A', 'a', 0, 16)], loop: { on: true, startBeat: 0, endBeat: 1e-6 }, commands: at0 });
  h.s.load(tiny('one'));
  h.s.play();
  h.at(100);
  h.at(100.5);
  assert.equal(h.s.status().error.code, 'traversal-limit');
  assert.equal(h.s.status().beat, 0);
  h.s.load(tiny('two'));
  const n = h.applied.length;
  h.live.master = 99;
  h.live.bpm = 100;
  h.s.play();
  h.at(100.5);
  assert.deepEqual(h.applied.slice(n), [], 'on from the wrap: none of the three again');
  h.at(100.5 + 2e-6);
  assert.deepEqual(h.applied.slice(n), [{ paletteOverride: PALETTE_HEX.redCyan, paletteOverrideId: 'redCyan', masterDimmer: 7, bpm: 128 }], 'the next time round, all three');
});

test('the status: what is loaded, playing or paused, the beat and bar, the loop and the clip on each lane', () => {
  const r = rig();
  assert.deepEqual(r.s.status(), {
    loaded: null, revision: 0, mode: null, playing: false, paused: false, stopped: null, ended: false, beat: 0, bar: 1, beatsPerBar: 4, loop: null, lanes: [], activeClips: [], error: null,
  });
  r.s.load(sequence({
    lanes: [lane('a'), lane('b', { mute: true }), { id: 't', kind: 'track', fixtureId: 3, name: 't', mute: false, solo: false }],
    clips: [clip('A', 'a', 0, 8), clip('A2', 'a', 2, 2), clip('B', 'b', 0, 8), clip('T', 't', 4, 4)],
    timeSignature: { beats: 3, unit: 4 },
  }));
  r.s.play();
  r.at(100);
  r.at(102.5);
  assert.deepEqual(r.s.status(), {
    loaded: { id: 'set-1', name: 'Set one' }, revision: 1, mode: 'arrangement', playing: true, paused: false, stopped: null, ended: false,
    beat: 2.5, bar: 1, beatsPerBar: 3, loop: null, lanes: [{ id: 'a', clip: 'A2' }, { id: 'b', clip: null }, { id: 't', clip: null }], activeClips: [], error: null,
  });
  r.at(104.5);
  assert.deepEqual(r.s.status().lanes, [{ id: 'a', clip: 'A' }, { id: 'b', clip: null }, { id: 't', clip: 'T' }]);
  assert.equal(r.s.status().bar, 2);
  r.s.unload();
  assert.equal(r.at(105), null);
  assert.equal(r.s.status().loaded, null);
});

test('stop at the sequence end leaves the transport idle', () => {
  const r = rig();
  r.s.load(sequence({ clips: [clip('A', 'a', 0, 4)] }));
  r.s.play();
  r.at(100);
  r.s.stop();
  r.at(104);
  assert.equal(r.s.status().ended, true);
  assert.equal(r.s.status().stopped, null);
  assert.equal(r.s.status().playing, false);
});

test('blackout stop at the sequence end holds black', () => {
  const r = rig();
  r.s.load(sequence({ clips: [clip('A', 'a', 0, 4)] }));
  r.s.play();
  r.at(100);
  r.s.stop({ blackout: true });
  r.at(104);
  assert.equal(r.s.status().ended, false);
  assert.equal(r.s.status().stopped, 'black');
});

// ── The worker ──────────────────────────────────────────────────────────────

const WORKER = path.join(import.meta.dirname, '..', '..', 'src', 'server', 'engine-worker.ts');

test('the worker plays a pause and a stop from the snapshot, and takes a new table only with the snapshot that names it', async () => {
  const shared = universes.allocateShared();
  const w = new Worker(WORKER, { workerData: { shared, epochMs: hrtimeMs(), periodMs: FRAME_MS } });
  let frames = 0;
  await new Promise((resolve, reject) => {
    w.on('message', (m) => { if (m.type === 'ready') resolve(); if (m.type === 'frame') frames++; });
    w.once('error', reject);
  });
  const out = universes.createUniverseStore(shared, { readOnly: true });
  const dimmer = (fix) => out.getBuffer(fix.universe)[fix.address - 1 + getProfile(fix).channelMap.dimmer];
  const dims = () => PARS.map(dimmer);
  const after = async (n) => { const k = frames + n; const end = Date.now() + 2000; while (frames < k && Date.now() < end) await new Promise((r) => setTimeout(r, 5)); };
  const outputs = { ...transmitConfig(), armed: false };
  // The engine's two messages: a table when its revision is new, then the snapshot naming it.
  let posted;
  const post = (f, beat, { snapshot = true } = {}) => {
    if (f.table !== posted) { w.postMessage({ type: 'sequence', table: f.table }); posted = f.table; }
    if (!snapshot) return;
    const input = {
      running: true, ...LOOK, split: null, pixelMap: 'stage', strobeSpeed: 0, strobeFunction: 'standard', masterDimmer: 255,
      masterBlackout: false, energy: null, showDynamics: null, patternAnchor: null, fade: null, syncTest: null, universes: [0],
      fixtures: PARS, sequenceRevision: f.table?.revision ?? null, sequenceTransport: f.transport,
    };
    w.postMessage({ type: 'snapshot', at: hrtimeMs(), input, reading: { beatPos: beat, bpm: 120, epoch: 0, moving: false }, outputs });
  };
  // Light DJ's Blackout row on 10: dark there, the look elsewhere.
  const kill = validateSpec({ kind: 'energy.kill' });
  const r = rig();
  try {
    r.s.load(sequence({ clips: [clip('K', 'a', 0, 64, { effect: kill, targets: [10] })] }));
    r.s.play();
    post(r.s.frame(reading(1)), 1);
    await after(3);
    assert.deepEqual(dims(), [0, 255, 255]);
    // Paused: the clip holds; stopped with blackout: every fixture black.
    r.s.pause();
    post(r.s.frame(reading(2)), 2);
    await after(3);
    assert.deepEqual(dims(), [0, 255, 255]);
    r.s.stop({ blackout: true });
    post(r.s.frame(reading(3)), 3);
    await after(3);
    assert.deepEqual(dims(), [0, 0, 0]);
    // Another sequence: its table goes over first, and until its snapshot comes the black stays.
    r.s.load(sequence({ id: 'set-2', clips: [clip('K2', 'a', 0, 64, { effect: kill, targets: [12] })] }));
    const next = r.s.frame(reading(4));
    post(next, 4, { snapshot: false });
    await after(3);
    assert.deepEqual(dims(), [0, 0, 0], 'the last pair still plays');
    post(next, 4);
    await after(3);
    assert.deepEqual(dims(), [255, 255, 255], 'loaded, not playing: the look');
    r.s.play();
    post(r.s.frame(reading(5)), 5);
    await after(3);
    assert.deepEqual(dims(), [255, 255, 0]);
  } finally {
    await w.terminate();
  }
});

test('the beat the last frame was handed is what the detectors look a container\'s child up at, loaded or not', () => {
  const { s } = rig();
  assert.ok(Number.isNaN(s.lastBeat()), 'no frame yet, no beat');
  const first = reading(7.25);
  s.frame(first);
  assert.strictEqual(s.lastBeat(), first.beatPos, 'with no sequence loaded');
  s.load(sequence({ mode: 'playlist', lanes: [lane('rows')], clips: [clip('A', 'rows', 0, 4)] }));
  const next = reading(9.5);
  s.frame(next);
  assert.strictEqual(s.lastBeat(), next.beatPos);
});

test('replay keeps its initial palette when the old run ends that frame', () => {
  const r = rig();
  r.s.load(sequence({
    clips: [clip('A', 'a', 0, 8)],
    options: { initialPalette: 'redCyan' },
    commands: [{ id: 'tail', atBeat: 7.95, type: 'palette', value: 'rainbow' }],
  }));
  r.s.play();
  r.at(100);
  r.at(107.9);
  r.s.stop();
  r.s.play();
  assert.equal(r.at(108.5), 0);
  assert.equal(r.s.status().playing, true);
  assert.deepEqual(r.live.paletteOverride, PALETTE_HEX.redCyan);
  assert.equal(r.live.paletteOverrideId, 'redCyan');
});

test('replay restores the previous override when its own run ends', () => {
  const r = rig();
  r.live.paletteOverride = ['#123456'];
  r.s.load(sequence({
    clips: [clip('A', 'a', 0, 8)],
    options: { initialPalette: 'redCyan' },
  }));
  r.s.play();
  r.at(100);
  r.at(107.9);
  r.s.stop();
  r.s.play();
  r.at(108.5);
  const applied = r.applied.length;
  r.at(116.5);
  assert.deepEqual(r.applied.slice(applied), [{
    paletteOverride: ['#123456'], paletteOverrideId: null,
  }]);
  assert.equal(r.s.status().ended, true);
});
