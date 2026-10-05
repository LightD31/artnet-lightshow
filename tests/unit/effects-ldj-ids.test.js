// tests/unit/effects-ldj-ids.test.js
// Light DJ's effect-type list classified, its catalogue rows and the built-in palettes.
import test from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { LDJ_IDS, CATALOGUE, BUILTIN_PALETTES, FAMILIES, LDJ_PRESETS, presetById, presetIndex } from '../../src/shared/effects/index.ts';
import { KINDS, kindOf, requiresAcknowledgement, validateSpec } from '../../src/shared/effects/registry.ts';
import { LDJ_CHANNEL_ROWS } from '../../src/shared/effects/ldj-channel.ts';
import { LDJ_ITERATION_ROWS } from '../../src/shared/effects/ldj-iteration.ts';
import { BITMAP_PATTERNS } from '../../src/shared/effects/ldj-bitmap.ts';
import { LDJ_PALETTES } from '../../src/shared/effects/ldj-palettes.ts';
import { renderEffect } from '../../src/shared/effects/render.ts';
import { EffectStepper } from '../../src/shared/effects/stepper.ts';
import { parseHex } from '../../src/shared/effects/palette.ts';
import { seedFrom } from '../../src/shared/effects/hash.ts';
import { HD_MASTER_DEFAULTS } from '../../src/shared/effects/types.ts';
import { buildRoom } from '../../src/shared/room.ts';
import { PATTERN_IDS } from '../../src/server/presets.ts';

test('every Light DJ effect type ordinal 0..171 is classified, and every preset resolves to a registered kind', () => {
  for (let id = 0; id <= 171; id++) {
    const row = LDJ_IDS[id];
    assert.ok(row, `ordinal ${id} unclassified`);
    if (row.kind === 'preset' || row.kind === 'macro') {
      const preset = presetById(row.id);
      assert.ok(preset, `${row.name} (${id}) has no preset`);
      assert.ok(kindOf(preset.spec.kind), `${row.name}: kind ${preset.spec.kind} not registered`);
      assert.doesNotThrow(() => validateSpec(preset.spec), row.name);
    }
    if (row.kind === 'outOfScope') assert.ok(row.reason, row.name);
  }
  assert.strictEqual(LDJ_IDS[36].kind, 'outOfScope');
  assert.strictEqual(LDJ_IDS[54].kind, 'macro');
  assert.strictEqual(LDJ_IDS[161].kind, 'engineCommand');
  assert.strictEqual(LDJ_IDS[143].name, 'StudioN1');
  assert.strictEqual(LDJ_IDS[163].name, 'StudioFlashes');
  assert.strictEqual(LDJ_IDS[129].name, 'ThreeStrobeAndFade');
  assert.strictEqual(LDJ_IDS[142].name, 'ThreeStageFlareMod');
});

test('the row counts match the classification', () => {
  const count = (engine) => Object.values(LDJ_IDS).filter((r) => r.kind === 'preset' && r.engine === engine).length;
  assert.strictEqual(Object.keys(LDJ_CHANNEL_ROWS).length, count('channel'));
  assert.strictEqual(Object.keys(LDJ_ITERATION_ROWS).length, count('iteration'));
  // Not only as many: the very same effects.
  const names = (engine) => Object.values(LDJ_IDS).filter((r) => r.kind === 'preset' && r.engine === engine).map((r) => r.name).sort();
  assert.deepStrictEqual(Object.keys(LDJ_CHANNEL_ROWS).sort(), names('channel'));
  assert.deepStrictEqual(Object.keys(LDJ_ITERATION_ROWS).sort(), names('iteration'));
});

test('BigRoomMix is a macro of QuickFlash and BigRoomWave over sixteen beats', () => {
  const m = presetById('ldj.BigRoomMix').spec;
  assert.strictEqual(m.kind, 'macro');
  assert.strictEqual(m.params.loopBeats, 16);
  assert.strictEqual(m.params.steps[0].effect.kind, 'ldj.QuickFlash');
});

test('26 Light DJ palettes, Random entries kept, rocketPop in, northernLights out', () => {
  const ldj = BUILTIN_PALETTES.filter((p) => p.app === 'ldj');
  assert.strictEqual(ldj.length, 26);
  assert.ok(ldj.find((p) => p.id === 'randomRandom').colours.every((c) => c.random === true));
  assert.strictEqual(ldj.find((p) => p.id === 'rainbow').colours.length, 8);
  assert.ok(ldj.find((p) => p.id === 'rocketPop'));
  assert.strictEqual(ldj.find((p) => p.id === 'northernLights'), undefined);
});

test('every Light DJ preset in the catalogue validates', () => {
  for (const p of CATALOGUE.filter((c) => c.app === 'ldj')) assert.doesNotThrow(() => validateSpec(p.spec), p.id);
});

test('the catalogue builds whichever effect module a host loads first', () => {
  // The macro kind renders its steps; loading the whole registry from inside it
  // once built the catalogue before the macro kind existed.
  for (const first of ['macro.ts', 'render.ts', 'catalogue.ts', 'ldj-ids.ts', 'ldj-channel.ts', 'registry.ts']) {
    const dir = new URL('../../src/shared/effects/', import.meta.url).href;
    const script = `await import('${dir}${first}'); const m = await import('${dir}index.ts'); console.log(m.CATALOGUE.length);`;
    assert.strictEqual(execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' }).trim(), '162', first);
  }
});

test('no effect module but the entry points loads the registry, so none can build the catalogue before its own kind registers', () => {
  // Whoever imports index.ts, render.ts or the catalogue may build the catalogue
  // first; only these do, and type imports load nothing.
  const allowed = { 'index.ts': ['catalogue.ts', 'render.ts'], 'render.ts': [], 'catalogue.ts': ['index.ts'] };
  const dir = new URL('../../src/shared/effects/', import.meta.url);
  const found = Object.fromEntries(Object.keys(allowed).map((target) => [target, []]));
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts')).sort()) {
    for (const [, specifier] of readFileSync(new URL(file, dir), 'utf8').matchAll(/^(?:import|export)(?! type)[^'"]*['"]\.\/([\w-]+\.ts)['"]/gm)) {
      if (specifier in found) found[specifier].push(file);
    }
  }
  assert.deepStrictEqual(found, allowed);
});

// The effect names by ordinal, independent of the table under test; null where
// the member is not an effect and stays unnamed.
const NAMES = [
  'VisualizerFirework', 'VisualizerFlash', 'VisualizerSplotch', 'VisualizerPulse', 'VisualizerSolid', 'VisualizerSwirl', 'VisualizerWave',
  'MatrixCycle', 'MatrixFirework', 'MatrixPulse', 'MatrixFlash', 'MatrixSplotch', 'MatrixSolid', 'StrobeCycle', 'PartyStrobe', 'Swirl',
  'GrowCycle', 'FadeCycle', 'Fireworks', 'Drip', 'Glow', 'Blur', 'Split', 'Flip', 'CrossFade', 'GrooveWave',
  'FillCycle', 'SoftStrobe', 'QuickFlash', 'BigRoomWave', 'DoubleFill', 'Ascent', 'DoubleWave', 'Impact', 'Swagger', 'Vortex',
  'Tap', 'TapFade', 'TapPulse', null, 'SceneMakerFirework', 'America', 'FrontBack', 'Cauldron', 'Circuit', 'TriPulse',
  'Sketch', 'ScatterStrobe', 'DoSiDo', 'DoubleDrip', 'Rotation', 'Trance', 'BeatPulse1', 'BeatPulse4', 'BigRoomMix', 'House',
  'Electro', 'Techno', 'Dubstep', 'DrumAndBass', 'Highlight', 'Explode', 'Lightning', null, 'Confetti', 'Blooms',
  'BeatWave', 'Zin', 'Zout', 'PaletteStrobe', 'PaletteTrail', 'PaletteFill', 'BLStrobeCycle', 'BLGrowCycle', 'BLFadeCycle', 'ScatterFill',
  'ScatterFade', 'ScatterGrow', 'BLScatterFade', 'BLScatterStrobe', 'BLScatterGrow', 'DubstepStrobe', 'DAndBStrobe', 'HouseStrobe', 'ElectroStrobe', 'TechnoStrobe',
  'Scan', 'Rivers', 'Rainfall', 'TrueStrobe', 'Pong', null, 'Blackout', 'DoubleFillStrobe', 'DoubleStrobeCycle', 'DoubleScatterStrobe',
  'BrtSinStrobe', 'BrtSinScatter', 'ThreeStageStrobe', 'ThreeStageFade', 'ThreeStageFlare', 'ThreeStageGlow', 'ThreeStageFill', 'FiveStageFlare', 'FiveStageGlow', 'FiveStageFill',
  'FiveStageStrobe', 'FiveStageFade', 'SMStudioN1Pulse', 'SMStudioN2Pulse', 'SMStudioN3Pulse', 'SMStudioN4Pulse', 'SMStudioN5Pulse', 'SMStudioN2PulseMulti', 'SMStudioN3PulseMulti', 'SMStudioN4PulseMulti',
  'SMStudioN5PulseMulti', 'SMStudioN1Fill', 'SMStudioN2Fill', 'SMStudioN3Fill', 'SMStudioN4Fill', 'SMStudioN5Fill', 'Perlin', 'Snake', 'SnakeFill', 'NorthernLights',
  'Beacon', 'FillFromInside', 'FillFromOutside', 'ThreeStrobeAndFade', 'Popcorn', 'RotatingHalfs', 'TwoCorners', 'FlareAndBreak', 'PaletteTrueStrobe', 'PaletteDrip',
  'PaletteGlow', 'PaletteFlare', 'PalettePartyStrobe', 'PaletteSplit', 'ThreeStageStrobeMod', 'ThreeStageFadeMod', 'ThreeStageFlareMod', 'StudioN1', null, 'StudioN2',
  'StudioN3', 'StudioN4', 'StudioN5', 'StudioC1', 'StudioC2', 'StudioC3', 'StudioC4', 'StudioC5', 'Studio5x1', 'Studio5x2',
  'Studio5x3', 'Studio5x4', 'Studio5x5', 'StudioSwirl', 'StudioWave', 'StudioStop', 'StudioFireworks', 'StudioFlashes', 'ComboBreak', 'ToggleDirection',
  'FadeToBaseline', 'SetPulserBaselineColor', null, null, null, null,
];
const span = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const CLASSES = {
  'preset:channel': [12, 13, 16, 17, 19, 20, 21, 22, 23, 24, 26, 27, 28, 30, 40, 41, 42, 43, 45, 46, 48, 49, 51, 52, 53, ...span(117, 121), 131, 132],
  'preset:iteration': [7, 44, 47, ...span(69, 85), 89, ...span(93, 116), 129, 130, ...span(133, 142)],
  'preset:rotation': [15, 50, 122, 125, 126],
  'preset:wave': [25, 29, 31, 32, 33, 34, 35],
  'preset:matrix': [8, 9, 10, 11, 14],
  'preset:studio': [143, ...span(145, 160), 162, 163],
  'preset:visualizer': span(0, 6),
  macro: [18, 54, 55, 56, 57, 58, 59, 92],
  engineCommand: [161, 164, 165, 166, 167],
  internal: [39, 63, 91, 144, 168, 169, 170, 171],
  'outOfScope:nanoleaf': [60, 61, 62, 64, 65, 66, 67, 68, 86, 87, 88, 90, 123, 124, 127, 128],
  'outOfScope:dead': [36, 37, 38],
};
const classOf = (row) => row.kind === 'preset' ? `preset:${row.engine}` : row.kind === 'outOfScope' ? `outOfScope:${row.reason}` : row.kind;

test('the classification covers ordinals 0..171 exactly once, in disjoint classes of known size, with the effect names', () => {
  assert.deepStrictEqual(Object.keys(LDJ_IDS).map(Number), span(0, 171));
  assert.strictEqual(NAMES.length, 172);
  const found = {};
  for (const [ordinal, row] of Object.entries(LDJ_IDS)) (found[classOf(row)] ??= []).push(Number(ordinal));
  assert.deepStrictEqual(found, CLASSES);
  const sizes = Object.fromEntries(Object.entries(found).map(([k, v]) => [k, v.length]));
  assert.deepStrictEqual(sizes, { 'preset:visualizer': 7, 'preset:iteration': 57, 'preset:matrix': 5, 'preset:channel': 32, 'preset:rotation': 5,
    macro: 8, 'preset:wave': 7, 'outOfScope:dead': 3, internal: 8, 'outOfScope:nanoleaf': 16, 'preset:studio': 19, engineCommand: 5 });
  for (const [ordinal, row] of Object.entries(LDJ_IDS)) {
    if (row.kind === 'internal') assert.strictEqual(NAMES[ordinal], null, `ordinal ${ordinal}`);
    else assert.strictEqual(row.name, NAMES[ordinal], `ordinal ${ordinal}`);
  }
});

test('members that are not effects are recorded by ordinal and description only, and none becomes a preset', () => {
  for (const ordinal of CLASSES.internal) {
    const row = LDJ_IDS[ordinal];
    assert.deepStrictEqual(Object.keys(row).filter((key) => key !== 'presets'), ['kind', 'description'], `ordinal ${ordinal}`);
    assert.ok(row.description.length > 10, `ordinal ${ordinal} describes itself`);
  }
  // Commands keep their transport names, and like the excluded effects they are not presets.
  assert.deepStrictEqual(CLASSES.engineCommand.map((o) => LDJ_IDS[o].command), ['stop', 'comboBreak', 'toggleDirection', 'fadeToBaseline', 'setPulserBaselineColor']);
  for (const ordinal of [...CLASSES.engineCommand, ...CLASSES['outOfScope:nanoleaf'], ...CLASSES['outOfScope:dead']]) {
    assert.strictEqual(presetById(`ldj.${LDJ_IDS[ordinal].name}`), null, LDJ_IDS[ordinal].name);
    assert.strictEqual(kindOf(`ldj.${LDJ_IDS[ordinal].name}`), null, LDJ_IDS[ordinal].name);
  }
});

const ldjRows = () => CATALOGUE.filter((p) => p.app === 'ldj');

test('162 Light DJ rows: one per preset or macro ordinal and one per bitmap pattern, each its own id', () => {
  const rows = ldjRows();
  assert.strictEqual(rows.length, 162);
  assert.strictEqual(new Set(rows.map((p) => p.id)).size, 162);
  const fromTable = Object.values(LDJ_IDS).filter((r) => r.kind === 'preset' || r.kind === 'macro').map((r) => r.id);
  assert.deepStrictEqual(rows.map((p) => p.id).sort(), [...fromTable, ...LDJ_IDS[169].presets].sort());
  // The touch board is a parameterised surface with no preset of its own.
  assert.ok(!rows.some((p) => p.spec.kind === 'ldj.matrixBoard'));
  for (const row of Object.values(LDJ_IDS)) {
    if (row.kind !== 'preset' || row.engine === 'visualizer') continue;
    const preset = presetById(row.id);
    assert.strictEqual(row.id, `ldj.${row.name}`);
    assert.strictEqual(preset.spec.kind, row.id, 'the kind is the effect');
    assert.strictEqual(preset.family, `ldj.${row.engine}`);
  }
  // Every Scene Maker row is in its family; all but Fireworks change renderer within the row and play as macros.
  for (const ordinal of CLASSES.macro) {
    const preset = presetById(LDJ_IDS[ordinal].id);
    assert.strictEqual(preset.family, 'ldj.macro', preset.id);
    assert.strictEqual(preset.spec.kind, LDJ_IDS[ordinal].name === 'Fireworks' ? 'ldj.SceneMakerFirework' : 'macro', preset.id);
  }
});

test('the seven visualizer ordinals pair each spike type with the swirl, and each background with fireworks', () => {
  const pairs = CLASSES['preset:visualizer'].map((o) => {
    const preset = presetById(LDJ_IDS[o].id);
    assert.strictEqual(preset.spec.kind, 'ldj.visualizer');
    assert.strictEqual(preset.family, 'ldj.visualizer');
    return [preset.id, preset.spec.params.active, preset.spec.params.mellow];
  });
  assert.deepStrictEqual(pairs, [
    ['ldj.visualizer.firework', 'firework', 'swirl'], ['ldj.visualizer.flash', 'flash', 'swirl'],
    ['ldj.visualizer.splotch', 'splotch', 'swirl'], ['ldj.visualizer.pulse', 'pulse', 'swirl'],
    ['ldj.visualizer.solid', 'firework', 'solid'], ['ldj.visualizer.swirl', 'firework', 'swirl'], ['ldj.visualizer.wave', 'firework', 'wave'],
  ]);
});

test('the bitmap engine stands for its 22 patterns, each a preset of the one bitmap kind', () => {
  assert.strictEqual(BITMAP_PATTERNS.length, 22);
  assert.deepStrictEqual(LDJ_IDS[169].presets, BITMAP_PATTERNS.map((p) => `ldj.bitmap.${p}`));
  for (const pattern of BITMAP_PATTERNS) {
    const preset = presetById(`ldj.bitmap.${pattern}`);
    assert.strictEqual(preset.spec.kind, 'ldj.bitmap', pattern);
    assert.strictEqual(preset.spec.params.pattern, pattern);
    assert.strictEqual(preset.family, 'ldj.bitmap');
  }
});

test('built-in specs are wire data: they validate to themselves and survive JSON', () => {
  for (const p of ldjRows()) {
    assert.deepStrictEqual(validateSpec(p.spec), p.spec, p.id);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(p.spec)), p.spec, p.id);
  }
});

test('lifetime is catalogue metadata: 32 beats on every row, while kernels and scores keep their own timing', () => {
  for (const p of ldjRows()) assert.strictEqual(p.lengthBeats, 32, p.id);
  // Rows with a beats parameter keep their 32 there; the others gain none.
  assert.strictEqual(presetById('ldj.ScatterStrobe').spec.params.beats, 32);
  assert.strictEqual(presetById('ldj.ScatterStrobe').spec.params.cadence, 0.25);
  assert.strictEqual(presetById('ldj.Swirl').spec.params.beats, 32);
  for (const id of ['ldj.StudioN5', 'ldj.bitmap.SmoothLoop', 'ldj.visualizer.pulse']) assert.ok(!('beats' in presetById(id).spec.params), id);
  assert.deepStrictEqual(presetById('ldj.StudioN5').spec.params, {});
  const loops = Object.fromEntries(CLASSES.macro.map((o) => [LDJ_IDS[o].name, presetById(LDJ_IDS[o].id).spec.params.loopBeats]));
  assert.deepStrictEqual(loops, { Fireworks: undefined, BigRoomMix: 16, House: 4, Electro: 4, Techno: 4, Dubstep: 4, DrumAndBass: 4, Blackout: 32 });
  // Fireworks has no loop to restart; the 32 sits in its renderer's own beats parameter.
  assert.strictEqual(presetById('ldj.Fireworks').spec.params.beats, 32);
});

const RANDOM_RANDOM = [{ random: true }, { random: true }];

test('colour effects default to Random, Random; Old Glory keeps its own colours and Blackout stays dark', () => {
  for (const p of ldjRows()) {
    if (p.id === 'ldj.America' || p.id === 'ldj.Blackout') continue;
    assert.deepStrictEqual(p.spec.palette, RANDOM_RANDOM, p.id);
  }
  assert.strictEqual(presetById('ldj.America').spec.palette, undefined);
  const blackout = presetById('ldj.Blackout').spec;
  assert.strictEqual(blackout.palette, undefined);
  assert.deepStrictEqual(blackout.params.steps.map((s) => [s.effect.kind, s.effect.palette, s.effect.brightness, s.beats]), [['ldj.MatrixSolid', ['#000000'], 0, 32]]);
});

test('names split the effect name into words, Backlit for BL, or use the label Light DJ shows', () => {
  const name = (id) => presetById(id).name;
  assert.strictEqual(name('ldj.StrobeCycle'), 'Strobe Cycle');
  assert.strictEqual(name('ldj.BLStrobeCycle'), 'Backlit Strobe Cycle');
  assert.strictEqual(name('ldj.BLScatterGrow'), 'Backlit Scatter Grow');
  assert.strictEqual(name('ldj.BeatPulse4'), 'Beat Pulse 4');
  assert.strictEqual(name('ldj.SceneMakerFirework'), 'Scene Maker Firework');
  assert.strictEqual(name('ldj.StudioN1'), 'Studio N1');
  assert.strictEqual(name('ldj.Studio5x2'), 'Studio 5x2');
  assert.strictEqual(name('ldj.ThreeStageFlareMod'), '3-Stage Flare Mod');
  assert.strictEqual(name('ldj.FiveStageGlow'), '5-Stage Glow');
  assert.strictEqual(name('ldj.America'), 'Old Glory');
  assert.strictEqual(name('ldj.PalettePartyStrobe'), 'OG Party Strobe');
  assert.strictEqual(name('ldj.DAndBStrobe'), 'D&B Strobe');
  assert.strictEqual(name('ldj.DrumAndBass'), 'Drum & Bass');
  assert.strictEqual(name('ldj.ThreeStrobeAndFade'), '3-Strobe & Fade');
  // The Scene Maker's Studio rows are labelled by their length in beats, not their N number.
  assert.strictEqual(name('ldj.SMStudioN3Pulse'), 'Studio Pulse 4');
  assert.strictEqual(name('ldj.SMStudioN5PulseMulti'), 'Studio Pulse 8 Multi');
  assert.strictEqual(name('ldj.SMStudioN4Fill'), 'Studio Fill 6');
  assert.strictEqual(name('ldj.visualizer.splotch'), 'Visualizer Splotch');
  assert.strictEqual(name('ldj.bitmap.OGGrooveWave'), 'OG Groove Wave');
  assert.strictEqual(name('ldj.bitmap.SolidBGSineWave'), 'Backlit Sine Wave');
  assert.strictEqual(name('ldj.bitmap.VertLines'), 'Vertical Lines');
  const names = ldjRows().map((p) => p.name);
  assert.strictEqual(new Set(names).size, names.length, 'no two rows share a name');
  for (const p of ldjRows()) assert.ok(p.desc.startsWith('Light DJ'), p.id);
});

test('lookup is by id or alias: unknown ids are null, legacy ids are never taken, and a doubly claimed id is refused', () => {
  assert.strictEqual(presetById('ldj.NoSuchEffect'), null);
  assert.strictEqual(presetById(''), null);
  for (const id of PATTERN_IDS) assert.notStrictEqual(presetById(id)?.app, 'ldj', id);
  const row = (id, aliases) => ({ id, name: id, desc: '', app: 'own', family: 'own', spec: validateSpec({ kind: 'energy.kill' }), aliases });
  const index = presetIndex([row('a', ['old-a']), row('b')]);
  assert.strictEqual(index.get('old-a').id, 'a');
  assert.throws(() => presetIndex([row('a'), row('a')]), /claimed twice/);
  assert.throws(() => presetIndex([row('a'), row('b', ['a'])]), /claimed twice/);
  assert.throws(() => presetIndex([row('a', ['x']), row('b', ['x'])]), /claimed twice/);
});

test('built-ins are frozen, and building them left the shared palette data untouched', () => {
  const p = presetById('ldj.House');
  assert.ok(Object.isFrozen(CATALOGUE) && Object.isFrozen(LDJ_PRESETS) && Object.isFrozen(p) && Object.isFrozen(p.spec) && Object.isFrozen(p.spec.params));
  assert.ok(Object.isFrozen(p.spec.params.steps[0].effect.params) && Object.isFrozen(p.spec.palette[0]));
  assert.throws(() => { p.spec.params.loopBeats = 8; }, TypeError);
  assert.ok(Object.isFrozen(BUILTIN_PALETTES) && BUILTIN_PALETTES.every((palette) => Object.isFrozen(palette) && Object.isFrozen(palette.colours)));
  // The catalogue holds copies, never the seed table's own sentinel objects.
  assert.notStrictEqual(p.spec.palette[0], LDJ_PALETTES.find((x) => x.id === 'randomRandom').colours[0]);
  assert.deepStrictEqual(LDJ_PALETTES.find((x) => x.id === 'randomRandom').colours, RANDOM_RANDOM);
  assert.ok(Object.isFrozen(LDJ_IDS) && Object.isFrozen(LDJ_IDS[169]) && Object.isFrozen(LDJ_IDS[169].presets));
});

test('the 28 built-in palettes: Light DJ\'s 26 seeds in its order with their exact colours, then Hue Dynamics\' two', () => {
  const R = { random: true };
  assert.deepStrictEqual(BUILTIN_PALETTES.map((p) => [p.id, p.app, [...p.colours]]), [
    ['redCyan', 'ldj', ['#FF0000', '#00BFFF']], ['orangeBlue', 'ldj', ['#FF9900', '#2A00FF']],
    ['yellowPurple', 'ldj', ['#FFFF00', '#AA00FF']], ['greenPink', 'ldj', ['#00FF00', '#FF0095']],
    ['redYellow', 'ldj', ['#FF0000', '#FFFF00']], ['greenBlue', 'ldj', ['#00FF00', '#2A00FF']],
    ['whiteOff', 'ldj', ['#FFFFFF', '#000000']], ['randomRandom', 'ldj', [R, R]],
    ['redOrangeYellow', 'ldj', ['#FF0000', '#FF9900', '#FFFF00']], ['orangeYellowGreen', 'ldj', ['#FF9900', '#FFFF00', '#00FF00']],
    ['yellowGreenCyan', 'ldj', ['#FFFF00', '#00FF00', '#00BFFF']], ['greenCyanBlue', 'ldj', ['#00FF00', '#00BFFF', '#2A00FF']],
    ['cyanBluePurple', 'ldj', ['#00BFFF', '#2A00FF', '#AA00FF']], ['bluePurplePink', 'ldj', ['#2A00FF', '#AA00FF', '#FF0095']],
    ['purplePinkRed', 'ldj', ['#AA00FF', '#FF0095', '#FF0000']], ['pinkRedOrange', 'ldj', ['#FF0095', '#FF0000', '#FF9900']],
    ['redYellowBlue', 'ldj', ['#FF0000', '#FFFF00', '#2A00FF']], ['yellowPurplePink', 'ldj', ['#FFFF00', '#AA00FF', '#FF0095']],
    ['greenCyanPink', 'ldj', ['#00FF00', '#00BFFF', '#FF0095']], ['rocketPop', 'ldj', ['#D60210', '#F0F1FF', '#0814FF']],
    ['blueDream', 'ldj', ['#0B1066', '#0A108C', '#0E4EAD', '#0E7BC9']], ['strawberryDaiquiri', 'ldj', ['#8A0700', '#F75C78', '#F53659', '#F20A34']],
    ['screwdriver', 'ldj', ['#FC530A', '#FFA929', '#F7822F', '#FC6F0A']], ['goodVibes', 'ldj', ['#226987', '#FFF203', '#FFA600', '#3890B5']],
    ['electricSummer', 'ldj', ['#00DBBE', '#BEF711', '#F1FF33', '#FC235A']],
    ['rainbow', 'ldj', ['#FF0000', '#FF9900', '#FFFF00', '#00FF00', '#00BFFF', '#2A00FF', '#AA00FF', '#FF0095']],
    ['hdDefault', 'hd', ['#A855F7', '#22D3EE', '#F472B6']], ['hdStrobe', 'hd', ['#FFFFFF']],
  ]);
  // One source: the catalogue's Light DJ palettes are the Visualizer's own records.
  BUILTIN_PALETTES.filter((p) => p.app === 'ldj').forEach((p, i) => assert.strictEqual(p, LDJ_PALETTES[i]));
});

test('families group every Light DJ row and kind, as plain data', () => {
  const ids = FAMILIES.map((f) => f.id);
  assert.deepStrictEqual(ids, ['ldj.channel', 'ldj.iteration', 'ldj.rotation', 'ldj.wave', 'ldj.matrix', 'ldj.studio', 'ldj.visualizer', 'ldj.bitmap', 'ldj.macro']);
  for (const p of ldjRows()) {
    const family = FAMILIES.find((f) => f.id === p.family);
    assert.ok(family?.kinds.some((k) => k.kind === p.spec.kind), p.id);
  }
  // Every registered Light DJ kind belongs to exactly one engine family; the
  // Scene Maker family holds the macro kind and the renderer Fireworks plays.
  const ldjKinds = [...KINDS.values()].filter((def) => def.app === 'ldj').map((def) => def.kind).sort();
  const listed = FAMILIES.filter((f) => f.id !== 'ldj.macro').flatMap((f) => f.kinds.map((k) => k.kind)).sort();
  assert.deepStrictEqual(listed, ldjKinds);
  assert.deepStrictEqual(FAMILIES.find((f) => f.id === 'ldj.macro').kinds.map((k) => k.kind).sort(), ['ldj.SceneMakerFirework', 'macro']);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(FAMILIES)), FAMILIES, 'no functions or schemas');
  const flip = FAMILIES.find((f) => f.id === 'ldj.channel').kinds.find((k) => k.kind === 'ldj.Flip');
  assert.deepStrictEqual(flip.defaults.params, { cadence: 2, beats: 32 });
  assert.notStrictEqual(flip.defaults, kindOf('ldj.Flip').defaults, 'a copy, not the registry\'s object');
});

test('the macro scores: Beat Pulse hits once each, in the primary or secondary role, over four beats', () => {
  const score = (name) => presetById(`ldj.${name}`).spec.params.steps.map((s) => {
    assert.deepStrictEqual([s.effect.params.cadence, s.effect.params.iterations], [0.25, 1], name);
    assert.strictEqual(s.effect.palette, undefined, name);
    return [s.effect.kind === 'ldj.BeatPulse1' ? 1 : 4, s.paletteIndices[0] === 1 ? 'p' : 's', s.beats, s.paletteIndices.length];
  });
  assert.deepStrictEqual(score('House'), [[1, 'p', 1, 1], [1, 's', 1, 1], [1, 'p', 1, 1], [1, 's', 0.5, 1], [1, 's', 0.5, 1]]);
  assert.deepStrictEqual(score('Electro'), [[1, 'p', 0.75, 1], [1, 'p', 0.75, 1], [1, 'p', 1, 1], [1, 's', 0.5, 1], [1, 's', 1, 1]]);
  assert.deepStrictEqual(score('Techno'), [[1, 'p', 1, 1], [1, 's', 1, 1], [1, 'p', 1, 1], [1, 's', 1, 1]]);
  assert.deepStrictEqual(score('Dubstep'), [[1, 'p', 0.5, 1], [1, 'p', 0.5, 1], [1, 's', 1, 1], [1, 'p', 0.5, 1], [1, 'p', 0.5, 1], [1, 's', 1, 1]]);
  assert.deepStrictEqual(score('DrumAndBass'), [[1, 'p', 1.5, 1], [4, 'p', 1.5, 1], [4, 's', 1, 1]]);
  const big = presetById('ldj.BigRoomMix').spec.params.steps;
  assert.deepStrictEqual(big.map((s) => [s.effect.kind, s.beats, s.paletteIndices ?? null]),
    [['ldj.QuickFlash', 4, null], ['ldj.BigRoomWave', 3.6, null], ['ldj.BigRoomWave', 3.6, null], ['ldj.Flip', 4.8, [1, 0]]]);
  assert.strictEqual(big[0].effect.params.iterations, 1);
  assert.deepStrictEqual([big[1].effect.params.once, big[1].effect.params.phase, big[2].effect.params.once, big[2].effect.params.phase], [true, 0, true, 1]);
  assert.deepStrictEqual([big[3].effect.params.cadence, big[3].effect.params.iterations], [0.9, 4]);
  // Fireworks is the firework renderer itself, in Random, Random.
  const fireworks = presetById('ldj.Fireworks').spec;
  assert.deepStrictEqual([fireworks.kind, fireworks.palette], ['ldj.SceneMakerFirework', RANDOM_RANDOM]);
  assert.deepStrictEqual(fireworks, presetById('ldj.SceneMakerFirework').spec);
  // Pulses and fireworks flash fast, so their rows need the acknowledgement; Blackout does not.
  for (const name of ['House', 'Electro', 'Techno', 'Dubstep', 'DrumAndBass', 'BigRoomMix', 'Fireworks']) {
    assert.strictEqual(requiresAcknowledgement(presetById(`ldj.${name}`).spec), true, name);
  }
  assert.strictEqual(requiresAcknowledgement(presetById('ldj.Blackout').spec), false);
});

// Rendering a built-in through the renderer's own entry, every 44 Hz frame, at 60 BPM.
const RED = parseHex('#FF0000'), BLUE = parseHex('#0000FF'), GREEN = parseHex('#00FF00'), WHITE = parseHex('#FFFFFF');
const BEAT_MS = 1000;
const lamp = () => buildRoom(1, () => 0.5, () => 0.5, () => 0.5, null);
const square = () => buildRoom(4, (i) => [0, 1, 1, 0][i], (i) => [0, 0, 1, 1][i], () => 0.5, null);
function play(spec, beats, { r = lamp(), override = null, look = [RED, BLUE] } = {}) {
  const stepper = new EffectStepper();
  const inst = { id: 'built-in', spec, seed: seedFrom('catalogue'), anchorBeat: 0, startedAtMs: 0, targets: null };
  const frames = [];
  for (let ms = 0; ms <= beats * BEAT_MS + 1e-9; ms += 1000 / 44) {
    const out = [];
    renderEffect(inst, { beatPos: ms / BEAT_MS, bpm: 60000 / BEAT_MS, nowMs: ms, dtMs: 1000 / 44, anchorBeat: 0, lookPalette: look, paletteOverride: override,
      audio: null, audioMode: 'tempo', master: HD_MASTER_DEFAULTS, seed: inst.seed, acknowledged: true, hueStrobe: 'flash' }, r, stepper, out);
    frames.push({ beat: ms / BEAT_MS, out });
  }
  return frames;
}
/** The beats at which the lamp lights up, with the colour it lights in. */
function hits(frames) {
  const found = [];
  frames.forEach((f, i) => {
    const lit = f.out[0].level > 0.5, before = i > 0 && frames[i - 1].out[0].level > 0.5;
    if (lit && !before) found.push([Math.round(f.beat * 20) / 20, f.out[0].colour]);
  });
  return found;
}
const withPalette = (id, palette) => ({ ...presetById(id).spec, palette });

test('one lamp, one colour, no audio: every row renders finite light, and only Blackout stays dark', () => {
  for (const p of ldjRows()) {
    let brightest = 0;
    for (const f of play(withPalette(p.id, ['#00FF00']), 4)) {
      const slot = f.out[0];
      assert.ok([slot.level, slot.strength, ...Object.values(slot.colour)].every(Number.isFinite), `${p.id} at beat ${f.beat}`);
      brightest = Math.max(brightest, slot.level * slot.strength);
    }
    assert.strictEqual(brightest > 0.01, p.id !== 'ldj.Blackout', p.id);
  }
});

test('rendered, each genre score lights its hits on time in its roles, with no retrigger in the rests', () => {
  const expected = {
    House: [[0, 'p'], [1, 's'], [2, 'p'], [3, 's'], [3.5, 's']],
    Electro: [[0, 'p'], [0.75, 'p'], [1.5, 'p'], [2.5, 's'], [3, 's']],
    Techno: [[0, 'p'], [1, 's'], [2, 'p'], [3, 's']],
    Dubstep: [[0, 'p'], [0.5, 'p'], [1, 's'], [2, 'p'], [2.5, 'p'], [3, 's']],
  };
  for (const [name, want] of Object.entries(expected)) {
    // Secondary first, primary second, as Light DJ orders a palette's roles.
    const got = hits(play(withPalette(`ldj.${name}`, ['#FF0000', '#0000FF']), 7.9));
    const lap = want.map(([beat, role]) => [beat, role === 'p' ? BLUE : RED]);
    assert.deepStrictEqual(got, [...lap, ...lap.map(([beat, colour]) => [beat + 4, colour])], name);
  }
  // Drum & Bass: a short pulse, then Beat Pulse 4's long one, held until the secondary replaces it.
  const dnb = play(withPalette('ldj.DrumAndBass', ['#FF0000', '#0000FF']), 3.9);
  const at = (frames, beat) => frames.reduce((best, f) => Math.abs(f.beat - beat) < Math.abs(best.beat - beat) ? f : best).out[0];
  assert.strictEqual(at(dnb, 0.1).colour.b, 255);
  assert.strictEqual(at(dnb, 1).level, 0, 'the first pulse is short');
  assert.deepStrictEqual([at(dnb, 2.9).colour, at(dnb, 2.9).level], [BLUE, 1], 'the long pulse holds');
  assert.deepStrictEqual([at(dnb, 3.5).colour, at(dnb, 3.5).level], [RED, 1], 'the secondary replaces it');
});

test('a one-colour palette serves both roles, and a global override is mapped role by role', () => {
  assert.deepStrictEqual(hits(play(withPalette('ldj.Techno', ['#00FF00']), 3.9)).map(([, c]) => c), [GREEN, GREEN, GREEN, GREEN]);
  const overridden = hits(play(presetById('ldj.Techno').spec, 3.9, { override: [GREEN, WHITE] }));
  assert.deepStrictEqual(overridden, [[0, WHITE], [1, GREEN], [2, WHITE], [3, GREEN]]);
  assert.deepStrictEqual(hits(play(presetById('ldj.Techno').spec, 3.9, { override: [WHITE] })).map(([, c]) => c), [WHITE, WHITE, WHITE, WHITE]);
});

test('Blackout holds every lamp dark at full strength, even under a white override, through its 32-beat loop', () => {
  for (const f of play(presetById('ldj.Blackout').spec, 33, { r: square(), override: [WHITE] })) {
    for (const slot of f.out) assert.deepStrictEqual([slot.level, slot.strength], [0, 1], `beat ${f.beat}`);
  }
});

test('a held Fireworks keeps its fades past beat 32: a lamp goes dark mid-fade only when a new firework relights it', () => {
  // Light DJ re-runs the row on the firework renderer that is still running,
  // so the fireworks of one lap fade out into the next.
  const frames = play(presetById('ldj.Fireworks').spec, 34, { r: square() });
  let fading = 0;
  frames.forEach((f, i) => {
    // The last frames have no next frames to show a relight in.
    if (i === 0 || i + 5 > frames.length) return;
    f.out.forEach((slot, lamp) => {
      const before = frames[i - 1].out[lamp].level;
      if (before > 0.2 && before < 0.95 && f.beat > 31 && f.beat < 33) fading++;
      if (!(before > 0.2 && slot.level === 0)) return;
      const relit = frames.slice(i + 1, i + 5).some((g) => g.out[lamp].level > 0.5);
      assert.ok(relit, `lamp ${lamp} cut from ${before.toFixed(2)} at beat ${f.beat.toFixed(3)}`);
    });
  });
  assert.ok(fading > 0, 'some fireworks are fading across beat 32');
});

test('Big Room Mix: a quick flash, two single waves, four flips that hold to beat 16, then the flash again', () => {
  const frames = play(withPalette('ldj.BigRoomMix', ['#FF0000', '#0000FF']), 17, { r: square() });
  const key = (f) => JSON.stringify(f.out.map((s) => [s.colour, s.level]));
  const changes = [];
  frames.forEach((f, i) => { if (f.beat >= 11.2 - 1e-9 && f.beat < 16 && key(f) !== key(frames[i - 1])) changes.push(f.beat); });
  // Flip at 11.2, 12.1, 13 and 13.9; nothing new at 14.8 or 15.7.
  assert.strictEqual(changes.length, 4, `changes at ${changes}`);
  [11.2, 12.1, 13, 13.9].forEach((due, k) => assert.ok(changes[k] >= due - 1e-9 && changes[k] < due + 0.05, `flip ${k} at ${changes[k]}`));
  const near = (beat) => frames.reduce((best, f) => Math.abs(f.beat - beat) < Math.abs(best.beat - beat) ? f : best);
  // Flip plays the roles reversed: its first update lights the primary where it would light the secondary.
  const flip = play(withPalette('ldj.Flip', ['#FF0000', '#0000FF']), 0.1, { r: square() }).at(-1).out.map((s) => s.colour);
  assert.deepStrictEqual(near(11.3).out.map((s) => s.colour), flip.map((c) => c.r === 255 ? BLUE : RED));
  assert.notDeepStrictEqual(flip, flip.map((c) => c.r === 255 ? BLUE : RED), 'both colours are on show');
  // Each wave step starts a front of its own: the first frames of the two differ in their phase.
  assert.notStrictEqual(key(near(4.05)), key(near(7.65)));
  // The quick flash is back at 16: its envelope rises from dark.
  assert.strictEqual(near(16.02).out[0].level < near(15.9).out[0].level, true);
});
