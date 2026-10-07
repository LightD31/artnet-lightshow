import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { createRenderer } from '../../src/server/renderer.ts';
import { FRAME_MS } from '../../src/server/frame-clock.ts';
import { allocateShared, createUniverseStore } from '../../src/server/universes.ts';
import { createPreviewSampler } from '../../src/shared/preview.ts';
import { buildRig } from '../../src/shared/rig.ts';
import { registerKind, validateSpec } from '../../src/shared/effects/registry.ts';
import { seedFrom } from '../../src/shared/effects/hash.ts';

const WHITE = { r: 255, g: 255, b: 255 }, BLACK = { r: 0, g: 0, b: 0 };
const PROFILE = { id: 'transition', name: 'Transition', channelCount: 4,
  channelMap: { red: 0, green: 1, blue: 2, dimmer: 3 } };
const FIXTURE = { id: 10, profileId: PROFILE.id, address: 1, universe: 0, maxBrightness: 255, override: null,
  hardware: { maxFlashHz: 20, minTransitionMs: 200 } };
const HARDWARE = { technologies: {}, products: {} };
registerKind({ kind: 'test.transition', app: 'own', schema: z.object({ cadence: z.number(), cutAt: z.number() }),
  defaults: { params: { cadence: 4, cutAt: 250 } }, init: () => null,
  render(params, _state, room, frame, out) {
    for (let k = 0; k < room.n; k++) out[k] = { colour: frame.nowMs < params.cutAt ? WHITE : BLACK, level: 1, strength: 1 };
  } });
const EFFECT = validateSpec({ kind: 'test.transition' });
const base = { running: true, pattern: 'transition', effect: EFFECT, colorA: 0, colorB: 0, colorC: 0, colorD: 0,
  split: null, pixelMap: 'stage', beatDivision: 1, strobeSpeed: 0, strobeFunction: 'standard',
  masterDimmer: 255, masterBlackout: false, energy: null, showDynamics: null, patternAnchor: null,
  fade: null, syncTest: null, universes: [0], fixtures: [FIXTURE], hardware: HARDWARE,
  safety: { acknowledged: true, hdFlashIntervalMs: 350 } };
function playback(profile = PROFILE) {
  const renderer = createRenderer({ profileOf: () => profile, profilesRevision: () => 0, now: 0 });
  const store = createUniverseStore(allocateShared());
  return (t, patch = {}) => {
    renderer.frame({ ...base, ...patch }, { beatPos: t / 500, bpm: 120, epoch: 0 }, t, store, 0);
    return [...store.getBuffer(0).subarray(0, profile.channelCount)];
  };
}

test('renderer and preview match RGB channel values during falling transitions', () => {
  const at = playback(), fixtures = [FIXTURE], rig = buildRig(fixtures, () => PROFILE);
  const sample = createPreviewSampler([{ timeMs: 0, action: 'patch', data: { pattern: 'transition', bpm: 120 } }], null,
    { resolveEffect: () => EFFECT, hardware: HARDWARE, profiles: { [PROFILE.id]: PROFILE } });
  const seen = [];
  for (let k = 0; k <= 25; k++) {
    const t = k * FRAME_MS, output = at(t), preview = sample(t, fixtures, [WHITE], rig)[0];
    assert.equal(output[0], preview.r);
    seen.push(output[0]);
  }
  assert.ok(seen[12] > 0 && seen[12] < seen[10]);
  assert.equal(seen[25], 0);
});

for (const mode of ['master', 'fixture', 'kill']) {
  test(`${mode} blackout cuts a retained transition immediately`, () => {
    const at = playback();
    for (let k = 0; k <= 10; k++) at(k * FRAME_MS);
    const patch = mode === 'master' ? { masterBlackout: true } : mode === 'fixture'
      ? { fixtures: [{ ...FIXTURE, override: { enabled: false, blackout: true } }] }
      : { voices: [{ id: 'kill', spec: validateSpec({ kind: 'energy.kill' }), seed: seedFrom('kill'), anchorBeat: 0,
        startedAtMs: 0, untilMs: null, targets: null, tier: 'voice', launchSeq: 1 }] };
    assert.equal(at(11 * FRAME_MS, patch)[3], 0);
  });
}

test('an excluded voice reveals black below without reviving its old colour', () => {
  const at = playback();
  const voice = { id: 'top', spec: validateSpec({ kind: 'test.transition', params: { cadence: .125, cutAt: 10000 } }),
    seed: seedFrom('top'), anchorBeat: 0, startedAtMs: 0, untilMs: null, targets: null, tier: 'voice', launchSeq: 1 };
  const patch = { pattern: 'solid', effect: null, paletteOverride: [BLACK], voices: [voice] };
  for (let k = 0; k <= 10; k++) at(k * FRAME_MS, patch);
  assert.equal(at(11 * FRAME_MS, { ...patch, voices: [{ ...voice, spec: { ...voice.spec, admission: 'exclude' } }] })[3], 0);
});

test('preview shows native hardware strobe pulses at the capped frequency', () => {
  const profile = { ...PROFILE, channelCount: 5, channelMap: { ...PROFILE.channelMap, strobe: 4 }, strobeHz: { min: 2, max: 16 } };
  const fixture = { ...FIXTURE, hardware: { maxFlashHz: 3, minTransitionMs: 0 } }, fixtures = [fixture];
  const rig = buildRig(fixtures, () => profile);
  const sample = createPreviewSampler([
    { timeMs: 0, action: 'patch', data: { pattern: 'solid', bpm: 120, colorA: 0 } },
    { timeMs: 0, action: 'energy', data: { id: 'white-strobe', durationMs: 2000 } },
  ], null, { hardware: HARDWARE, profiles: { [PROFILE.id]: profile }, safety: { acknowledged: true } });
  assert.deepEqual([0, 200, 400].map((t) => sample(t, fixtures, [WHITE], rig)[0].r), [255, 0, 255]);
});

test('the three Hz limit preserves slower imported hardware strobe ranges', () => {
  const profile = { ...PROFILE, channelCount: 5, channelMap: { ...PROFILE.channelMap, strobe: 4 }, strobeHz: { min: 0, max: 3 } };
  const at = playback(profile);
  const output = at(0, { pattern: 'strobe', effect: null, strobeSpeed: 255, flashLimit: true,
    fixtures: [{ ...FIXTURE, hardware: { maxFlashHz: 20, minTransitionMs: 0 } }] });
  assert.equal(output[4], 250);
});
