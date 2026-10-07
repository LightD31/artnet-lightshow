import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PaletteStore } from '../../src/server/palette-store.ts';
import { EffectLibrary } from '../../src/server/effect-library.ts';
import { ALL_PALETTES } from '../../src/server/palette-catalogue.ts';
import { applyPatch, setHooks } from '../../src/server/patch.ts';
import { state, getLiveState } from '../../src/server/state.ts';
import { captureLook, recallLook, CueStore } from '../../src/server/cues.ts';
import { renderInput, stopEngine } from '../../src/server/engine.ts';
import { Sequencer } from '../../src/server/sequencer.ts';
import { parseHex } from '../../src/shared/palette-model.ts';

const BODY = { colours: ['#102030405060', '#0000000000FF'], gradients: [
  { name: 'night', space: 'rgb', wrap: false, stops: [{ at: 0, slot: 0 }, { at: 1, slot: 1 }] },
], sets: [{ name: 'show', roles: ['night'] }], gradientSet: 'show', gradientRole: 0 };
test.after(() => stopEngine());

function store(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'palette-integration-'));
  const file = path.join(dir, 'palettes.json');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { file, dir, store: new PaletteStore(file, { seed: () => [1, 2, 3, 4] }).load() };
}

test('legacy palette files migrate without losing random or white slots', (t) => {
  const { file } = store(t);
  fs.writeFileSync(file, JSON.stringify({ palettes: [{ id: 'old', name: 'Old', colours: ['#abc', '#12345678', 'random'] }] }));
  const loaded = new PaletteStore(file).load();
  assert.deepEqual(loaded.get('old').palette.colours, ['#AABBCC', '#12345678', { random: true }]);
  loaded.update('old', { ...BODY, name: 'Expanded' });
  assert.deepEqual(new PaletteStore(file).load().get('old').palette, { id: 'old', name: 'Expanded', ...BODY });
});

test('all old stage and effect palette ids share one collision-free catalogue', (t) => {
  const { store: library } = store(t);
  assert.equal(ALL_PALETTES.length, new Set(ALL_PALETTES.map((p) => p.id)).size);
  for (const p of ALL_PALETTES) assert.ok(library.get(p.id), p.id);
  assert.ok(library.materializeBody('noirUv').colours.some((hex) => parseHex(hex).uv > 0));
});

test('a palette update cannot leave dangling gradient slots', (t) => {
  const { store: library, file } = store(t);
  const p = library.create({ name: 'Night', ...BODY });
  const before = fs.readFileSync(file, 'utf8');
  assert.throws(() => library.update(p.id, { colours: ['#FFFFFF'] }), (e) => e.status === 400);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.deepEqual(library.materializeBody(p.id), BODY);
});

test('saved effect palettes migrate and retain authored gradient bodies', (t) => {
  const { dir } = store(t);
  const file = path.join(dir, 'effects.json');
  const library = new EffectLibrary(file).load();
  const old = library.create({ name: 'Old', spec: { kind: 'hd.spatialWash', palette: ['#FF0000', { random: true }] } });
  const authored = library.create({ name: 'Authored', spec: { kind: 'hd.spatialWash', palette: BODY } });
  const loaded = new EffectLibrary(file).load();
  assert.deepEqual(loaded.get(old.id).preset.spec, old.spec);
  assert.deepEqual(loaded.get(authored.id).preset.spec, authored.spec);
  assert.deepEqual(authored.spec.palette, BODY.colours);
  assert.deepEqual(authored.spec.gradients, BODY.gradients);
  assert.deepEqual(authored.spec.sets, BODY.sets);
});

test('base and override patches retain full channels and reject unknown ids atomically', (t) => {
  const before = captureLook();
  t.after(() => recallLook(before));
  applyPatch({ basePalette: BODY, overridePalette: BODY });
  assert.deepEqual(renderInput().basePalette, BODY);
  assert.deepEqual(renderInput().paletteOverride, BODY.colours.map(parseHex));
  assert.deepEqual(getLiveState().overridePalette, BODY);
  const snapshot = captureLook();
  assert.throws(() => applyPatch({ palette: 'no-such-palette', colorA: 4, masterDimmer: 0 }), /known palette/);
  assert.deepEqual(captureLook(), snapshot);
  applyPatch({ colorA: 5 });
  assert.equal(state.basePalette.colours[1], BODY.colours[1]);
  assert.deepEqual(state.basePalette.gradients, BODY.gradients);
});

test('cue recall restores authored palettes after their library entry is deleted', (t) => {
  const { store: library, dir } = store(t);
  const before = captureLook();
  t.after(() => recallLook(before));
  const palette = library.create({ name: 'Night', ...BODY });
  applyPatch({ basePalette: library.materializeBody(palette.id), overridePalette: BODY });
  const file = path.join(dir, 'cues.json');
  const cue = new CueStore(file).load().create({ name: 'Night cue' });
  library.remove(palette.id);
  applyPatch({ basePalette: null, paletteOverride: null });
  new CueStore(file).load().recall(cue.id);
  assert.deepEqual(state.basePalette, BODY);
  assert.deepEqual(state.overridePalette, BODY);
});

test('sequence stop restores the exact gradient snapshot beneath its palette', (t) => {
  const before = captureLook();
  t.after(() => recallLook(before));
  applyPatch({ overridePalette: BODY });
  const live = () => ({ masterDimmer: state.masterDimmer, bpm: state.bpm, paletteOverride: getLiveState().paletteOverride,
    paletteOverrideId: state.paletteOverrideId, overridePalette: state.overridePalette });
  const sequence = new Sequencer({ resolve: () => null, current: live, palette: () => ['#FF0000', '#0000FF'],
    paletteSettings: () => ({ gradients: BODY.gradients }),
    apply: ({ paletteOverrideId, ...patch }) => applyPatch(patch, { origin: 'sequence', paletteOverrideId }) });
  sequence.load({ id: 'test', name: 'Test', lanes: [], clips: [], options: { initialPalette: 'night' } });
  sequence.play();
  assert.equal(state.paletteOverrideId, 'night');
  assert.deepEqual(state.overridePalette.gradients, BODY.gradients);
  sequence.stop();
  assert.deepEqual(state.overridePalette, BODY);
  assert.deepEqual(getLiveState().paletteOverride, BODY.colours);
});

test('a named user palette works as a base without changing its saved random slots', (t) => {
  const { store: library } = store(t);
  const before = captureLook();
  const palette = library.create({ name: 'Random gradient', ...BODY, colours: [{ random: true }, BODY.colours[1]] });
  setHooks({ palette: (id) => library.materializeBody(id) });
  t.after(() => { recallLook(before); setHooks({ palette: () => null }); });
  applyPatch({ palette: palette.id });
  assert.equal(state.palette, palette.id);
  assert.equal(typeof state.basePalette.colours[0], 'string');
  assert.deepEqual(state.basePalette.gradients, BODY.gradients);
  assert.deepEqual(library.get(palette.id).palette.colours[0], { random: true });
  applyPatch({ colorA: state.colorA });
  assert.equal(state.palette, null, 'writing a legacy slot changes the custom colour even if its stale index matches');
});
