// What the stage preview's sampler is handed for a live state, and its "now playing" line.
import test from 'node:test';
import assert from 'node:assert';
import { previewOptions, liveVoiceEvents, matrixAsks, resolverOf, positionText } from '../../public-src/preview-inputs.js';
import { createPreviewSampler } from '../../src/shared/preview.ts';
import { buildRig } from '../../src/shared/rig.ts';
import { presetById } from '../../src/shared/effects/catalogue.ts';
import { safety } from '../../src/server/safety.ts';

const WASH = { kind: 'solid', params: {} };
const STROBE = { kind: 'strobe', params: {} };
const TABLE = { revision: 3, lanes: [{ id: 'l', kind: 'shared', slot: 0 }], clips: [] };
const STATE = {
  pattern: 'solid',
  paletteOverride: ['#ff0000', '#0000ff'],
  // The live state carries safety.status() as the server builds it.
  safety: { ...safety.status(), photosensitivityAcknowledged: true, hdFlashIntervalMs: 350 },
  voices: [
    { id: 'v1', label: 'Blinder', tier: 'voice', kind: 'solid', targets: 'shared', launchSeq: 2, hidden: false, spec: WASH },
    { id: 'v2', label: 'Strobe', tier: 'strobe', kind: 'strobe', targets: [1, 2], launchSeq: 3, hidden: false, spec: STROBE },
    { id: 'v3', label: 'Latch', tier: 'voice', kind: 'solid', targets: 'shared', launchSeq: 1, hidden: true, spec: WASH },
  ],
  strobe: { active: true },
  matrix: { mode: 'flashes', colours: ['#ff0000'] },
  sequence: { loaded: { id: 's', name: 'Intro' }, playing: true, bar: 3, beat: 9.5, loop: null },
};

test('the sampler is given the live settings: Hue strobe, override, safety, the playing sequence', () => {
  const o = previewOptions({ ...STATE, hueStrobe: 'pulse' }, { table: TABLE });
  assert.strictEqual(o.hueStrobe, 'pulse');
  assert.deepStrictEqual(o.paletteOverride, ['#ff0000', '#0000ff']);
  assert.deepStrictEqual(o.safety, { acknowledged: true, hdFlashIntervalMs: 350 });
  assert.deepStrictEqual(o.sequence, { table: TABLE, transport: { startBeat: 0, loop: null, generation: 0 } });
  assert.strictEqual(typeof o.resolveEffect, 'function');
});

test("the rig's Hue default is flash, and a stopped sequence or none is not played", () => {
  const o = previewOptions({ ...STATE, sequence: { ...STATE.sequence, playing: false } }, { table: TABLE });
  assert.strictEqual(o.hueStrobe, 'flash');
  assert.strictEqual(o.sequence, null);
  assert.strictEqual(previewOptions(STATE, { table: null }).sequence, null);
  assert.strictEqual(previewOptions({}).paletteOverride, null);
});

test('the live voices play from the start of the rehearsal, hidden ones left out', () => {
  const events = liveVoiceEvents(STATE.voices);
  assert.deepStrictEqual(events, [
    { timeMs: 0, action: 'voice', data: { id: 'live:v1', effect: WASH, targets: 'shared', tier: 'voice', launchSeq: 2 } },
    { timeMs: 0, action: 'voice', data: { id: 'live:v2', effect: STROBE, targets: [1, 2], tier: 'strobe', launchSeq: 3 } },
  ]);
  assert.deepStrictEqual(liveVoiceEvents([{ id: 'x', hidden: false }]), [], 'a voice without its effect is not guessed');
});

test('saved presets resolve before the catalogue', () => {
  const builtin = presetById('hd.auroraDrift') ? 'hd.auroraDrift' : null;
  const resolve = resolverOf([{ id: 'mine', spec: WASH }]);
  assert.deepStrictEqual(resolve('mine'), WASH);
  if (builtin) assert.deepStrictEqual(resolve(builtin), presetById(builtin).spec);
  assert.strictEqual(resolve('no-such'), null);
});

test('an unacknowledged server gives the preview acknowledged: false', () => {
  const o = previewOptions({ ...STATE, safety: { ...STATE.safety, photosensitivityAcknowledged: false } });
  assert.strictEqual(o.safety.acknowledged, false);
});

test('presets saved on this server resolve from the library GET /api/effects loads, not the live summaries', () => {
  const library = { status: 'ready', families: [], builtin: [], user: [{ id: 'mine', name: 'Mine', spec: WASH }], palettes: { builtin: [], user: [] } };
  const o = previewOptions({ ...STATE, effects: [{ id: 'mine', name: 'Mine' }] }, { library });
  assert.deepStrictEqual(o.resolveEffect('mine'), WASH);
  assert.strictEqual(previewOptions(STATE).resolveEffect('mine'), null, 'nothing loaded yet: no saved preset');
});

test('sequence position uses its bar length', () => {
  const seq = { bar: 2, beat: 5.5 };
  assert.strictEqual(positionText(seq, 3), '2.3');
  assert.strictEqual(positionText(seq, 4), '2.2');
});

test('a held pad plays over the rehearsed timeline', () => {
  const fixtures = [{ id: 1, position: { x: 50, y: 50 }, maxBrightness: 255 }];
  const rig = buildRig(fixtures, () => null);
  const presets = Array.from({ length: 12 }, (_, i) => ({ r: (i * 97) % 256, g: (i * 53) % 256, b: (i * 151) % 256 }));
  const timeline = [{ timeMs: 0, action: 'patch', data: { pattern: 'solid', bpm: 120, colorA: 1, colorB: 2, colorC: 3, colorD: 4 } }];
  const voice = { id: 'v', label: 'Aurora Drift', tier: 'voice', targets: 'shared', launchSeq: 1, hidden: false, spec: presetById('hd.auroraDrift').spec };
  const alone = createPreviewSampler(timeline)(1000, fixtures, presets, rig);
  const withPad = createPreviewSampler([...timeline, ...liveVoiceEvents([voice])], null, previewOptions({}))(1000, fixtures, presets, rig);
  assert.notDeepStrictEqual(withPad, alone);
});

test('the rapid board modes ask before the acknowledgement, the others never', () => {
  for (const m of ['fireworks', 'flashes', 'pulses']) assert.strictEqual(matrixAsks(m, false), true, m);
  assert.strictEqual(matrixAsks('flashes', true), false);
  assert.strictEqual(matrixAsks('cycle', false), false);
  assert.strictEqual(matrixAsks('solid', false), false);
});
