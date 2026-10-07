// The built-in presets, families and palettes that pickers, pads and routes
// list. Specs stay wire data (hex colours, random sentinels) and are validated
// here once, so a built-in validates to itself. Everything is frozen: editing
// a built-in means copying it.

// Every kind registers before the rows below validate against it.
import './index.ts';
import { HOLD_STROBE } from '../look-math.ts';
import { PATTERN_FUNCS } from '../patterns.ts';
import { kindOf, validateSpec } from './registry.ts';
import { DISCO_PRESETS } from './disco.ts';
import { ENERGY_KIND_BY_ID } from './energy.ts';
import { HD_DEFAULTS } from './hd.ts';
import type { HdKind } from './hd.ts';
import { BITMAP_PATTERNS } from './ldj-bitmap.ts';
import { LDJ_IDS } from './ldj-ids.ts';
import type { LdjEngine } from './ldj-ids.ts';
import { LDJ_PALETTES } from './ldj-palettes.ts';
import type { BuiltinPalette } from './ldj-palettes.ts';
import { VISUALIZER_PRESETS } from './ldj-visualizer.ts';
import type { MacroStep } from './macro.ts';
import type { Ahdsr, Curve, EffectKindDef, EffectSpec, PaletteEntry, RgbEnvelope } from './types.ts';

interface CatalogueMetadata {
  id: string; name: string; desc: string; app: 'hd' | 'ldj' | 'own'; family: string;
  party?: boolean; pixel?: boolean; aliases?: string[];
  /** How long a once launch plays when the request names no length; kernel timing and macro loops are unaffected. */
  lengthBeats?: number;
}
/**
 * A legacy row names one of the fork's pattern functions, which keep rendering
 * it; it has no spec, so nothing can play it as an effect. Its `preset` points
 * the pickers at the parameterised preset it was modelled on, so they can offer
 * both. The link never redirects the id.
 */
export type CataloguePreset = CatalogueMetadata & (
  | { legacy: true; spec?: never; preset?: string }
  | { legacy?: false; spec: EffectSpec; preset?: never }
);

/** A family groups presets in the pickers; its kinds carry their recommended settings as plain data. */
export interface CatalogueFamily {
  id: string; app: 'hd' | 'ldj' | 'own'; name: string;
  kinds: { kind: string; defaults: EffectKindDef['defaults']; capabilities: EffectKindDef['capabilities']; level?: 'lamp' | 'cell'; wallClock?: true }[];
}

/** Freeze a value and everything in it: tables nobody may change at run time. */
export function deepFreeze<T>(value: T): T {
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

/**
 * Ids and aliases share one namespace with the pattern functions: a legacy row
 * is exactly one function's id, every other row stays clear of those ids, and
 * a name claimed twice is an error in the table.
 */
export function presetIndex(rows: readonly CataloguePreset[]): ReadonlyMap<string, CataloguePreset> {
  const index = new Map<string, CataloguePreset>();
  for (const row of rows) {
    const keys = [row.id, ...(row.aliases ?? [])];
    if (row.legacy && (!Object.hasOwn(PATTERN_FUNCS, row.id) || keys.length > 1)) {
      throw new Error(`legacy row ${row.id} must be exactly one pattern function's id`);
    }
    for (const key of keys) {
      if (!row.legacy && Object.hasOwn(PATTERN_FUNCS, key)) throw new Error(`catalogue id ${key} is a legacy pattern's id`);
      if (index.has(key)) throw new Error(`catalogue id ${key} is claimed twice`);
      index.set(key, row);
    }
  }
  return index;
}

export const LDJ_PRESETS: readonly CataloguePreset[] = deepFreeze(ldjPresets());

// ── Hue Dynamics ────────────────────────────────────────────────────────────

/** attack, hold, decay, sustain, release, peak: times are fractions of the loop, sustain and peak are levels. */
const env = (attack: number, hold: number, decay: number, sustain: number, release: number, peak: number): Ahdsr =>
  ({ attack, hold, decay, sustain, release, peak });
// A preset's own envelope replaces the family's whole one. What it leaves out
// keeps the envelope defaults the recommendation was built from: a white
// single colour, the default brightness and channel envelopes.
const ENVELOPE_DEFAULTS: RgbEnvelope = HD_DEFAULTS['hd.simpleAdsr'].params.rgbEnvelope!;
// The colour mode is always spelt out: the recommendation's single colour would
// otherwise turn the channel presets into one white.
const channels = (r: Ahdsr, g: Ahdsr, b: Ahdsr): RgbEnvelope => ({ ...ENVELOPE_DEFAULTS, colourMode: 'all', r, g, b });

// The seven one-beat Simple ADSR presets, with their own curve and envelope.
// Simple ADSR's id is its kind's, as a Light DJ preset's is.
const SIMPLE_ADSR: [id: string, name: string, palette: string[], curve: Curve, envelope: RgbEnvelope, desc: string][] = [
  ['hd.iceStrike', 'Ice Strike', ['#D9FFFF'], 'easeOut',
    channels(env(0.01, 0.02, 0.08, 0, 0, 0.85), env(0.01, 0.02, 0.18, 0, 0, 1), env(0.01, 0.02, 0.29, 0, 0, 1)),
    'every beat a cold white flash that sheds its red, then its green, and is dark a third of the way to the next beat'],
  // Green's explicit zero peak keeps green out entirely.
  ['hd.neonPulse', 'Neon Pulse', ['#FF00FF'], 'easeInOut',
    channels(env(0.12, 0, 0.38, 0, 0, 1), env(0, 0, 0, 0, 0, 0), env(0.12, 0, 0.58, 0, 0, 1)),
    'every beat a magenta swell, eased in and out, with no green in it; the red leaves first, so it ends in blue'],
  ['hd.colourPop', 'Colour Pop', ['#FF7050'], 'linear',
    { ...ENVELOPE_DEFAULTS, colourMode: 'singleColour', singleColour: '#FF7050', brightness: env(0.01, 0.5, 0.25, 0.25, 0, 1) },
    'every beat one colour, coral unless changed, at full for half the beat, then down to a quarter until the next'],
  ['hd.velvetBloom', 'Velvet Bloom', ['#CC1F59'], 'easeInOut',
    channels(env(0.4, 0.05, 0.1, 0.8, 0.45, 0.8), env(0.4, 0.05, 0.1, 0.12, 0.45, 0.12), env(0.2, 0.05, 0.3, 0.35, 0.45, 0.55)),
    'every beat a slow swell, blue-violet first and then rose, gone again by the next beat'],
  ['hd.solarFlare', 'Solar Flare', ['#FFD9A6'], 'easeOut',
    channels(env(0.01, 0.03, 0.5, 0.18, 0.46, 1), env(0.01, 0.03, 0.32, 0, 0, 0.85), env(0.01, 0.03, 0.09, 0, 0, 0.65)),
    'every beat a near-white flash that loses its blue, then its green, leaving a low red until the beat ends'],
  ['hd.rainbowDrop', 'Rainbow Drop', ['#FF0000', '#00CC00', '#000099'], 'easeInOut',
    channels(env(0.02, 0.03, 0.24, 0.045, 0.08, 1), env(0.3, 0, 0.32, 0, 0, 0.8), env(0.65, 0, 0.25, 0.07, 0.1, 0.6)),
    'every beat the colour travels from red through green to blue as each channel rises and falls in turn'],
  // Not the family's single-colour recommendation: the app starts this preset
  // on staggered red, green and blue, keeping the default brightness envelope.
  ['hd.simpleAdsr', 'Simple ADSR', ['#0080FF'], 'easeOut',
    channels(env(0.04, 0.08, 0.2, 0, 0.68, 1), env(0.2, 0, 0.4, 0, 0.4, 0.8), env(0.4, 0, 0, 0.6, 0.6, 0.6)),
    'every beat red, green and blue each rise and fall on an envelope of their own, the starting point for shaping one'],
];
// The nine measure presets play their family's recommendation in their own colours.
const HD_FAMILY_PRESETS: [id: string, name: string, kind: HdKind, palette: string[], desc: string][] = [
  ['hd.neonDomino', 'Neon Domino', 'hd.positionChase', ['#FF2BD6', '#7C3AED', '#22D3EE'],
    'pink, violet and cyan lamps lighting one after another in the order they stand, like falling dominoes'],
  ['hd.bassBloom', 'Bass Bloom', 'hd.radialPulse', ['#FF006E', '#FB5607', '#FFBE0B'],
    'a ring of pink, orange and gold opening from the middle of the room, fired by the bass'],
  ['hd.auroraDrift', 'Aurora Drift', 'hd.spatialWash', ['#06B6D4', '#22C55E', '#6366F1'],
    'teal, green and indigo crests rolling slowly across the room and back, whatever the music does'],
  ['hd.prismRicochet', 'Prism Ricochet', 'hd.bouncingScan', ['#F8FAFC', '#A855F7', '#06B6D4', '#F43F5E'],
    'a bright line in white, purple, cyan and rose sweeping to one side of the room and back'],
  ['hd.meteorShower', 'Meteor Shower', 'hd.streak', ['#FFFFFF', '#38BDF8', '#8B5CF6'],
    'comets in white, sky blue and violet shooting over the room on a slant, tails trailing, in either direction'],
  ['hd.starlightScatter', 'Starlight Scatter', 'hd.twinkle', ['#E0F2FE', '#C4B5FD', '#FDF4FF'],
    'about a third of the lamps lighting at random in pale blue, lilac and white, then fading'],
  ['hd.velvetBreath', 'Velvet Breath', 'hd.breathingFade', ['#581C87', '#BE185D', '#7E22CE'],
    'the whole room swelling and falling together through deep purple, magenta and violet'],
  ['hd.afterglowGate', 'Afterglow Gate', 'hd.volumeGateWash', ['#FB7185', '#F97316', '#FACC15'],
    'pink, orange and yellow across the room, brighter the louder the music, falling away slowly in the quiet'],
  ['hd.voltageConfetti', 'Voltage Confetti', 'hd.frequencyBurst', ['#FDE047', '#22D3EE', '#F472B6', '#A3E635'],
    'three lamps in four popping in yellow, cyan, pink and lime on the beat, hardest on the high end, then dying away'],
];

// validateSpec fills each row from its own copy of the family's recommendation,
// output settings included; the rows add only what the app's presets change.
function hdRow(id: string, name: string, kind: HdKind, palette: string[], desc: string, params?: { curve: Curve; rgbEnvelope: RgbEnvelope }): CataloguePreset {
  return { id, name, desc: `Hue Dynamics: ${desc}`, app: 'hd', family: kind,
    spec: validateSpec({ kind, params, palette, scope: kind === 'hd.simpleAdsr' ? 'singleBeat' : 'measure' }) };
}
const HD_PRESETS: CataloguePreset[] = [
  ...SIMPLE_ADSR.map(([id, name, palette, curve, rgbEnvelope, desc]) => hdRow(id, name, 'hd.simpleAdsr', palette, desc, { curve, rgbEnvelope })),
  ...HD_FAMILY_PRESETS.map(([id, name, kind, palette, desc]) => hdRow(id, name, kind, palette, desc)),
];

// The Disco's eleven genres from disco.ts, one copy of their data, as tuned
// for this service's audio. Their automatic strobe asks for the acknowledgement
// when it fires, so no row is marked rapid.
const DISCO_ROWS: CataloguePreset[] = DISCO_PRESETS.map(({ id, name, params }) => ({
  id, name, app: 'hd', family: 'hd.disco', spec: validateSpec({ kind: 'hd.disco', params }),
  desc: `Hue Dynamics Disco: the lamps answer the bass, the voice and the treble in hues tuned for ${name}${params.allowStrobe ? ', with the automatic strobe' : ''}`,
}));

// ── The fork's own ──────────────────────────────────────────────────────────

// The party looks keep their ids and their pattern functions (the golden test
// holds their bytes). Nine were modelled on a Hue Dynamics preset and offer it.
const OWN_LOOKS: [id: string, name: string, desc: string, preset?: string][] = [
  ['position-chase', 'Position Chase', 'A domino running across the room by position, turning a quarter every run', 'hd.neonDomino'],
  ['radial-pulse', 'Radial Pulse', 'A ring from the middle of the room out to its edge once a bar, driven by the bass', 'hd.bassBloom'],
  ['spatial-wash', 'Spatial Wash', 'A soft crest of the look\'s colours rolling across the room, turning a quarter every bar', 'hd.auroraDrift'],
  ['bounce-scan', 'Bouncing Scan', 'A bright line sweeping across the room and back every bar', 'hd.prismRicochet'],
  ['streak', 'Streak', 'A comet with a long tail across the room on two events in three, either way', 'hd.meteorShower'],
  ['starlight', 'Starlight', 'A third of the lamps light on every step, each in its own colour, and fade', 'hd.starlightScatter'],
  ['breathe', 'Breathe', 'The whole room swells and falls as one over a bar, the colour drifting round the look', 'hd.velvetBreath'],
  ['volume-gate', 'Volume Gate', 'A slow wash across the room that opens with how loud the music is', 'hd.afterglowGate'],
  ['confetti', 'Confetti', 'Three lamps in four pop in their own colours on every step, or on the kick, and die away', 'hd.voltageConfetti'],
  ['anchor-fill', 'Anchor Fill', 'The room filled corner by corner on every step, the next colour over the last'],
  ['halves', 'Halves', 'Front against back, then left against right, in A and B, swapping every other time'],
  ['flip', 'Flip', 'The four corners of the room, one diagonal in A and the other in B, swapping every step'],
  ['room-wave', 'Room Wave', 'A wave of the look\'s colours crossing the room once a bar, on a heading that turns every lap'],
  ['ring-strobe', 'Ring Strobe', 'One lamp at a time round the ring of the room, a flash on every step, never a lamp over five a second'],
  ['ring-backlit', 'Ring Backlit', 'The ring strobe with the rest of the room parked on colour B'],
  ['fireworks', 'Fireworks', 'A burst on one lamp on every step, spreading to its neighbours and dying away over a bar'],
  ['flashes', 'Flashes', 'A third of the lamps, drawn afresh on every step, flash hard and are cut'],
  ['swirl', 'Swirl', 'The look\'s colours laid round the room by angle and turning, a turn every eight steps'],
];
const OWN_ROWS: CataloguePreset[] = OWN_LOOKS.map(([id, name, desc, preset]) =>
  ({ id, name, desc, app: 'own', family: 'own.party', party: true, legacy: true, ...(preset ? { preset } : {}) }));

// The energy pads and the API's energy effects, under the ids they have always
// had. Labels are the ones the pads show.
const ENERGY_LABELS: Record<keyof typeof ENERGY_KIND_BY_ID, [name: string, desc: string]> = {
  'white-strobe': ['White Strobe', 'Cold white, fastest strobe'],
  'color-strobe': ['Colour Strobe', 'Colour A, fastest strobe'],
  blinder: ['Blinder', 'Every emitter at full — the brightest the rig goes'],
  'uv-wash': ['UV Wash', 'Blacklight — UV alone, no strobe'],
  kill: ['Kill', 'Everything out for as long as it is held'],
  glow: ['Glow', 'A soft lift in the current colour — the accent quiet music can take'],
};
const CONTROL_ROWS: CataloguePreset[] = [
  ...Object.entries(ENERGY_KIND_BY_ID).map(([alias, kind]): CataloguePreset => {
    const [name, desc] = ENERGY_LABELS[alias as keyof typeof ENERGY_KIND_BY_ID];
    return { id: kind, name, desc, app: 'own', family: 'own.energy', aliases: [alias], spec: validateSpec({ kind }) };
  }),
  // The hold-to-strobe pad of the Hue party apps: the strobe kind flashing the
  // look's own colours (no palette) on the beat grid at the five-a-second cap,
  // the running look showing through between flashes. The manual strobe keeps
  // its own white and rate; `strobe` itself stays the upstream pattern's id.
  { id: 'palette-strobe', name: 'Palette Strobe', desc: 'Flashes in the look\'s colours on the beat over the running look, up to five a second',
    app: 'own', family: 'own.energy',
    spec: validateSpec({ kind: 'strobe', palette: null, params: { clock: 'beat', flashesPerSecond: 5, continueBetween: true } }) },
];

/** Light DJ's rows, Hue Dynamics' sixteen, the eleven Disco genres, the fork's own looks, then the energy controls. */
export const CATALOGUE: readonly CataloguePreset[] = deepFreeze([...LDJ_PRESETS, ...HD_PRESETS, ...DISCO_ROWS, ...OWN_ROWS, ...CONTROL_ROWS]);
const INDEX = presetIndex(CATALOGUE);

/** A built-in preset by id or alias. */
export function presetById(id: string): CataloguePreset | null {
  return INDEX.get(id) ?? null;
}

/**
 * The effect an energy burst plays as, in the renderer and the preview alike:
 * the six energies' own kinds and the hold strobe's control row. Null for
 * any other id.
 */
export function energyEffectSpec(energy: string): EffectSpec | null {
  const id = energy === HOLD_STROBE ? HOLD_STROBE
    : Object.hasOwn(ENERGY_KIND_BY_ID, energy) ? ENERGY_KIND_BY_ID[energy as keyof typeof ENERGY_KIND_BY_ID] : null;
  const row = id ? presetById(id) : null;
  return row && !row.legacy ? row.spec : null;
}

/** A family lists the kinds its rows play, plus any extra; a legacy row plays none. */
function family(id: string, app: CatalogueFamily['app'], name: string, extra: string[] = []): CatalogueFamily {
  const kinds = [...new Set([...CATALOGUE.flatMap((p) => (p.legacy || p.family !== id ? [] : [p.spec.kind])), ...extra])];
  return { id, app, name, kinds: kinds.map((kind) => {
    const def = kindOf(kind)!;
    return { kind, defaults: plain(def.defaults), capabilities: def.capabilities ? plain(def.capabilities) : null,
      ...(def.requirements ? { requirements: def.requirements } : {}), ...(def.level ? { level: def.level } : {}), ...(def.wallClock ? { wallClock: true as const } : {}) };
  }) };
}
const ldjFamily = (engine: LdjEngine | 'macro', extra?: string[]) => family(`ldj.${engine}`, 'ldj', FAMILY[engine].name, extra);
// Hue Dynamics' families are its kinds, under the names the app shows.
const HD_FAMILY_NAMES: Record<HdKind, string> = {
  'hd.simpleAdsr': 'Simple ADSR', 'hd.positionChase': 'Position Chase', 'hd.radialPulse': 'Radial Pulse', 'hd.spatialWash': 'Spatial Wash',
  'hd.bouncingScan': 'Bouncing Scan', 'hd.streak': 'Streak', 'hd.twinkle': 'Twinkle', 'hd.breathingFade': 'Breathing Fade',
  'hd.volumeGateWash': 'Volume Gate Wash', 'hd.frequencyBurst': 'Frequency Burst',
};

// The touch board renders through the matrix family's kinds and has no preset of its own.
// The Scene Maker family lists the macro kind and the firework renderer its Fireworks row plays.
export const FAMILIES: readonly CatalogueFamily[] = deepFreeze([
  ldjFamily('channel'), ldjFamily('iteration'), ldjFamily('rotation'), ldjFamily('wave'), ldjFamily('matrix', ['ldj.matrixBoard']),
  ldjFamily('studio'), ldjFamily('visualizer'), ldjFamily('bitmap'), ldjFamily('macro'),
  ...(Object.keys(HD_DEFAULTS) as HdKind[]).map((kind) => family(kind, 'hd', HD_FAMILY_NAMES[kind])),
  family('hd.disco', 'hd', 'Disco'),
  family('own.party', 'own', 'Party Looks'), family('own.energy', 'own', 'Energy'),
]);

const HD_PALETTES: BuiltinPalette[] = [
  { id: 'hdDefault', app: 'hd', colours: ['#A855F7', '#22D3EE', '#F472B6'] },
  { id: 'hdStrobe', app: 'hd', colours: ['#FFFFFF'] },
];
/** Light DJ's 26 seeded palettes, then Hue Dynamics' default and its strobe's white. */
export const BUILTIN_PALETTES: readonly BuiltinPalette[] = deepFreeze([...LDJ_PALETTES, ...HD_PALETTES]);
