// The sequencer's model (src/server/sequencer.ts): lanes of effect clips on a
// beat timeline, validated as they are saved and loaded, resolved into the
// clip table the renderer plays; which clip plays on which fixture
// (src/shared/effects/sequence.ts); and the shelf of saved sequences
// (src/server/sequence-store.ts).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Sequencer, validateSequence, MAX_SHARED_LANES } from '../../src/server/sequencer.ts';
import { SequenceStore, MAX_SEQUENCES } from '../../src/server/sequence-store.ts';
import { clipLap, playingClips, selectClips, sequencePlace } from '../../src/shared/effects/sequence.ts';
import { presetById } from '../../src/shared/effects/catalogue.ts';
import { validateSpec } from '../../src/shared/effects/registry.ts';
import { seedFrom } from '../../src/shared/effects/hash.ts';
import { domainOf } from '../../src/server/protocol.ts';
import { getLiveState, setSequenceProvider } from '../../src/server/state.ts';

const FADE = presetById('ldj.FadeCycle').spec;
const GLOW = validateSpec({ kind: 'energy.glow', params: {} });
const STROBE = presetById('palette-strobe').spec;
// Hue Dynamics' Disco with its automatic strobe on (Drum and Bass), and Disco set by hand.
const DISCO_STROBING = presetById('hd.disco.drumAndBass').spec;
function discoWith({ style, allowStrobe, strobeOnPeak }) {
  const params = structuredClone(presetById('hd.disco.pop').spec.params);
  params.channels[3].strobeOn = strobeOnPeak;
  return validateSpec({ kind: 'hd.disco', params: { ...params, style, allowStrobe } });
}
const resolve = (id) => ({ 'ldj.FadeCycle': FADE, 'palette-strobe': STROBE, 'hd.disco.trance': presetById('hd.disco.trance').spec })[id] ?? null;

const lane = (id, extra = {}) => ({ id, kind: 'shared', name: id, mute: false, solo: false, ...extra });
const track = (id, fixtureId, extra = {}) => ({ id, kind: 'track', fixtureId, name: id, mute: false, solo: false, ...extra });
const clip = (id, laneId, startBeat, lengthBeats, extra = {}) => ({
  id, laneId, startBeat, lengthBeats, loopBeats: lengthBeats, effect: GLOW, targets: 'lane', mute: false, ...extra,
});
const sequence = (extra = {}) => ({ id: 'set-1', name: 'Set one', lanes: [], clips: [], ...extra });

/** The clip table of a sequence, as the renderer gets it. */
function tableOf(raw) {
  const sequencer = new Sequencer({ resolve });
  sequencer.load(raw);
  return sequencer.table();
}

/** Per fixture id, the id of the clip on top at `position`, or null. */
function winners(table, position, ids) {
  const { winners: won } = selectClips(table, position, ids);
  return Object.fromEntries(ids.map((id, k) => [id, won[k] < 0 ? null : table.clips[won[k]].id]));
}

const refused = (fn, pattern) => assert.throws(fn, (err) => err.status === 400 && pattern.test(err.message), pattern.source);

// ── Which clip plays where ──────────────────────────────────────────────────

test('priority: a track clip beats a shared clip; the last lane in the list beats earlier ones; later start wins within a lane', () => {
  const ids = [10, 11, 12, 13];
  const table = tableOf(sequence({
    lanes: [lane('a'), lane('b'), track('t11', 11), lane('c')],
    clips: [
      clip('a-wide', 'a', 0, 16),
      // Lane b sits after a: wherever both play, b's clip shows.
      clip('b-two', 'b', 4, 8, { targets: [12, 13] }),
      // Within lane c, the clip that started later is on top while both play.
      clip('c-early', 'c', 8, 8, { targets: [13] }),
      clip('c-late', 'c', 10, 2, { targets: [13] }),
      // A track is its fixture's own: it beats every shared lane, the last one included.
      clip('t11-solo', 't11', 2, 4),
    ],
  }));
  assert.deepEqual(winners(table, 0, ids), { 10: 'a-wide', 11: 'a-wide', 12: 'a-wide', 13: 'a-wide' });
  assert.deepEqual(winners(table, 2, ids), { 10: 'a-wide', 11: 't11-solo', 12: 'a-wide', 13: 'a-wide' });
  assert.deepEqual(winners(table, 5, ids), { 10: 'a-wide', 11: 't11-solo', 12: 'b-two', 13: 'b-two' });
  // Lane c is last: its clip covers b's on fixture 13 though b's started first.
  assert.deepEqual(winners(table, 9, ids), { 10: 'a-wide', 11: 'a-wide', 12: 'b-two', 13: 'c-early' });
  assert.deepEqual(winners(table, 10, ids), { 10: 'a-wide', 11: 'a-wide', 12: 'b-two', 13: 'c-late' });
  // Half-open: c-late ends at 12, b-two at 12; c-early plays on to 16 over a-wide.
  assert.deepEqual(winners(table, 12, ids), { 10: 'a-wide', 11: 'a-wide', 12: 'a-wide', 13: 'c-early' });
  assert.deepEqual(winners(table, 16, ids), { 10: null, 11: null, 12: null, 13: null }, 'nothing covers beat 16');
  // Only the clips playing count as active, each once with its lap.
  assert.deepEqual(selectClips(table, 10, ids).active.map((a) => table.clips[a.index].id).sort(), ['a-wide', 'b-two', 'c-early', 'c-late']);

  // Two clips of one lane starting together: the one later in the list is on top.
  const tie = tableOf(sequence({ lanes: [lane('a')], clips: [clip('first', 'a', 0, 4), clip('second', 'a', 0, 4)] }));
  assert.deepEqual(winners(tie, 1, [10]), { 10: 'second' });
  // Fixture ids are identities: an id the patch has lost covers nothing, whatever its index.
  assert.deepEqual(winners(table, 2, [11, 99]), { 11: 't11-solo', 99: 'a-wide' });
});

test('the clips on top, highest first, for the audio detectors: nothing hidden, nothing before the start', () => {
  const t = tableOf(sequence({
    lanes: [lane('a'), lane('b'), track('t11', 11)],
    clips: [clip('a1', 'a', 0, 8), clip('b1', 'b', 0, 8, { targets: [12], loopBeats: 2 }), clip('t1', 't11', 0, 8), clip('hidden', 'a', 0, 8, { targets: [12] })],
  }));
  const transport = { startBeat: 10, loop: null, generation: 3 };
  // At beat 13 (position 3): the track's on 11, b1 on 12 (its second lap), a1 on 10; 'hidden' wins nowhere.
  assert.deepEqual(playingClips(t, transport, 13, [10, 11, 12]).map((c) => c.id), ['clip:t1:3.0.0', 'clip:b1:3.0.1', 'clip:a1:3.0.0']);
  assert.equal(playingClips(t, transport, 13, [10, 11, 12])[0].spec, t.clips[2].spec);
  assert.deepEqual(playingClips(t, transport, 13, [10]).map((c) => c.id), ['clip:a1:3.0.0'], 'only what plays on the patch');
  assert.deepEqual(playingClips(t, transport, 9, [10, 11, 12]), [], 'before the sequence starts');
});

test('mute and solo', () => {
  const ids = [10, 11];
  const base = {
    lanes: [lane('a'), lane('b'), track('t10', 10)],
    clips: [clip('a1', 'a', 0, 8), clip('b1', 'b', 0, 8, { targets: [11] }), clip('t1', 't10', 0, 8)],
  };
  assert.deepEqual(winners(tableOf(sequence(base)), 1, ids), { 10: 't1', 11: 'b1' });
  // A muted lane plays nothing; what is below it shows.
  const mutedB = { ...base, lanes: [lane('a'), lane('b', { mute: true }), track('t10', 10)] };
  assert.deepEqual(winners(tableOf(sequence(mutedB)), 1, ids), { 10: 't1', 11: 'a1' });
  // A muted clip likewise.
  const mutedTrackClip = { ...base, clips: [clip('a1', 'a', 0, 8), clip('b1', 'b', 0, 8, { targets: [11] }), clip('t1', 't10', 0, 8, { mute: true })] };
  assert.deepEqual(winners(tableOf(sequence(mutedTrackClip)), 1, ids), { 10: 'a1', 11: 'b1' });
  // A solo narrows the sequence to the soloed lanes.
  const soloA = { ...base, lanes: [lane('a', { solo: true }), lane('b'), track('t10', 10)] };
  assert.deepEqual(winners(tableOf(sequence(soloA)), 1, ids), { 10: 'a1', 11: 'a1' });
  // Hue Dynamics counts a solo before a mute: a muted solo lane plays nothing and still silences the rest.
  const mutedSolo = { ...base, lanes: [lane('a'), lane('b', { solo: true, mute: true }), track('t10', 10)] };
  assert.deepEqual(winners(tableOf(sequence(mutedSolo)), 1, ids), { 10: null, 11: null });
  // Two solos: both play, in their usual order.
  const twoSolos = { ...base, lanes: [lane('a', { solo: true }), lane('b', { solo: true }), track('t10', 10)] };
  assert.deepEqual(winners(tableOf(sequence(twoSolos)), 1, ids), { 10: 'a1', 11: 'b1' });
});

// ── Laps and the arrangement's loop ─────────────────────────────────────────

test('a clip covers [start, start + length) and laps every loopBeats; the arrangement loop is half-open', () => {
  const c = { startBeat: 4, lengthBeats: 10, loopBeats: 4 };
  const phase = (p) => { const l = clipLap(c, p); return l && { lap: l.lap, phase: p - l.lapStart }; };
  assert.equal(clipLap(c, 3.999), null);
  assert.deepEqual(phase(4), { lap: 0, phase: 0 });
  assert.deepEqual(phase(8), { lap: 1, phase: 0 });
  assert.deepEqual(phase(12), { lap: 2, phase: 0 });
  assert.deepEqual(phase(13.5), { lap: 2, phase: 1.5 });
  assert.equal(clipLap(c, 14), null, 'gone at its end');
  // Decimal loops land on their laps, not a hair before.
  const tenth = { startBeat: 0.1, lengthBeats: 3, loopBeats: 0.3 };
  for (let k = 0; k < 10; k++) {
    const l = clipLap(tenth, 0.1 + k * 0.3);
    assert.equal(l.lap, k, `lap ${k}`);
    assert.ok(0.1 + k * 0.3 - l.lapStart >= 0, 'never before its own start');
  }

  // Played from beat 100: nothing before, the sequence's beat after.
  const free = { startBeat: 100, loop: null, generation: 0 };
  assert.equal(sequencePlace(free, 99.5), null);
  assert.deepEqual(sequencePlace(free, 105), { elapsed: 5, position: 5, traversal: 0, origin: 100 });
  // A loop region [4, 8): the end is never reached, the start is; each wrap is a traversal of its own.
  const looped = { startBeat: 100, loop: { on: true, startBeat: 4, endBeat: 8 }, generation: 0 };
  assert.deepEqual(sequencePlace(looped, 107.5), { elapsed: 7.5, position: 7.5, traversal: 0, origin: 100 });
  assert.deepEqual(sequencePlace(looped, 108), { elapsed: 8, position: 4, traversal: 1, origin: 104 });
  assert.deepEqual(sequencePlace(looped, 111.5), { elapsed: 11.5, position: 7.5, traversal: 1, origin: 104 });
  assert.deepEqual(sequencePlace(looped, 112), { elapsed: 12, position: 4, traversal: 2, origin: 108 });
  // A loop switched off plays straight through.
  assert.deepEqual(sequencePlace({ ...looped, loop: { on: false, startBeat: 4, endBeat: 8 } }, 112), { elapsed: 12, position: 12, traversal: 0, origin: 100 });
});

// ── The model ───────────────────────────────────────────────────────────────

test('a sequence validates: one effect per clip, known lanes, unique ids, finite placements, the lane caps', () => {
  // The fields left out take their defaults.
  const minimal = validateSequence(sequence({ lanes: [lane('a')], clips: [{ id: 'c', laneId: 'a', startBeat: 0, lengthBeats: 4, presetId: 'ldj.FadeCycle' }] }));
  assert.deepEqual(minimal, {
    id: 'set-1', name: 'Set one', mode: 'arrangement', bpm: null, timeSignature: { beats: 4, unit: 4 }, musicMode: null, loop: null, snap: 1,
    lanes: [lane('a')],
    clips: [{ id: 'c', laneId: 'a', startBeat: 0, lengthBeats: 4, loopBeats: 4, presetId: 'ldj.FadeCycle', targets: 'lane', mute: false }],
    commands: [], automation: { tempo: null, brightness: null },
    options: { autoplay: true, shuffle: false, randomPaletteOnLoop: false, initialPalette: null },
  });
  // An inline effect is validated as any spec, and validating it again changes nothing.
  const inline = validateSequence(sequence({ lanes: [lane('a')], clips: [{ ...clip('c', 'a', 0, 4), effect: { kind: 'ldj.FadeCycle' } }] }));
  assert.deepEqual(inline.clips[0].effect, validateSpec({ kind: 'ldj.FadeCycle' }));
  assert.deepEqual(validateSequence(inline), inline);

  const ok = sequence({ lanes: [lane('a'), track('t', 3)], clips: [clip('c', 'a', 0, 4)] });
  refused(() => validateSequence({ ...ok, clips: [{ ...clip('c', 'a', 0, 4), presetId: 'ldj.FadeCycle' }] }), /exactly one of effect or presetId/);
  refused(() => validateSequence({ ...ok, clips: [{ id: 'c', laneId: 'a', startBeat: 0, lengthBeats: 4 }] }), /exactly one of effect or presetId/);
  refused(() => validateSequence({ ...ok, clips: [{ ...clip('c', 'a', 0, 4), effect: { kind: 'no.such' } }] }), /clips\.0\.effect\.kind/);
  refused(() => validateSequence({ ...ok, clips: [{ ...clip('c', 'a', 0, 4), effect: { kind: 'ldj.FadeCycle', params: { cadence: -1 } } }] }),
    /clips\.0\.effect\.params\.cadence/);
  refused(() => validateSequence({ ...ok, clips: [clip('c', 'nowhere', 0, 4)] }), /clips\.0\.laneId no lane nowhere/);
  refused(() => validateSequence({ ...ok, clips: [clip('c', 'a', 0, 4), clip('c', 'a', 4, 4)] }), /clips\.1\.id c is used twice/);
  refused(() => validateSequence({ ...ok, lanes: [lane('a'), lane('a')] }), /lanes\.1\.id a is used twice/);
  refused(() => validateSequence({ ...ok, id: '' }), /id/);
  refused(() => validateSequence({ ...ok, clips: [clip('', 'a', 0, 4)] }), /clips\.0\.id/);
  refused(() => validateSequence({ ...ok, clips: [clip('c', 'a', -1, 4)] }), /clips\.0\.startBeat/);
  refused(() => validateSequence({ ...ok, clips: [clip('c', 'a', 0, 0)] }), /clips\.0\.lengthBeats/);
  refused(() => validateSequence({ ...ok, clips: [clip('c', 'a', 0, 4, { loopBeats: 0 })] }), /clips\.0\.loopBeats/);
  refused(() => validateSequence({ ...ok, clips: [clip('c', 'a', Number.MAX_VALUE, Number.MAX_VALUE)] }), /clips\.0 ends past/);
  // A loop so short against its clip that its laps cannot be counted exactly.
  refused(() => validateSequence({ ...ok, clips: [clip('c', 'a', 0, 1e9, { loopBeats: 1e-9 })] }), /clips\.0\.loopBeats/);
  refused(() => validateSequence({ ...ok, clips: [clip('c', 'a', 0, 4, { targets: [1.5] })] }), /clips\.0\.targets/);
  refused(() => validateSequence({ ...ok, clips: [clip('c', 'a', 0, 4, { targets: [1, 1] })] }), /clips\.0\.targets\.1 1 is named twice/);
  refused(() => validateSequence({ ...ok, clips: [clip('c', 'a', 0, 4, { spec: GLOW, effect: undefined })] }), /Unrecognized key.*"spec"/);
  // Each lap is a fresh instance: the strobe's five-a-second permit would start again every lap.
  refused(() => validateSequence({ ...ok, clips: [clip('c', 'a', 0, 4, { effect: STROBE })] }), /clips\.0\.effect\.kind a clip may not hold the strobe/);
  // Disco's automatic strobe keeps its limit in its own state too; Disco without it plays.
  refused(() => validateSequence({ ...ok, clips: [clip('c', 'a', 0, 4, { effect: DISCO_STROBING })] }),
    /clips\.0\.effect\.params a clip may not hold an automatic strobe/);
  refused(() => validateSequence({ ...ok, clips: [clip('c', 'a', 0, 4, { effect: discoWith({ style: 'peak', allowStrobe: false, strobeOnPeak: true }) })] }),
    /clips\.0\.effect\.params a clip may not hold an automatic strobe/);
  validateSequence({ ...ok, clips: [clip('c', 'a', 0, 4, { effect: presetById('hd.disco.pop').spec })] });
  validateSequence({ ...ok, clips: [clip('c', 'a', 0, 4, { effect: discoWith({ style: 'neural', allowStrobe: true, strobeOnPeak: true }) })] });

  // Three shared lanes at most, and one track per fixture; a track names its fixture and a shared lane none.
  const fourShared = [lane('a'), lane('b'), lane('c'), lane('d')];
  assert.equal(MAX_SHARED_LANES, 3);
  refused(() => validateSequence({ ...ok, lanes: fourShared }), /lanes at most 3 shared lanes/);
  validateSequence({ ...ok, lanes: [...fourShared.slice(0, 3), track('t1', 1), track('t2', 2), track('t3', 3), track('t4', 4)] });
  refused(() => validateSequence({ ...ok, lanes: [lane('a'), track('t', 3), track('u', 3)] }), /lanes\.2\.fixtureId fixture 3 has a track already/);
  refused(() => validateSequence({ ...ok, lanes: [lane('a'), { ...track('t', 3), fixtureId: undefined }] }), /lanes\.1\.fixtureId/);
  refused(() => validateSequence({ ...ok, lanes: [{ ...lane('a'), fixtureId: 3 }] }), /lanes\.0\.fixtureId a shared lane names no fixture/);
  // No cap on lights: Hue Dynamics' ten-light limit is not this rig's.
  validateSequence({ ...ok, lanes: [lane('a'), ...Array.from({ length: 40 }, (_, i) => track(`t${i}`, i))] });

  // The clock's numbers: a time signature as Hue Dynamics keeps one, a snap, a tempo, a loop.
  refused(() => validateSequence({ ...ok, timeSignature: { beats: 0, unit: 4 } }), /timeSignature\.beats/);
  refused(() => validateSequence({ ...ok, timeSignature: { beats: 33, unit: 4 } }), /timeSignature\.beats/);
  refused(() => validateSequence({ ...ok, timeSignature: { beats: 6, unit: 6 } }), /timeSignature\.unit/);
  refused(() => validateSequence({ ...ok, timeSignature: { beats: 6, unit: 64 } }), /timeSignature\.unit/);
  validateSequence({ ...ok, timeSignature: { beats: 6, unit: 8 } });
  refused(() => validateSequence({ ...ok, snap: 0 }), /snap/);
  refused(() => validateSequence({ ...ok, bpm: 10 }), /bpm/);
  refused(() => validateSequence({ ...ok, loop: { on: true, startBeat: 8, endBeat: 8 } }), /loop\.endBeat/);
  refused(() => validateSequence({ ...ok, musicMode: 'loud' }), /musicMode/);

  // Light DJ's command rows: a beat and a value of the command's own kind.
  const cmd = (type, value, atBeat = 0, id = 'k') => ({ ...ok, commands: [{ id, atBeat, type, value }] });
  validateSequence(cmd('palette', 'ldj.party'));
  validateSequence(cmd('tempo', 128));
  validateSequence(cmd('brightness', 0));
  validateSequence(cmd('goto', 16));
  refused(() => validateSequence(cmd('tempo', 400)), /commands\.0\.value/);
  refused(() => validateSequence(cmd('brightness', 256)), /commands\.0\.value/);
  refused(() => validateSequence(cmd('palette', 3)), /commands\.0\.value/);
  refused(() => validateSequence(cmd('goto', -1)), /commands\.0\.value/);
  refused(() => validateSequence(cmd('tempo', 120, Infinity)), /commands\.0\.atBeat/);
  refused(() => validateSequence({ ...ok, commands: [cmd('tempo', 120).commands[0], cmd('tempo', 130).commands[0]] }), /commands\.1\.id k is used twice/);

  // Automation: a period of 1 to 512, in the property's own range; target mode needs its target.
  const auto = (which, a) => ({ ...ok, automation: { tempo: null, brightness: null, [which]: a } });
  const sine = { mode: 'sine', period: 8, min: 0, max: 100, growing: true };
  validateSequence(auto('brightness', sine));
  validateSequence(auto('brightness', { ...sine, period: 1 }));
  validateSequence(auto('brightness', { ...sine, period: 512 }));
  refused(() => validateSequence(auto('brightness', { ...sine, period: 0 })), /automation\.brightness\.period/);
  refused(() => validateSequence(auto('brightness', { ...sine, period: 513 })), /automation\.brightness\.period/);
  refused(() => validateSequence(auto('brightness', { ...sine, period: 2.5 })), /automation\.brightness\.period/);
  refused(() => validateSequence(auto('brightness', { ...sine, max: 300 })), /automation\.brightness\.max/);
  refused(() => validateSequence(auto('brightness', { ...sine, min: 200, max: 100 })), /automation\.brightness\.min/);
  refused(() => validateSequence(auto('tempo', { ...sine, min: 0 })), /automation\.tempo\.min/);
  validateSequence(auto('tempo', { ...sine, min: 100, max: 140 }));
  refused(() => validateSequence(auto('brightness', { ...sine, mode: 'target' })), /automation\.brightness\.target target mode needs a target/);
  validateSequence(auto('brightness', { ...sine, mode: 'target', target: 85 }));
  refused(() => validateSequence(auto('tempo', { ...sine, min: 100, max: 140, mode: 'target', target: 10 })), /automation\.tempo\.target/);
});

test('a playlist is one shared lane of rows in order that never overlap; a sequence that is none is refused, never trimmed', () => {
  const rows = [clip('r1', 'a', 0, 8), clip('r2', 'a', 8, 4), clip('r3', 'a', 16, 8)];
  const playlist = validateSequence(sequence({ mode: 'playlist', lanes: [lane('a')], clips: rows }));
  assert.equal(playlist.mode, 'playlist');
  assert.deepEqual(playlist.clips.map((c) => c.id), ['r1', 'r2', 'r3']);
  refused(() => validateSequence(sequence({ mode: 'playlist', lanes: [lane('a'), lane('b')], clips: rows })), /mode a playlist plays one shared lane/);
  refused(() => validateSequence(sequence({ mode: 'playlist', lanes: [track('a', 1)], clips: rows })), /mode a playlist plays one shared lane/);
  refused(() => validateSequence(sequence({ mode: 'playlist', lanes: [lane('a')], clips: [rows[1], rows[0]] })), /clips\.1 a playlist's rows run in order/);
  refused(() => validateSequence(sequence({ mode: 'playlist', lanes: [lane('a')], clips: [rows[0], clip('r2', 'a', 7, 4)] })),
    /clips\.1 a playlist's rows run in order/);
  // The same rows as an arrangement are fine, overlapping or not.
  validateSequence(sequence({ lanes: [lane('a'), lane('b')], clips: [rows[1], rows[0], clip('x', 'b', 2, 3)] }));
});

// ── The table ───────────────────────────────────────────────────────────────

test('the table resolves every clip\'s effect, keeps explicit fixture ids and maps lane targets', () => {
  const sequencer = new Sequencer({ resolve });
  assert.equal(sequencer.table(), null, 'nothing loaded');
  const raw = sequence({
    lanes: [lane('a'), track('t3', 3), lane('b', { mute: true })],
    clips: [
      { ...clip('preset', 'a', 0, 8), effect: undefined, presetId: 'ldj.FadeCycle' },
      clip('ids', 'a', 8, 4, { targets: [3, 99, 1] }),
      clip('own', 't3', 0, 4),
      // An explicit target on a track keeps only the track's fixture: none here.
      clip('elsewhere', 't3', 4, 4, { targets: [1, 2] }),
      clip('kept', 't3', 8, 4, { targets: [3, 5] }),
      clip('muted', 'b', 0, 4, { mute: true }),
    ],
  });
  sequencer.load(raw);
  const table = sequencer.table();
  assert.ok(Object.isFrozen(table) && Object.isFrozen(table.clips[0].spec), 'the engine keeps what it is handed');
  assert.equal(table.revision, 1);
  assert.deepEqual(table.lanes, raw.lanes);
  const byId = Object.fromEntries(table.clips.map((c) => [c.id, c]));
  assert.equal(byId.preset.spec, FADE, 'the library\'s own frozen spec');
  assert.deepEqual(byId.own.spec, GLOW);
  assert.deepEqual(Object.fromEntries(table.clips.map((c) => [c.id, c.fixtureIds])),
    { preset: null, ids: [3, 99, 1], own: [3], elsewhere: [], kept: [3], muted: null });
  assert.deepEqual(byId.muted.mute, true);
  assert.deepEqual(byId.preset.seed, seedFrom('clip:set-1:preset'), 'the seed is the clip\'s, whatever the revision');
  assert.deepEqual(Object.keys(byId.ids).sort(), ['fixtureIds', 'id', 'laneId', 'lengthBeats', 'loopBeats', 'mute', 'seed', 'spec', 'startBeat']);

  // Loading the same content again is the same table: no new revision to post.
  sequencer.load(structuredClone(raw));
  assert.equal(sequencer.table(), table);
  // The same content after its preset changed in the library plays the preset as it is now.
  let fade = FADE;
  const library = new Sequencer({ resolve: (id) => (id === 'ldj.FadeCycle' ? fade : resolve(id)) });
  library.load(raw);
  library.load(raw);
  assert.equal(library.table().revision, 1);
  fade = validateSpec({ kind: 'ldj.FadeCycle', params: { cadence: 2 } });
  library.load(raw);
  assert.equal(library.table().revision, 2);
  assert.equal(library.table().clips[0].spec, fade);
  // An edit is a new revision; the seeds stay.
  sequencer.load({ ...raw, clips: raw.clips.map((c) => (c.id === 'own' ? { ...c, lengthBeats: 2, loopBeats: 2 } : c)) });
  assert.equal(sequencer.table().revision, 2);
  assert.deepEqual(sequencer.table().clips[0].seed, byId.preset.seed);

  // A preset the library does not have is refused, and the loaded sequence stays.
  refused(() => sequencer.load({ ...raw, clips: [{ ...clip('x', 'a', 0, 4), effect: undefined, presetId: 'gone' }] }), /clips\.0\.presetId no effect gone/);
  assert.equal(sequencer.table().revision, 2);
  assert.equal(sequencer.current().clips.length, raw.clips.length);
  // So is a library row that is a pattern, not an effect, and the strobe by its preset.
  refused(() => sequencer.load({ ...raw, clips: [{ ...clip('x', 'a', 0, 4), effect: undefined, presetId: 'chase' }] }), /no effect chase/);
  refused(() => sequencer.load({ ...raw, clips: [{ ...clip('x', 'a', 0, 4), effect: undefined, presetId: 'palette-strobe' }] }),
    /clips\.0\.presetId a clip may not hold the strobe/);
  refused(() => sequencer.load({ ...raw, clips: [{ ...clip('x', 'a', 0, 4), effect: undefined, presetId: 'hd.disco.trance' }] }),
    /clips\.0\.presetId a clip may not hold an automatic strobe/);
  // A table that holds one anyway (it came from somewhere else) never plays it.
  const forged = { revision: 9, lanes: [lane('a')], clips: [{ id: 's', laneId: 'a', fixtureIds: null, startBeat: 0, lengthBeats: 4, loopBeats: 1, spec: STROBE, seed: [1, 2, 3, 4], mute: false }] };
  assert.deepEqual(winners(forged, 1, [10]), { 10: null });
  assert.deepEqual(winners({ ...forged, clips: [{ ...forged.clips[0], spec: DISCO_STROBING }] }, 1, [10]), { 10: null });

  // The loaded sequence as a copy; unloading clears the table.
  sequencer.current().clips.length = 0;
  assert.equal(sequencer.current().clips.length, raw.clips.length);
  // What is loaded, of the status (the transport's fields: sequencer-transport.test.js).
  const loaded = ({ loaded: l, revision, mode }) => ({ loaded: l, revision, mode });
  assert.deepEqual(loaded(sequencer.status()), { loaded: { id: 'set-1', name: 'Set one' }, revision: 2, mode: 'arrangement' });
  sequencer.unload();
  assert.equal(sequencer.table(), null);
  assert.equal(sequencer.current(), null);
  assert.deepEqual(loaded(sequencer.status()), { loaded: null, revision: 3, mode: null });
  // Nothing plays until the transport starts it: loading launches nothing.
  sequencer.load(raw);
  assert.deepEqual(sequencer.frame({ beatPos: 0, bpm: 120, epoch: 0 }), { table: sequencer.table(), transport: null });
  // Autoplay moves a playing playlist on from row to row; it starts nothing. Loaded with it on, a playlist stays still.
  const playlist = new Sequencer({ resolve });
  assert.equal(playlist.load(sequence({ mode: 'playlist', lanes: [lane('a')], clips: [clip('r1', 'a', 0, 8)] })).options.autoplay, true);
  assert.equal(playlist.frame({ beatPos: 0, bpm: 120, epoch: 0 }).transport, null);
});

test('the live state carries the sequencer\'s status in a domain of its own', () => {
  assert.equal(domainOf('sequence'), 'sequence');
  const sequencer = new Sequencer({ resolve });
  try {
    setSequenceProvider(() => sequencer.status());
    const idle = { playing: false, paused: false, stopped: null, ended: false, beat: 0, bar: 1, beatsPerBar: 4, loop: null, error: null };
    assert.deepEqual(getLiveState().sequence, { loaded: null, revision: 0, mode: null, ...idle, lanes: [] });
    sequencer.load(sequence({ mode: 'playlist', lanes: [lane('a')] }));
    assert.deepEqual(getLiveState().sequence, { loaded: { id: 'set-1', name: 'Set one' }, revision: 1, mode: 'playlist', ...idle, lanes: [{ id: 'a', clip: null }] });
  } finally {
    setSequenceProvider(null);
  }
  assert.equal(getLiveState().sequence, null, 'without a sequencer');
});

// ── The shelf ───────────────────────────────────────────────────────────────

function place(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sequence-store-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, file: path.join(dir, 'sequences.json') };
}
const quietly = (t) => t.mock.method(console, 'warn', () => {});
const onDisk = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const invalidIn = (dir) => fs.readdirSync(dir).filter((f) => f.includes('.invalid-'));

test('the shelf keeps up to 64 sequences in a versioned file, saved whole and validated', (t) => {
  const { file } = place(t);
  const store = new SequenceStore(file).load();
  let heard = 0;
  store.onChange(() => { heard++; });
  assert.deepEqual(store.list(), []);

  const saved = store.save(sequence({ lanes: [lane('a')], clips: [clip('c', 'a', 0, 4)] }));
  assert.deepEqual(saved, validateSequence(sequence({ lanes: [lane('a')], clips: [clip('c', 'a', 0, 4)] })));
  assert.deepEqual(onDisk(file), { version: 1, sequences: [saved] });
  assert.deepEqual(new SequenceStore(file).load().list(), [saved], 'a restart reads it back');
  assert.equal(heard, 1);
  // The live state's summaries: each sequence's id and name, in shelf order.
  assert.deepEqual(store.summaries(), [{ id: 'set-1', name: 'Set one' }]);
  // The same again is no write; a copy handed out is the caller's own.
  const write = t.mock.method(store, 'write');
  store.save(structuredClone(saved));
  assert.equal(write.mock.callCount(), 0);
  write.mock.restore();
  store.get('set-1').clips.length = 0;
  assert.equal(store.get('set-1').clips.length, 1);
  assert.equal(store.get('nope'), null);

  // An update replaces it in place.
  const renamed = store.save({ ...saved, name: 'Renamed' });
  assert.equal(renamed.name, 'Renamed');
  assert.deepEqual(store.list().map((s) => s.name), ['Renamed']);
  assert.deepEqual(store.summaries(), [{ id: 'set-1', name: 'Renamed' }]);
  assert.equal(heard, 2);
  refused(() => store.save({ ...saved, clips: [clip('c', 'nowhere', 0, 4)] }), /sequence: clips\.0\.laneId/);
  assert.equal(store.get('set-1').name, 'Renamed', 'a refused save changes nothing');

  // Full at 64: a new one is refused, an update to one already there is not.
  for (let i = 2; i <= MAX_SEQUENCES; i++) store.save(sequence({ id: `set-${i}`, name: `Set ${i}` }));
  assert.equal(store.list().length, 64);
  refused(() => store.save(sequence({ id: 'set-65', name: 'One more' })), /full \(64 sequences\)/);
  assert.equal(store.save({ ...saved, name: 'Still fits' }).name, 'Still fits');

  assert.equal(store.remove('set-1'), true);
  assert.equal(store.remove('set-1'), false);
  assert.equal(store.list().length, 63);
  assert.ok(!store.summaries().some((q) => q.id === 'set-1'));
});

test('a shelf file that does not validate is moved aside whole, and a failed write keeps what was there', (t) => {
  const { dir, file } = place(t);
  quietly(t);
  const movedAside = (body) => {
    fs.writeFileSync(file, JSON.stringify(body));
    const list = new SequenceStore(file).load().list();
    const moved = invalidIn(dir);
    for (const f of moved) fs.rmSync(path.join(dir, f));
    return list.length === 0 && moved.length === 1 && !fs.existsSync(file);
  };
  assert.ok(movedAside({ version: 1, sequences: [sequence({ clips: [clip('c', 'nowhere', 0, 4)] })] }));
  // A file from a later version is not this one's to read.
  assert.ok(movedAside({ version: 2, sequences: [] }));
  assert.ok(movedAside({ sequences: [] }), 'nor one that does not say');
  // Two sequences under one id.
  assert.ok(movedAside({ version: 1, sequences: [sequence(), sequence()] }));

  const store = new SequenceStore(file).load();
  const kept = store.save(sequence());
  t.mock.method(store, 'write', () => { throw new Error('disk full'); });
  assert.throws(() => store.save({ ...kept, name: 'Lost' }), (err) => err.status === 500 && /disk full/.test(err.message));
  assert.equal(store.get('set-1').name, 'Set one');
  assert.deepEqual(onDisk(file).sequences.map((s) => s.name), ['Set one']);
});
