// The built-in presets, families and palettes that pickers, pads and routes
// list. Specs stay wire data (hex colours, random sentinels) and are validated
// here once, so a built-in validates to itself. Everything is frozen: editing
// a built-in means copying it.

// Every kind registers before the rows below validate against it.
import './index.ts';
import { kindOf, validateSpec } from './registry.ts';
import { BITMAP_PATTERNS } from './ldj-bitmap.ts';
import { LDJ_IDS } from './ldj-ids.ts';
import type { LdjEngine } from './ldj-ids.ts';
import { LDJ_PALETTES } from './ldj-palettes.ts';
import type { BuiltinPalette } from './ldj-palettes.ts';
import { VISUALIZER_PRESETS } from './ldj-visualizer.ts';
import type { MacroStep } from './macro.ts';
import type { EffectKindDef, EffectSpec, PaletteEntry } from './types.ts';

export interface CataloguePreset {
  id: string; name: string; desc: string; app: 'hd' | 'ldj' | 'own'; family: string; spec: EffectSpec;
  party?: boolean; pixel?: boolean; aliases?: string[];
  /** The renderer keeps PATTERN_FUNCS for this id. */
  legacy?: boolean;
  /** A legacy row's parameterised equivalent. */
  preset?: string;
  /** How long a once launch plays when the request names no length; kernel timing and macro loops are unaffected. */
  lengthBeats?: number;
}

/** A family groups presets in the pickers; its kinds carry their recommended settings as plain data. */
export interface CatalogueFamily {
  id: string; app: 'hd' | 'ldj' | 'own'; name: string;
  kinds: { kind: string; defaults: EffectKindDef['defaults']; capabilities: EffectKindDef['capabilities'] }[];
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
// Families travel to the browser as JSON: never the registry's own objects.
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const RANDOM_RANDOM: readonly PaletteEntry[] = LDJ_PALETTES.find((p) => p.id === 'randomRandom')!.colours;
// Every Light DJ preset plays 32 beats once by default. Each type's own
// minimum length in the app is at most 16 beats, so 32 is never shorter.
const LDJ_LENGTH_BEATS = 32;

// The labels Light DJ shows its users where they are not the effect's name
// split into words. Ids keep the names.
const LABELS: Record<string, string> = {
  America: 'Old Glory', BrtSinScatter: 'Sine Scatter Strobe', BrtSinStrobe: 'Sine Strobe Cycle', DAndBStrobe: 'D&B Strobe',
  DoSiDo: 'Do-Si-Do', DrumAndBass: 'Drum & Bass', FlareAndBreak: 'Flare & Break', PalettePartyStrobe: 'OG Party Strobe',
  PaletteSplit: 'OG Split', ThreeStrobeAndFade: '3-Strobe & Fade', TriPulse: 'Tri-Pulse',
};
const BITMAP_LABELS: Record<string, string> = {
  VertLines: 'Vertical Lines', SineWave: 'Gradient Sine Wave', TriangleWave: 'Gradient Triangle Wave',
  DiagonalLines: 'Gradient Diagonal Lines', SolidBGSineWave: 'Backlit Sine Wave', SolidBGTriangleWave: 'Backlit Triangle Wave',
  SolidBGDiagonalLines: 'Backlit Diagonal Lines', SolidBlackBGSineWave: 'Sine Wave', SolidBlackBGTriangleWave: 'Triangle Wave',
  SolidBlackBGDiagonalLines: 'Diagonal Lines',
};
// The Scene Maker's Studio rows N1..N5 are labelled by their length in beats.
const STUDIO_BEATS = [1, 2, 4, 6, 8];

const words = (name: string) => name
  .replace(/^BL(?=[A-Z])/, 'Backlit ')
  .replace(/^(Three|Five)Stage/, (_, n: string) => `${n === 'Three' ? 3 : 5}-Stage`)
  .replace(/([a-z])(?=[A-Z])/g, '$1 ')
  .replace(/([A-Z])(?=[A-Z][a-z])/g, '$1 ')
  .replace(/([a-z]{2})(?=\d)/g, '$1 ');

/** The display name of a Light DJ effect type. */
function ldjName(name: string): string {
  const studio = /^SMStudioN([1-5])(Pulse|Fill)(Multi)?$/.exec(name);
  if (studio) return `Studio ${studio[2]} ${STUDIO_BEATS[Number(studio[1]) - 1]}${studio[3] ? ' Multi' : ''}`;
  return LABELS[name] ?? words(name);
}

const FAMILY: Record<LdjEngine | 'macro', { name: string; desc: string }> = {
  channel: { name: 'Channel', desc: 'Light DJ: the room in groups that change together on the beat' },
  iteration: { name: 'Iteration', desc: 'Light DJ: lamps lit in turn on the beat' },
  rotation: { name: 'Rotation', desc: 'Light DJ: colours turning round the room' },
  wave: { name: 'Wave', desc: 'Light DJ: colour travelling across the room' },
  matrix: { name: 'Matrix', desc: 'Light DJ: random lamps flashing on a clock of their own' },
  studio: { name: 'Studio', desc: 'Light DJ Studio: notes and backgrounds over a dim baseline' },
  visualizer: { name: 'Visualizer', desc: 'Light DJ Visualizer: spikes on loud beats over a calm background' },
  bitmap: { name: 'Bitmap', desc: 'Light DJ: a picture scrolling across the room at tempo' },
  macro: { name: 'Scene Maker', desc: 'Light DJ Scene Maker' },
};

// Genre scores: one Beat Pulse per hit, held until the next replaces it.
// A hit in the primary colour (P) maps the palette's second entry, in the
// secondary (S) its first; a one-colour palette serves both.
const P = 1, S = 0;
type Hit = [pulse: 1 | 4, role: typeof P | typeof S, beats: number];
const SCORES: Record<string, { hits: Hit[]; desc: string }> = {
  House: { hits: [[1, P, 1], [1, S, 1], [1, P, 1], [1, S, .5], [1, S, .5]], desc: 'a pulse on every beat, primary then secondary, and one more on the last off-beat' },
  Electro: { hits: [[1, P, .75], [1, P, .75], [1, P, 1], [1, S, .5], [1, S, 1]], desc: 'three primary pulses dotted across the bar, then two secondary' },
  Techno: { hits: [[1, P, 1], [1, S, 1], [1, P, 1], [1, S, 1]], desc: 'a pulse on every beat, primary and secondary in turn' },
  Dubstep: { hits: [[1, P, .5], [1, P, .5], [1, S, 1], [1, P, .5], [1, P, .5], [1, S, 1]], desc: 'two quick primary pulses, then a secondary, twice a bar' },
  DrumAndBass: { hits: [[1, P, 1.5], [4, P, 1.5], [4, S, 1]], desc: 'a short primary pulse, then long held primary and secondary pulses' },
};
const scoreSteps = (hits: Hit[]): MacroStep[] => hits.map(([pulse, role, beats]) => ({
  // A single callback: the row's own quarter-beat cadence would retrigger through every rest.
  effect: { kind: `ldj.BeatPulse${pulse}`, params: { cadence: .25, iterations: 1 } } as EffectSpec, beats, paletteIndices: [role],
}));

const macro = (steps: MacroStep[], loopBeats: number, palette?: readonly PaletteEntry[]) =>
  ({ kind: 'macro', params: { steps, loopBeats }, ...(palette ? { palette } : {}) });

// The Scene Maker rows, as the specs they play.
const SCENE_ROWS: Record<string, { spec: object; desc: string }> = {
  // The firework renderer keeps the row's random wall-clock schedule itself.
  // Light DJ re-runs a held row on the renderer still running, so its fades
  // carry into the next lap; a macro would relaunch it and cut them.
  Fireworks: { desc: 'fireworks on random lamps at random moments', spec: { kind: 'ldj.SceneMakerFirework', palette: RANDOM_RANDOM } },
  // Dark by brightness, not by a black palette an override could replace.
  Blackout: { desc: 'every lamp dark, whatever the palette',
    spec: macro([{ effect: { kind: 'ldj.MatrixSolid', palette: ['#000000'], brightness: 0 } as EffectSpec, beats: 32 }], 32) },
  // The app's row ends after its fourth Flip, at 14.8 beats; the last Flip
  // holds to the end of the sixteen-beat loop rather than adding a fifth.
  BigRoomMix: { desc: 'a quick flash, two big-room waves and four flips in reversed colours, every sixteen beats', spec: macro([
    { effect: { kind: 'ldj.QuickFlash', params: { cadence: 4, iterations: 1 } } as EffectSpec, beats: 4 },
    { effect: { kind: 'ldj.BigRoomWave', params: { once: true, phase: 0 } } as EffectSpec, beats: 3.6 },
    { effect: { kind: 'ldj.BigRoomWave', params: { once: true, phase: 1 } } as EffectSpec, beats: 3.6 },
    // Flip plays the two roles the other way round.
    { effect: { kind: 'ldj.Flip', params: { cadence: .9, iterations: 4 } } as EffectSpec, beats: 4.8, paletteIndices: [P, S] },
  ], 16, RANDOM_RANDOM) },
  ...Object.fromEntries(Object.entries(SCORES).map(([name, score]) =>
    [name, { desc: score.desc, spec: macro(scoreSteps(score.hits), 4, RANDOM_RANDOM) }])),
};

function ldjRow(id: string, name: string, family: LdjEngine | 'macro', raw: object, desc = FAMILY[family].desc): CataloguePreset {
  return { id, name, desc, app: 'ldj', family: `ldj.${family}`, spec: validateSpec(raw), lengthBeats: LDJ_LENGTH_BEATS };
}

function ldjPresets(): CataloguePreset[] {
  const rows: CataloguePreset[] = [];
  for (const row of Object.values(LDJ_IDS)) {
    if (row.kind === 'macro') {
      const scene = SCENE_ROWS[row.name];
      rows.push(ldjRow(row.id, ldjName(row.name), 'macro', scene.spec, `${FAMILY.macro.desc}: ${scene.desc}`));
    } else if (row.kind === 'preset' && row.engine === 'visualizer') {
      const visualizer = VISUALIZER_PRESETS.find((p) => p.id === row.id)!;
      rows.push(ldjRow(row.id, visualizer.name, 'visualizer', { kind: 'ldj.visualizer', params: visualizer.params, palette: RANDOM_RANDOM }));
    } else if (row.kind === 'preset') {
      // Old Glory has its own red, white and blue; every other effect takes Random, Random.
      rows.push(ldjRow(row.id, ldjName(row.name), row.engine, { kind: row.id, ...(row.name === 'America' ? {} : { palette: RANDOM_RANDOM }) }));
    }
  }
  for (const pattern of BITMAP_PATTERNS) {
    rows.push(ldjRow(`ldj.bitmap.${pattern}`, BITMAP_LABELS[pattern] ?? words(pattern), 'bitmap',
      { kind: 'ldj.bitmap', params: { pattern }, palette: RANDOM_RANDOM }));
  }
  return rows;
}

/** Ids and aliases share one namespace; a name claimed twice is an error in the table. */
export function presetIndex(rows: readonly CataloguePreset[]): ReadonlyMap<string, CataloguePreset> {
  const index = new Map<string, CataloguePreset>();
  for (const row of rows) {
    for (const key of [row.id, ...(row.aliases ?? [])]) {
      if (index.has(key)) throw new Error(`catalogue id ${key} is claimed twice`);
      index.set(key, row);
    }
  }
  return index;
}

export const LDJ_PRESETS: readonly CataloguePreset[] = deepFreeze(ldjPresets());
export const CATALOGUE: readonly CataloguePreset[] = deepFreeze([...LDJ_PRESETS]);
const INDEX = presetIndex(CATALOGUE);

/** A built-in preset by id or alias. */
export function presetById(id: string): CataloguePreset | null {
  return INDEX.get(id) ?? null;
}

function ldjFamily(engine: LdjEngine | 'macro', extra: string[] = []): CatalogueFamily {
  const id = `ldj.${engine}`;
  const kinds = [...new Set([...CATALOGUE.filter((p) => p.family === id).map((p) => p.spec.kind), ...extra])];
  return { id, app: 'ldj', name: FAMILY[engine].name, kinds: kinds.map((kind) => {
    const def = kindOf(kind)!;
    return { kind, defaults: plain(def.defaults), capabilities: def.capabilities ? plain(def.capabilities) : null };
  }) };
}

// The touch board renders through the matrix family's kinds and has no preset of its own.
// The Scene Maker family lists the macro kind and the firework renderer its Fireworks row plays.
export const FAMILIES: readonly CatalogueFamily[] = deepFreeze([
  ldjFamily('channel'), ldjFamily('iteration'), ldjFamily('rotation'), ldjFamily('wave'), ldjFamily('matrix', ['ldj.matrixBoard']),
  ldjFamily('studio'), ldjFamily('visualizer'), ldjFamily('bitmap'), ldjFamily('macro'),
]);

const HD_PALETTES: BuiltinPalette[] = [
  { id: 'hdDefault', app: 'hd', colours: ['#A855F7', '#22D3EE', '#F472B6'] },
  { id: 'hdStrobe', app: 'hd', colours: ['#FFFFFF'] },
];
/** Light DJ's 26 seeded palettes, then Hue Dynamics' default and its strobe's white. */
export const BUILTIN_PALETTES: readonly BuiltinPalette[] = deepFreeze([...LDJ_PALETTES, ...HD_PALETTES]);
