// The bookkeeping the renderer and the rehearsal preview share for the
// effects they play: what makes a voice's launch new, where a voice plays
// from after the music jumps, what a relaunched base keeps, and the effect an
// energy burst plays as. One copy, so the two hosts cannot drift.

import test from 'node:test';
import assert from 'node:assert';

import { energyEffectSpec, presetById } from '../../src/shared/effects/catalogue.ts';
import { ENERGY_KIND_BY_ID } from '../../src/shared/effects/energy.ts';
import { relaunchEffect, voiceAnchor, voiceLaunchKey } from '../../src/shared/effects/layer.ts';
import { validateSpec } from '../../src/shared/effects/registry.ts';
import { EffectStepper } from '../../src/shared/effects/stepper.ts';
import { seedFrom } from '../../src/shared/effects/hash.ts';
import { HOLD_STROBE } from '../../src/shared/look-math.ts';

const voice = (id, spec, extra = {}) => ({
  id, spec, targets: null, tier: 'voice', launchSeq: 1, startedAtMs: 100, untilMs: null, anchorBeat: 4, seed: seedFrom(id), ...extra,
});
const BLINDER = validateSpec({ kind: 'energy.blinder' });
const GLOW = validateSpec({ kind: 'energy.glow' });
const STROBE = validateSpec({ kind: 'strobe' });

test('a launch is new with its sequence, start, seed or content, not its colours; a strobe launch never is', () => {
  const key = voiceLaunchKey(voice('a', BLINDER));
  assert.strictEqual(voiceLaunchKey(voice('b', BLINDER, { seed: seedFrom('a') })), key, 'the id is not part of it');
  assert.strictEqual(voiceLaunchKey(voice('a', { ...BLINDER, palette: ['#FF0000'], brightness: 0.5 })), key, 'colours and brightness play on');
  for (const change of [{ launchSeq: 2 }, { startedAtMs: 101 }, { seed: seedFrom('other') }]) {
    assert.notStrictEqual(voiceLaunchKey(voice('a', BLINDER, change)), key, JSON.stringify(change));
  }
  assert.notStrictEqual(voiceLaunchKey(voice('a', GLOW)), key, 'another kind is another launch');
  assert.strictEqual(voiceLaunchKey(voice('s', STROBE, { launchSeq: 7 })), 'strobe');
  assert.strictEqual(voiceLaunchKey(voice('s', STROBE, { launchSeq: 8, startedAtMs: 9 })), 'strobe', 'a strobe relaunch keeps its permit');
});

test('a voice keeps its anchor and state until a new launch, takes a new wire anchor, and re-anchors on a new epoch unless it holds the grid', () => {
  const records = new Map();
  const stepper = new EffectStepper();
  const v = voice('pad', BLINDER);
  const state = (id) => stepper.get(id, () => ({ fresh: true }), 0);
  assert.strictEqual(voiceAnchor(records, stepper, v, voiceLaunchKey(v), 0, 4.6, false), 4, 'the wire anchor at launch');
  state('pad').fresh = false;
  assert.strictEqual(voiceAnchor(records, stepper, v, voiceLaunchKey(v), 0, 5.6, false), 4, 'the same frame again changes nothing');
  assert.strictEqual(state('pad').fresh, false, 'the state is kept');
  // The music jumps: the anchor moves to the start of the beat it is in, the state stays.
  assert.strictEqual(voiceAnchor(records, stepper, v, voiceLaunchKey(v), 1, 40.3, false), 40);
  assert.strictEqual(state('pad').fresh, false);
  assert.strictEqual(voiceAnchor(records, stepper, v, voiceLaunchKey(v), 1, 41.3, false), 40, 'one jump, one re-anchor');
  // A voice that holds the global grid (the hold strobe) ignores the jump.
  assert.strictEqual(voiceAnchor(records, stepper, v, voiceLaunchKey(v), 2, 80.3, true), 40);
  // A new wire anchor under the same launch takes over.
  const moved = { ...v, anchorBeat: 12 };
  assert.strictEqual(voiceAnchor(records, stepper, moved, voiceLaunchKey(moved), 2, 80.3, false), 12);
  // A new launch under the id starts the state again.
  const again = { ...v, launchSeq: 2, anchorBeat: 50 };
  assert.strictEqual(voiceAnchor(records, stepper, again, voiceLaunchKey(again), 2, 80.3, false), 50);
  assert.strictEqual(state('pad').fresh, true, 'a new launch forgets the state');
  // A strobe relaunched under its id keeps its state (its permit); another kind under that id does not.
  const s = voice('pad', STROBE, { launchSeq: 3 });
  voiceAnchor(records, stepper, s, voiceLaunchKey(s), 2, 80.3, false);
  state('pad').fresh = false;
  const s2 = { ...s, launchSeq: 4, startedAtMs: 500 };
  voiceAnchor(records, stepper, s2, voiceLaunchKey(s2), 2, 80.3, false);
  assert.strictEqual(state('pad').fresh, false, 'the strobe keeps its permit through a relaunch');
  const other = voice('pad', GLOW, { launchSeq: 4, startedAtMs: 500 });
  voiceAnchor(records, stepper, other, voiceLaunchKey(other), 2, 80.3, false);
  assert.strictEqual(state('pad').fresh, true, 'another kind under the id starts afresh');
});

test('a relaunched base hands a strobe its state on and starts any other kind afresh', () => {
  const stepper = new EffectStepper();
  const state = (id) => stepper.get(id, () => ({ fresh: true }), 0);
  state('base:strobe:0').fresh = false;
  relaunchEffect(stepper, { id: 'base:strobe:0', kind: 'strobe' }, 'base:strobe:8', 'strobe');
  assert.strictEqual(stepper.peek('base:strobe:0'), null, 'moved away');
  assert.strictEqual(state('base:strobe:8').fresh, false, 'the permit carries on under the new id');
  state('base:fade:0').fresh = false;
  state('base:fade:8').fresh = false;
  relaunchEffect(stepper, { id: 'base:fade:0', kind: 'ldj.FadeCycle' }, 'base:fade:8', 'ldj.FadeCycle');
  assert.strictEqual(stepper.peek('base:fade:0'), null);
  assert.strictEqual(state('base:fade:8').fresh, true, 'nothing of the old id, nor of a stale state under the new one');
  state('base:x:0').fresh = false;
  relaunchEffect(stepper, { id: 'base:strobe:8', kind: 'strobe' }, 'base:x:0', 'ldj.FadeCycle');
  assert.strictEqual(state('base:x:0').fresh, true, 'a strobe look replaced by another kind starts it afresh');
  relaunchEffect(stepper, null, 'base:x:0', 'strobe');
  assert.strictEqual(state('base:x:0').fresh, true, 'the first launch has nothing to carry');
});

test('an energy burst plays as its catalogue row: the six energies and the hold strobe, nothing else', () => {
  for (const [id, kind] of Object.entries(ENERGY_KIND_BY_ID)) {
    assert.deepStrictEqual(energyEffectSpec(id), presetById(kind).spec, id);
    assert.strictEqual(energyEffectSpec(id).kind, kind);
  }
  const hold = energyEffectSpec(HOLD_STROBE);
  assert.strictEqual(hold.kind, 'strobe');
  assert.strictEqual(hold.params.flashesPerSecond, 5, 'the hold strobe at the cap');
  assert.strictEqual(hold.palette, null, 'in the look\'s colours');
  for (const id of ['strobe', 'chase', 'energy.blinder', '', 'ldj.FadeCycle']) assert.strictEqual(energyEffectSpec(id), null, id || 'empty');
});
