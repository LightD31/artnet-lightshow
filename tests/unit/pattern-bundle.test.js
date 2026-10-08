// A pattern resolved for a pad voice (the bundle the pattern pad plays):
// voice mapping of shared and track slots, explicit targets, acknowledgement.

import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveBundle } from '../../src/server/sequencer.ts';
import { presetById } from '../../src/shared/effects/index.ts';

const FADE = presetById('ldj.FadeCycle').spec;
const GLOW = { kind: 'energy.glow', params: {} };
const resolve = (id) => (id === 'ldj.FadeCycle' ? FADE : null);
const at = (startBeat, lengthBeats, extra) => ({ startBeat, lengthBeats, effect: GLOW, targets: 'lane', mute: false, ...extra });
const PATTERN = {
  id: 'drop', name: 'Drop', lengthBeats: 8,
  lanes: [
    { kind: 'shared', slot: 1, clips: [{ startBeat: 0, lengthBeats: 4, presetId: 'ldj.FadeCycle', targets: 'lane', mute: false }, at(4, 4, { targets: [1, 2] })] },
    { kind: 'track', slot: 1, clips: [at(2, 2)] },
  ],
};
const shape = (b) => b.table.clips.map((c) => [c.laneId, c.startBeat, c.fixtureIds, c.spec.kind]);

test('bundle lanes map shared and ordinal fixture targets', () => {
  const b = resolveBundle(PATTERN, 'shared', [1, 2, 3], resolve);
  assert.equal(b.lengthBeats, 8);
  assert.deepEqual(b.table.lanes.map((l) => [l.id, l.kind, l.fixtureId]), [['shared:1', 'shared', undefined], ['track:1', 'track', 2]]);
  assert.deepEqual(shape(b), [['shared:1', 0, null, 'ldj.FadeCycle'], ['shared:1', 4, [1, 2], 'energy.glow'], ['track:1', 2, [2], 'energy.glow']]);
  assert.ok(Object.isFrozen(b.table.clips[0]) && Object.isFrozen(b.table), 'immutable once resolved');
  assert.equal(b.rapid, false);
});

test('pad bundles intersect targets and omit missing track slots', () => {
  assert.deepEqual(shape(resolveBundle(PATTERN, [3, 1], [1, 2, 3], resolve)),
    [['shared:1', 0, [1, 3], 'ldj.FadeCycle'], ['shared:1', 4, [1], 'energy.glow'], ['track:1', 2, [3], 'energy.glow']]);
  const lone = resolveBundle(PATTERN, [3], [1, 2, 3], resolve);
  assert.deepEqual(lone.table.lanes.map((l) => l.id), ['shared:1'], 'track slot 1 has no fixture: skipped, not refused');
  assert.deepEqual(shape(lone), [['shared:1', 0, [3], 'ldj.FadeCycle']], 'a clip whose fixtures all fall outside is dropped');
});

test("nested rapid clips mark the resolved bundle rapid", () => {
  const strobe = { kind: 'energy.whiteStrobe', params: {} };
  const nested = { kind: 'macro', params: { steps: [{ effect: strobe, beats: 4 }], loopBeats: 4 } };
  const rapid = { ...PATTERN, lanes: [{ kind: 'shared', slot: 0, clips: [at(0, 4, { effect: nested })] }] };
  assert.equal(resolveBundle(rapid, 'shared', [1], resolve).rapid, true);
});

test("missing bundle presets are refused", () => {
  const missing = { ...PATTERN, lanes: [{ kind: 'shared', slot: 0, clips: [{ startBeat: 0, lengthBeats: 4, presetId: 'gone', targets: 'lane', mute: false }] }] };
  assert.throws(() => resolveBundle(missing, 'shared', [1], resolve), (e) => e.status === 409);
});

test("bundle resolution refuses strobe clips", async () => {
  const strobe = { kind: 'strobe', params: { clock: 'beat', flashesPerSecond: 5 } };
  const holding = { ...PATTERN, lanes: [{ kind: 'shared', slot: 0, clips: [at(0, 4, { effect: strobe })] }] };
  assert.throws(() => resolveBundle(holding, 'shared', [1], resolve), (e) => e.status === 409);
});

test("sequence validation refuses strobe clips", async () => {
  const { validateSequence } = await import('../../src/server/sequencer.ts');
  const strobe = { kind: 'strobe', params: { clock: 'beat', flashesPerSecond: 5 } };
  assert.throws(() => validateSequence({ id: 's', name: 's', lanes: [{ id: 'l', kind: 'shared', name: 'l', mute: false, solo: false }],
    clips: [{ id: 'c', laneId: 'l', startBeat: 0, lengthBeats: 4, effect: strobe, targets: 'lane', mute: false }] }));
});

test("resolved bundles validate as voices", async () => {
  const { bundleSpec } = await import('../../src/shared/effects/bundle.ts');
  const { voiceSpec } = await import('../../src/server/voices.ts');
  const spec = voiceSpec(bundleSpec(resolveBundle(PATTERN, 'shared', [1, 2, 3], resolve), true));
  assert.deepEqual([spec.kind, spec.params.lengthBeats, spec.params.once, spec.params.table.clips.length], ['pattern.bundle', 8, true, 3]);
});
