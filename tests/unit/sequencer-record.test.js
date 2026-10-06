// Punch recording against the record-transaction and voice-duration rulings:
// staged pattern hits, loop and strobe pads, keep conflicts, loop wraps.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Sequencer, sequenceBeatAhead, padTakeOf } from '../../src/server/sequencer.ts';
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

test('a keep is refused when the loaded sequence was edited during the take; the take and the edit both stay', () => {
  const s = rig({ pad: () => ({ presetId: 'ldj.FadeCycle', targets: 'shared', lengthBeats: 2 }) });
  s.startRecording({ mode: 'overdub', countInBeats: 0, quantise: 1 });
  s.onPadHit({ bank: 0, slot: 1, startBeat: 1 });
  s.load({ ...SET, name: 'Edited' });
  const revision = s.revision();
  assert.throws(() => s.stopRecording(true), (e) => e.status === 409 && /edited|changed/i.test(e.message));
  assert.equal(s.revision(), revision);
  assert.equal(s.current().name, 'Edited');
  assert.equal(s.status().recording.hits, 1, 'the take is kept for a discard');
  assert.deepEqual(s.stopRecording(false), { added: [], removed: [] });
});

test('pattern and sequencePattern hits are staged on the take and expand as one batch at keep', () => {
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

test('a held pattern pad repeats its bundle up to the release; a pad with fixtures maps its ordinals and skips missing slots', () => {
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
  const pads = new Pads({ voices, store, lookup: () => builtinPresets, fixtureIds: () => [0, 1], beat: () => c.beat, strobe, patternVoice });
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

test('a staged pattern hit keeps the pattern as launched: a later delete leaves the take as played', () => {
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
test('a keep that fails validation leaves the loaded sequence and the take; a retry keeps or discards it', () => {
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
  assert.throws(() => s.stopRecording(true), (e) => e.status === 400 && /no effect ldj\.FadeCycle/.test(e.message));
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

test('a replace keep names the removed clips that reach outside the recorded range, and by how far', () => {
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
