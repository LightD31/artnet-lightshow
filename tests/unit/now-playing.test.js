import test from 'node:test';
import assert from 'node:assert/strict';
import { effectName, padLabel, playingState } from '../../public-src/now-playing.js';
import { VIEWS, viewShortcut } from '../../public-src/views.js';
import { presetById } from '../../src/shared/effects/catalogue.ts';
import { nowPlaying } from '../../public-src/preview-inputs.js';

const sequence = { loaded: { id: 'intro', name: 'Intro' }, beat: 5.5, bar: 2, beatsPerBar: 3 };

test('status resolves the base name from saved presets first', () => {
  const s = { pattern: 'mine', effects: [{ id: 'mine', name: 'Custom' }], patterns: [{ id: 'mine', name: 'Other' }] };
  assert.deepEqual(playingState(s).base, { id: 'mine', name: s.effects[0].name, running: true });
});

for (const [flags, mode] of [[{ playing: true }, 'playing'], [{ paused: true }, 'paused'], [{ stopped: 'hold' }, 'hold'], [{ stopped: 'black' }, 'black'], [{ ended: true }, 'ended'], [{}, 'loaded']]) {
  test(`status preserves sequence ${mode}`, () => {
    assert.deepEqual(playingState({ sequence: { ...sequence, ...flags } }).sequence, { ...sequence.loaded, mode, beat: 5.5, bar: 2, beatsPerBar: 3, activeClips: [] });
  });
}

test('status exposes visible voices from every launch source', () => {
  const voices = ['api', 'midi', 'pad', 'matrix', 'strobe'].map((source, id) => ({ id: String(id), label: source, source }));
  const hidden = { id: 'hidden', label: 'hidden', hidden: true };
  assert.deepEqual(playingState({ voices: [...voices, hidden] }).voices, voices);
});

test('status reports a nonempty palette override', () => {
  assert.equal(playingState({ paletteOverride: ['#112233'] }).override, true);
  for (const paletteOverride of [null, undefined, []]) assert.equal(playingState({ paletteOverride }).override, false);
});

test('empty pad labels use the catalogue name', () => {
  const content = { kind: 'preset', id: 'hd.auroraDrift' };
  assert.equal(padLabel({ label: ' ', content }), presetById(content.id).name);
});

test('custom pad labels take precedence over catalogue names', () => {
  assert.equal(padLabel({ label: 'Mine', content: { kind: 'preset', id: 'hd.auroraDrift' } }), 'Mine');
});

test('missing catalogue entries retain their identifiers', () => {
  assert.equal(effectName('missing'), 'missing');
});

test('every view has a distinct reachable digit shortcut', () => {
  assert.equal(new Set(VIEWS.map((view) => `${!!view.shift}:${view.key}`)).size, VIEWS.length);
  for (const view of VIEWS) {
    assert.equal(viewShortcut({ key: view.shift ? ')' : view.key, code: `Digit${view.key}`, shiftKey: !!view.shift })?.id, view.id);
  }
});

test('view shortcuts respect controls that consumed the digit', () => {
  assert.equal(viewShortcut({ key: '0', defaultPrevented: true }), null);
});

test('view shortcuts leave text input alone', () => {
  assert.equal(viewShortcut({ key: '0', target: { tagName: 'INPUT' } }), null);
});


test('status retains separate pixel look names for patched panels', () => {
  const state = { pixelPattern: 'chase', panelPattern: 'rainbow', fixtures: [{ profileId: 'panel' }], profiles: { panel: { grid: { columns: 2 }, cells: [{}, {}] } } };
  assert.deepEqual(playingState(state).layers.map((layer) => layer.id), ['chase', 'rainbow']);
  assert.deepEqual(playingState({ ...state, fixtures: [] }).layers, []);
});

test('shared status names the clips covering the base look', () => {
  const activeClips = [{ id: 'c1', laneId: 'a', lane: 'Front', name: 'Custom pulse' }];
  const state = { pattern: 'solid', sequence: { ...sequence, playing: true, activeClips } };
  assert.deepEqual(playingState(state).sequence.activeClips, activeClips);
  assert.match(nowPlaying(state), /Clips: Front: Custom pulse/);
});

for (const kind of ['pattern', 'sequencePattern']) {
  test(`empty ${kind} pad labels use the saved pattern name`, () => {
    const sequencePatterns = [{ id: 'p1', name: 'Closing phrase' }];
    assert.equal(padLabel({ label: '', content: { kind, id: 'p1' } }, { sequencePatterns }), 'Closing phrase');
  });
}
