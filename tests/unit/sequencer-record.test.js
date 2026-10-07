// Punch recording against the record-transaction and voice-duration rulings:
// staged pattern hits, loop and strobe pads, keep conflicts, loop wraps.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Sequencer, sequenceBeatAhead, padTakeOf, validatePattern } from '../../src/server/sequencer.ts';
import { Pads, PadStore, STROBE_ID, patternPlayer } from '../../src/server/pads.ts';
import { VoiceManager, builtinPresets } from '../../src/server/voices.ts';
import { presetById } from '../../src/shared/effects/index.ts';

const GLOW = { kind: 'energy.glow', params: {} };
const resolve = (id) => (id === 'ldj.FadeCycle' ? presetById('ldj.FadeCycle').spec : null);
const shared = (id) => ({ id, kind: 'shared', name: id, mute: false, solo: false });
const track = (id, fixtureId) => ({ id, kind: 'track', fixtureId, name: id, mute: false, solo: false });
const SET = { id: 'set', name: 'Set', lanes: [shared('a'), track('t2', 2)], clips: [{ id: 'A', laneId: 'a', startBeat: 0, lengthBeats: 4, effect: GLOW, targets: 'lane', mute: false }] };
const PATTERN = {
  id: 'drop', name: 'Drop', lengthBeats: 8,
  lanes: [
    { kind: 'shared', slot: 1, clips: [{ startBeat: 0, lengthBeats: 4, presetId: 'ldj.FadeCycle', targets: 'lane', mute: false }] },
    { kind: 'track', slot: 1, clips: [{ startBeat: 2, lengthBeats: 2, effect: GLOW, targets: 'lane', mute: false }] },
  ],
};
const rounded = (clips) => clips.map((c) => [c.laneId, Math.round(c.startBeat * 1e6) / 1e6, Math.round(c.lengthBeats * 1e6) / 1e6, c.targets]);

function rig({ fixtures = [1, 2, 3], pad = () => null } = {}) {
  const s = new Sequencer({ resolve, fixtureIds: () => fixtures, pattern: (id) => (id === 'drop' ? PATTERN : null), pad });
  s.load(SET);
  return s;
}

test('concurrent edits preserve both the sequence and unkept take', () => {
  const s = rig({ pad: () => ({ presetId: 'ldj.FadeCycle', targets: 'shared', lengthBeats: 2 }) });
  s.startRecording({ mode: 'overdub', countInBeats: 0, quantise: 1 });
  s.onPadHit({ bank: 0, slot: 1, startBeat: 1 });
  s.load({ ...SET, name: 'Edited' });
  const revision = s.revision();
  assert.throws(() => s.stopRecording(true), (e) => e.status === 409);
  assert.equal(s.revision(), revision);
  assert.equal(s.current().name, 'Edited');
  assert.equal(s.status().recording.hits, 1, 'the take is kept for a discard');
  assert.deepEqual(s.stopRecording(false), { added: [], removed: [] });
});

test('pattern hits expand atomically when a take is kept', () => {
  const s = rig({ pad: (_bank, slot) => (slot === 3 ? { patternId: 'drop', targets: 'shared' } : null) });
  const before = s.revision();
  s.startRecording({ mode: 'overdub', countInBeats: 0, quantise: 1 });
  s.onPadHit({ bank: 0, slot: 3, startBeat: 6.2 });
  assert.deepEqual(s.dropPattern('drop', 16), [], 'a sequencePattern pad during a take is staged, not inserted');
  assert.equal(s.revision(), before);
  assert.equal(s.status().recording.hits, 2);
  s.stopRecording(false);
  assert.equal(s.revision(), before, 'discard drops both');
  assert.equal(s.current().clips.length, 1);

  s.startRecording({ mode: 'overdub', countInBeats: 0, quantise: 1 });
  s.onPadHit({ bank: 0, slot: 3, startBeat: 6 });
  s.dropPattern('drop', 16);
  const kept = s.stopRecording(true);
  assert.equal(s.revision(), before + 1, 'one revision for the whole take');
  const lane2 = s.current().lanes.filter((l) => l.kind === 'shared')[1].id;
  assert.deepEqual(rounded(kept.added), [[lane2, 6, 4, 'lane'], ['t2', 8, 2, 'lane'], [lane2, 16, 4, 'lane'], ['t2', 18, 2, 'lane']]);

  // Without a take the drop inserts straight away.
  assert.equal(s.dropPattern('drop', 32).length, 2);
});

test('held patterns map fixture slots through their recorded duration', () => {
  const s = rig({ pad: (_bank, slot) => (slot === 3 ? { patternId: 'drop', targets: 'shared' } : { patternId: 'drop', targets: [3] }) });
  s.startRecording({ mode: 'overdub', countInBeats: 0, quantise: 1 });
  s.onPadHit({ bank: 0, slot: 3, startBeat: 0 });
  s.onPadHit({ bank: 0, slot: 3, startBeat: 0, endBeat: 12 });
  s.onPadHit({ bank: 0, slot: 4, startBeat: 20 });
  const kept = s.stopRecording(true);
  const lane2 = s.current().lanes.filter((l) => l.kind === 'shared')[1].id;
  // Fixture 3 alone: shared clips on it, track slot 1 has no fixture and is skipped.
  assert.deepEqual(rounded(kept.added), [[lane2, 0, 4, 'lane'], ['t2', 2, 2, 'lane'], [lane2, 8, 4, 'lane'], ['t2', 10, 2, 'lane'], [lane2, 20, 4, [3]]]);
});

test('a sequencePattern drop that cannot map refuses the keep and keeps the take', () => {
  const s = rig({ fixtures: [1] });
  s.startRecording({ mode: 'overdub', countInBeats: 0, quantise: 1 });
  s.dropPattern('drop', 4);
  const revision = s.revision();
  assert.throws(() => s.stopRecording(true), (e) => e.status === 409);
  assert.equal(s.revision(), revision);
  assert.equal(s.status().recording.hits, 1);
});

test('a hit with no release takes an explicit length first, else the pad length', () => {
  const s = rig({ pad: () => ({ presetId: 'ldj.FadeCycle', targets: 'shared', lengthBeats: 4 }) });
  s.startRecording({ mode: 'overdub', countInBeats: 0, quantise: 1 });
  s.onPadHit({ bank: 0, slot: 1, startBeat: 2, lengthBeats: 3.2 });
  s.onPadHit({ bank: 0, slot: 2, startBeat: 8 });
  assert.deepEqual(rounded(s.stopRecording(true).added).map((c) => c[2]), [3, 4]);
});

test('padTakeOf follows the duration precedence and records no strobe', () => {
  const lookup = (id) => (id === 'fade' ? { spec: { kind: 'ldj.FadeCycle', params: { beats: 8 } }, lengthBeats: undefined }
    : id === 'one' ? { spec: { kind: 'energy.glow', params: {}, scope: 'singleBeat' } }
      : id === 'set' ? { spec: GLOW, lengthBeats: 2 } : null);
  const entry = (content, targets = 'shared') => ({ content, targets });
  assert.deepEqual(padTakeOf(entry({ kind: 'preset', id: 'set' }), lookup), { presetId: 'set', targets: 'shared', lengthBeats: 2 });
  assert.equal(padTakeOf(entry({ kind: 'preset', id: 'fade' }), lookup).lengthBeats, 8);
  assert.equal(padTakeOf(entry({ kind: 'preset', id: 'one' }), lookup).lengthBeats, 1);
  assert.deepEqual(padTakeOf(entry({ kind: 'pattern', id: 'drop' }, [2]), lookup), { patternId: 'drop', targets: [2] });
  assert.equal(padTakeOf(entry({ kind: 'strobe', id: STROBE_ID }), lookup), null, 'the strobe is never a clip');
  assert.equal(padTakeOf(entry({ kind: 'sequencePattern', id: 'drop' }), lookup), null, 'a drop records through dropPattern');
  assert.equal(padTakeOf(entry(null), lookup), null);
});

test('a conductor beat ahead maps onto the sequence through a loop wrap', () => {
  const loop = { on: true, startBeat: 4, endBeat: 12 };
  assert.equal(sequenceBeatAhead(10, 3, loop), 5);
  assert.equal(sequenceBeatAhead(10, 1, loop), 11);
  assert.equal(sequenceBeatAhead(10, 19, loop), 5, 'more than one wrap');
  assert.equal(sequenceBeatAhead(10, 3, { ...loop, on: false }), 13);
  assert.equal(sequenceBeatAhead(13, 3, loop), 16, 'past the loop already: no wrap');
  assert.equal(sequenceBeatAhead(10, 3, null), 13);
  assert.equal(sequenceBeatAhead(1, -3, null), 0);
});

function padRig(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const c = { now: 1000, beat: 4.2 };
  const voices = new VoiceManager({ now: () => c.now, beatPos: () => c.beat, bpm: () => 120, acknowledged: () => true, anyRunning: () => false, onChange: () => {} });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-pads-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new PadStore(path.join(dir, 'pads.json')).load();
  const strobe = { hold: () => ({ id: 'strobe-voice' }), release: () => {} };
  const patternVoice = patternPlayer({ voices, pattern: () => null, fixtureIds: () => [0, 1], resolve: () => null });
  const pads = new Pads({ voices, store, lookup: () => builtinPresets, pattern: () => null, fixtureIds: () => [0, 1], beat: () => c.beat, strobe, patternVoice });
  const heard = [];
  pads.onHit = (hit) => heard.push(hit);
  return { c, pads, store, heard };
}

test('turning a loop pad off ends its recorded clip at that beat', (t) => {
  const { c, pads, store, heard } = padRig(t);
  store.set(0, 0, { label: 'Loop', accent: '#A855F7', content: { kind: 'preset', id: 'ldj.FadeCycle' }, launch: 'loop', quantise: 1, targets: 'shared' });
  assert.ok(pads.press(0, 0, 'tablet', 't'));
  c.beat = 9.7;
  assert.equal(pads.press(0, 0, 'tablet', 't'), null);
  assert.deepEqual(heard, [{ bank: 0, slot: 0, startBeat: 5 }, { bank: 0, slot: 0, startBeat: 5, endBeat: 9.7 }]);
  // A loop started by the toggle route ends the same way.
  pads.toggle(0, 0);
  c.beat = 12;
  pads.toggle(0, 0);
  assert.deepEqual(heard.slice(2), [{ bank: 0, slot: 0, startBeat: 10 }, { bank: 0, slot: 0, startBeat: 10, endBeat: 12 }]);
});

test('strobe pads do not record: the strobe is never a clip', (t) => {
  const { c, pads, store, heard } = padRig(t);
  store.set(0, 1, { label: 'Strobe', accent: '#E2E8F0', content: { kind: 'strobe', id: STROBE_ID }, launch: 'hold', quantise: 0, targets: 'shared' });
  assert.ok(pads.press(0, 1, 'tablet', 't'));
  c.beat = 8;
  assert.equal(pads.release(0, 1, 'tablet', 't'), true);
  assert.deepEqual(heard, []);
});

test('staged pattern hits retain the content they launched', () => {
  const patterns = [PATTERN];
  const s = new Sequencer({ resolve, fixtureIds: () => [1, 2, 3], pattern: (id) => patterns.find((p) => p.id === id) ?? null, pad: () => ({ patternId: 'drop', targets: 'shared' }) });
  s.load(SET);
  s.startRecording({ mode: 'overdub', countInBeats: 0, quantise: 1 });
  s.onPadHit({ bank: 0, slot: 3, startBeat: 0 });
  s.dropPattern('drop', 8);
  patterns.length = 0;
  assert.equal(s.onPadHit({ bank: 0, slot: 5, startBeat: 9 }), null, 'a pad whose pattern is gone records nothing');
  assert.equal(s.stopRecording(true).added.length, 4);
});

// The loaded sequence lives in memory only (the shelf is written by an explicit
// save), so a keep has nothing to persist: it validates, then publishes once.
test('failed take validation leaves the take retryable', () => {
  const library = new Set(['ldj.FadeCycle']);
  const s = new Sequencer({
    resolve: (id) => (library.has(id) ? presetById(id).spec : null),
    fixtureIds: () => [1, 2, 3],
    pad: () => ({ presetId: 'ldj.FadeCycle', targets: 'shared', lengthBeats: 2 }),
  });
  s.load(SET);
  const before = s.current(), revision = s.revision();
  s.startRecording({ mode: 'replace', countInBeats: 0, quantise: 1 });
  s.onPadHit({ bank: 0, slot: 1, startBeat: 1 });
  // The pad's preset goes from the library between the hit and the keep.
  library.delete('ldj.FadeCycle');
  assert.throws(() => s.stopRecording(true), (e) => e.status === 400);
  assert.equal(s.revision(), revision);
  assert.deepEqual(s.current(), before, 'the clip replace would remove is still there');
  assert.equal(s.status().recording.hits, 1, 'the take survives the refusal');

  library.add('ldj.FadeCycle');
  const kept = s.stopRecording(true);
  assert.deepEqual(kept.removed, ['A']);
  assert.deepEqual(rounded(kept.added), [['a', 1, 2, 'lane']]);
  assert.equal(s.revision(), revision + 1);

  // Refused again, the same take can still be discarded.
  const after = s.current();
  s.startRecording({ mode: 'overdub', countInBeats: 0, quantise: 1 });
  s.onPadHit({ bank: 0, slot: 1, startBeat: 6 });
  library.clear();
  assert.throws(() => s.stopRecording(true), (e) => e.status === 400);
  assert.deepEqual(s.stopRecording(false), { added: [], removed: [] });
  assert.deepEqual(s.current(), after);
  assert.equal(s.revision(), revision + 1);
});

test('replace takes report whole clips extending beyond the range', () => {
  const clip = (id, startBeat, lengthBeats) => ({ id, laneId: 'a', startBeat, lengthBeats, effect: GLOW, targets: 'lane', mute: false });
  const s = rig({ pad: () => ({ presetId: 'ldj.FadeCycle', targets: 'shared', lengthBeats: 2 }) });
  s.load({ ...SET, clips: [clip('X', 0, 4), clip('Y', 4.5, 1), clip('Z', 7, 5), { ...clip('T', 0, 16), laneId: 't2' }] });
  // Count-in of two: the take runs from beat 2.
  s.startRecording({ mode: 'replace', countInBeats: 2, quantise: 1 });
  for (const beat of [2, 4, 6]) s.onPadHit({ bank: 0, slot: 1, startBeat: beat });
  const kept = s.stopRecording(true);
  assert.deepEqual([...kept.removed].sort(), ['X', 'Y', 'Z']);
  assert.deepEqual(kept.range, { fromBeat: 2, toBeat: 8 });
  // Whole clips go: X loses two beats before the take, Z four after it; Y lay inside.
  assert.deepEqual(kept.beyondRange, [
    { id: 'X', laneId: 'a', startBeat: 0, lengthBeats: 4, beforeBeats: 2, afterBeats: 0 },
    { id: 'Z', laneId: 'a', startBeat: 7, lengthBeats: 5, beforeBeats: 0, afterBeats: 4 },
  ]);
  assert.ok(s.current().clips.some((c) => c.id === 'T'), 'another lane keeps its clip');

  // Overdub removes nothing, so nothing reaches beyond.
  s.startRecording({ mode: 'overdub', countInBeats: 0, quantise: 1 });
  s.onPadHit({ bank: 0, slot: 1, startBeat: 20 });
  const over = s.stopRecording(true);
  assert.deepEqual([over.removed, over.beyondRange, over.range], [[], [], { fromBeat: 0, toBeat: 22 }]);
});

// A pattern the resolver hands over as stored, with no schema in the way.
const TWO = { id: 'two', name: 'Two', lengthBeats: 8, lanes: [{ kind: 'shared', slot: 0, clips: [
  { startBeat: 0, lengthBeats: 2, effect: GLOW, targets: 'lane', mute: false },
  { startBeat: 6, lengthBeats: 2, effect: GLOW, targets: 'lane', mute: false }] }] };
const TINY = { id: 'tiny', name: 'Tiny', lengthBeats: 1e-6, lanes: [{ kind: 'shared', slot: 0, clips: [{ startBeat: 0, lengthBeats: 1, effect: GLOW, targets: 'lane', mute: false }] }] };
const LOOP = { on: true, startBeat: 0, endBeat: 16 };

function clockRig({ pattern = TWO, pad = () => ({ patternId: pattern.id, targets: 'shared' }), fixtures = [1] } = {}) {
  const c = { beat: 100, seq: 0, loop: null };
  const s = new Sequencer({ resolve, fixtureIds: () => fixtures, pattern: (id) => (id === pattern.id ? pattern : null), pad, beat: () => c.beat });
  s.load({ id: 'set', name: 'Set', lanes: [shared('a')], clips: [] });
  const real = s.status.bind(s);
  s.status = () => ({ ...real(), beat: c.seq, loop: c.loop });
  return { s, c };
}

test('a pattern length is at least its clips and a sixteenth note', () => {
  assert.throws(() => validatePattern(TINY), { status: 400 });
  assert.throws(() => validatePattern({ ...TWO, lengthBeats: 7 }), { status: 400 }, 'shorter than its last clip');
  assert.equal(validatePattern(TWO).lengthBeats, 8);
});

test('oversized takes are rejected atomically', () => {
  const { s } = clockRig({ pattern: TINY });
  s.startRecording({ mode: 'overdub', quantise: 0 });
  s.onPadHit({ bank: 0, slot: 0, startBeat: 0 });
  s.onPadHit({ bank: 0, slot: 0, startBeat: 0, endBeat: 2 });
  const revision = s.revision();
  assert.throws(() => s.stopRecording(true), { status: 409 });
  assert.equal(s.revision(), revision, 'nothing loaded');
  assert.equal(s.current().clips.length, 0);
  assert.equal(s.recording().hits, 1, 'the take stays for a discard');
  s.stopRecording(false);
  // Three held hits of 1024 laps, two clips each: the clip cap, not the copy cap.
  const many = clockRig().s;
  many.startRecording({ mode: 'overdub', quantise: 1 });
  for (const at of [0, 10000, 20000]) many.onPadHit({ bank: 0, slot: 0, startBeat: at, endBeat: at + 8 * 1024 });
  assert.throws(() => many.stopRecording(true), { status: 409 });
  assert.equal(many.current().clips.length, 0);
  assert.equal(many.recording().hits, 3);
  many.stopRecording(false);
  // The take itself is bounded: past the cap a hit is not staged and the status says so.
  const one = clockRig({ pad: () => ({ presetId: 'ldj.FadeCycle', targets: 'shared', lengthBeats: 1 }) }).s;
  one.startRecording({ mode: 'overdub', quantise: 0 });
  for (let i = 0; i < 4097; i++) one.onPadHit({ bank: 0, slot: 0, startBeat: i, lengthBeats: 1 });
  assert.deepEqual([one.recording().hits, one.recording().full], [4096, true]);
  assert.equal(one.stopRecording(true).added.length, 4096);
});

test('count-in follows conductor time across loops', () => {
  const { s, c } = clockRig({ pad: () => ({ presetId: 'ldj.FadeCycle', targets: 'shared', lengthBeats: 1 }) });
  c.loop = LOOP;
  c.seq = 8;
  s.startRecording({ mode: 'overdub', countInBeats: 0, quantise: 1 });
  const lap2 = s.onPadHit({ bank: 0, slot: 0, startBeat: sequenceBeatAhead(8, 10, LOOP), clockBeat: 110 });
  assert.equal(lap2?.start, 2, 'beat 2 of the next lap');
  s.stopRecording(false);
  c.seq = 14;
  c.beat = 200;
  assert.equal(s.startRecording({ mode: 'overdub', countInBeats: 4, quantise: 1 }).fromBeat, 2, 'shown wrapped');
  assert.equal(s.onPadHit({ bank: 0, slot: 0, startBeat: sequenceBeatAhead(14, 2, LOOP), clockBeat: 202 }), null, 'in the count-in');
  assert.equal(s.onPadHit({ bank: 0, slot: 0, startBeat: sequenceBeatAhead(14, 6, LOOP), clockBeat: 206 })?.start, 4);
  assert.equal(s.stopRecording(true).added.length, 1);
});

test('a pattern hit records what was played: cut at the release, a once is one copy', () => {
  const { s } = clockRig();
  const kept = (hits) => {
    s.startRecording({ mode: 'overdub', quantise: 1 });
    for (const h of hits) s.onPadHit({ bank: 0, slot: 0, ...h });
    return rounded(s.stopRecording(true).added).map(([, start, length]) => [start, length]);
  };
  assert.deepEqual(kept([{ startBeat: 0 }, { startBeat: 0, endBeat: 2 }]), [[0, 2]], 'a clip after the release is dropped');
  assert.deepEqual(kept([{ startBeat: 20 }, { startBeat: 20, endBeat: 27 }]), [[20, 2], [26, 1]], 'a crossing clip is trimmed');
  assert.deepEqual(kept([{ startBeat: 40, endBeat: 49 }]), [[40, 2], [46, 2], [48, 1]], 'a held length repeats, the last lap cut');
  assert.deepEqual(kept([{ startBeat: 60, lengthBeats: 20, once: true }]), [[60, 2], [66, 2]], 'a once never laps');
  assert.deepEqual(kept([{ startBeat: 80, lengthBeats: 5, once: true }]), [[80, 2]], 'a once is cut at its length');
});

test('held lengths use the conductor clock across count-in', () => {
  const { s, c } = clockRig({ pad: () => ({ presetId: 'ldj.FadeCycle', targets: 'shared', lengthBeats: 1 }) });
  c.loop = LOOP;
  c.seq = 14;
  s.startRecording({ mode: 'overdub', countInBeats: 0, quantise: 1 });
  assert.equal(s.onPadHit({ bank: 0, slot: 0, startBeat: 14, clockBeat: 100 }).open, true);
  // Released 4 beats later, past the wrap: its start maps below fromBeat.
  const closed = s.onPadHit({ bank: 0, slot: 0, startBeat: sequenceBeatAhead(2, -4, LOOP), clockBeat: 100, heldBeats: 4 });
  assert.equal(closed?.open, false);
  assert.equal(closed.length, 4);
  assert.deepEqual(rounded(s.stopRecording(true).added).map(([, start, length]) => [start, length]), [[14, 4]]);
});

test('pattern pads during count-in cannot edit the loaded sequence', () => {
  const { s, c } = clockRig({ pattern: PATTERN, pad: () => ({ presetId: 'ldj.FadeCycle', targets: 'shared', lengthBeats: 1 }), fixtures: [1, 2] });
  c.beat = 0;
  s.startRecording({ mode: 'overdub', countInBeats: 4, quantise: 1 });
  const revision = s.revision();
  assert.deepEqual(s.dropPattern('drop', 2, 2), []);
  assert.deepEqual(s.dropPattern('drop', 2), [], 'no conductor beat: the sequence line decides');
  assert.equal(s.revision(), revision);
  s.onPadHit({ bank: 0, slot: 0, startBeat: 5, clockBeat: 5 });
  assert.equal(s.stopRecording(true).added.length, 1);
});

test('voice expiry closes the recorded hold', (t) => {
  const { c, pads, store, heard } = padRig(t);
  store.set(0, 0, { label: 'Hold', accent: '#A855F7', content: { kind: 'preset', id: 'ldj.FadeCycle' }, launch: 'hold', quantise: 1, targets: 'shared' });
  c.beat = 5;
  for (const token of ['a', 'b', 'c']) {
    assert.ok(pads.press(0, 0, 'tablet', token));
    c.beat += 2;
    pads.stopAll();
    pads.sweep();
  }
  assert.equal(pads._holds.size, 0);
  assert.deepEqual(heard.filter((h) => h.endBeat !== undefined).map((h) => h.endBeat - h.startBeat), [2, 2, 2]);
  assert.equal(pads.release(0, 0, 'tablet', 'c'), false, 'nothing left to release');
  assert.equal(heard.length, 6);
  // A loop ended by stop-all closes the same way.
  store.set(0, 1, { label: 'Loop', accent: '#A855F7', content: { kind: 'preset', id: 'ldj.FadeCycle' }, launch: 'loop', quantise: 1, targets: 'shared' });
  assert.ok(pads.press(0, 1, 'tablet', 'l'));
  c.beat += 3;
  pads.sweep();
  assert.equal(heard.length, 7, 'a running loop stays open');
  pads.stopAll();
  pads.sweep();
  assert.equal(pads._latched.size, 0);
  assert.deepEqual(heard.slice(6).map((h) => [h.slot, h.endBeat === undefined ? null : h.endBeat - h.startBeat]), [[1, null], [1, 3]]);
});
