// Every member of Light DJ's effect-type list, by ordinal, and what the port
// makes of it. The catalogue is checked against this table rather than against
// its own lists, so an effect the port forgot shows up as a missing preset.
// Members that are not effects are recorded by ordinal and description only.

import { BITMAP_PATTERNS } from './ldj-bitmap.ts';
import type { EffectCommand } from './types.ts';

/** The renderer family a Light DJ preset belongs to; its catalogue family is `ldj.<engine>`. */
export type LdjEngine = 'channel' | 'iteration' | 'rotation' | 'wave' | 'matrix' | 'studio' | 'visualizer' | 'bitmap';

export type LdjClass =
  | { name: string; kind: 'preset'; id: string; engine: LdjEngine }
  | { name: string; kind: 'macro'; id: string }
  | { name: string; kind: 'engineCommand'; command: EffectCommand }
  /** `presets`: the presets a carrier stands for, where it has any. */
  | { kind: 'internal'; description: string; presets?: readonly string[] }
  | { name: string; kind: 'outOfScope'; reason: 'nanoleaf' | 'dead' };

const preset = (engine: LdjEngine) => (name: string): LdjClass => ({ name, kind: 'preset', id: `ldj.${name}`, engine });
const ch = preset('channel'), it = preset('iteration'), rot = preset('rotation'), wave = preset('wave');
const mx = preset('matrix'), studio = preset('studio');
const vis = (name: string, mode: string): LdjClass => ({ name, kind: 'preset', id: `ldj.visualizer.${mode}`, engine: 'visualizer' });
const macro = (name: string): LdjClass => ({ name, kind: 'macro', id: `ldj.${name}` });
const command = (name: string, cmd: EffectCommand): LdjClass => ({ name, kind: 'engineCommand', command: cmd });
const internal = (description: string, presets?: readonly string[]): LdjClass =>
  presets ? { kind: 'internal', description, presets } : { kind: 'internal', description };
// Nanoleaf-only effects never reach a lamp of this rig; the dead ones have a
// renderer in the app that nothing ever starts.
const nanoleaf = (name: string): LdjClass => ({ name, kind: 'outOfScope', reason: 'nanoleaf' });
const dead = (name: string): LdjClass => ({ name, kind: 'outOfScope', reason: 'dead' });

const ROWS: LdjClass[] = [
  /* 0 */ vis('VisualizerFirework', 'firework'), vis('VisualizerFlash', 'flash'), vis('VisualizerSplotch', 'splotch'),
  vis('VisualizerPulse', 'pulse'), vis('VisualizerSolid', 'solid'), vis('VisualizerSwirl', 'swirl'), vis('VisualizerWave', 'wave'),
  /* 7 */ it('MatrixCycle'), mx('MatrixFirework'), mx('MatrixPulse'), mx('MatrixFlash'), mx('MatrixSplotch'), ch('MatrixSolid'),
  /* 13 */ ch('StrobeCycle'), mx('PartyStrobe'), rot('Swirl'), ch('GrowCycle'), ch('FadeCycle'), macro('Fireworks'), ch('Drip'),
  /* 20 */ ch('Glow'), ch('Blur'), ch('Split'), ch('Flip'), ch('CrossFade'), wave('GrooveWave'), ch('FillCycle'), ch('SoftStrobe'),
  /* 28 */ ch('QuickFlash'), wave('BigRoomWave'), ch('DoubleFill'), wave('Ascent'), wave('DoubleWave'), wave('Impact'),
  /* 34 */ wave('Swagger'), wave('Vortex'), dead('Tap'), dead('TapFade'), dead('TapPulse'),
  /* 39 */ internal('Stops every running effect, and stands for nothing playing; not an effect'),
  /* 40 */ ch('SceneMakerFirework'), ch('America'), ch('FrontBack'), ch('Cauldron'), it('Circuit'), ch('TriPulse'), ch('Sketch'),
  /* 47 */ it('ScatterStrobe'), ch('DoSiDo'), ch('DoubleDrip'), rot('Rotation'), ch('Trance'), ch('BeatPulse1'), ch('BeatPulse4'),
  /* 54 */ macro('BigRoomMix'), macro('House'), macro('Electro'), macro('Techno'), macro('Dubstep'), macro('DrumAndBass'),
  /* 60 */ nanoleaf('Highlight'), nanoleaf('Explode'), nanoleaf('Lightning'),
  /* 63 */ internal('Marks a lamp that no effect is driving; not an effect'),
  /* 64 */ nanoleaf('Confetti'), nanoleaf('Blooms'), nanoleaf('BeatWave'), nanoleaf('Zin'), nanoleaf('Zout'),
  /* 69 */ it('PaletteStrobe'), it('PaletteTrail'), it('PaletteFill'), it('BLStrobeCycle'), it('BLGrowCycle'), it('BLFadeCycle'),
  /* 75 */ it('ScatterFill'), it('ScatterFade'), it('ScatterGrow'), it('BLScatterFade'), it('BLScatterStrobe'), it('BLScatterGrow'),
  /* 81 */ it('DubstepStrobe'), it('DAndBStrobe'), it('HouseStrobe'), it('ElectroStrobe'), it('TechnoStrobe'),
  /* 86 */ nanoleaf('Scan'), nanoleaf('Rivers'), nanoleaf('Rainfall'), it('TrueStrobe'), nanoleaf('Pong'),
  /* 91 */ internal('A saved effect whose type this version cannot read; it never plays'),
  /* 92 */ macro('Blackout'), it('DoubleFillStrobe'), it('DoubleStrobeCycle'), it('DoubleScatterStrobe'),
  /* 96 */ it('BrtSinStrobe'), it('BrtSinScatter'), it('ThreeStageStrobe'), it('ThreeStageFade'), it('ThreeStageFlare'),
  /* 101 */ it('ThreeStageGlow'), it('ThreeStageFill'), it('FiveStageFlare'), it('FiveStageGlow'), it('FiveStageFill'),
  /* 106 */ it('FiveStageStrobe'), it('FiveStageFade'), it('SMStudioN1Pulse'), it('SMStudioN2Pulse'), it('SMStudioN3Pulse'),
  /* 111 */ it('SMStudioN4Pulse'), it('SMStudioN5Pulse'), it('SMStudioN2PulseMulti'), it('SMStudioN3PulseMulti'),
  /* 115 */ it('SMStudioN4PulseMulti'), it('SMStudioN5PulseMulti'), ch('SMStudioN1Fill'), ch('SMStudioN2Fill'), ch('SMStudioN3Fill'),
  /* 120 */ ch('SMStudioN4Fill'), ch('SMStudioN5Fill'), rot('Perlin'), nanoleaf('Snake'), nanoleaf('SnakeFill'),
  /* 125 */ rot('NorthernLights'), rot('Beacon'), nanoleaf('FillFromInside'), nanoleaf('FillFromOutside'),
  /* 129 */ it('ThreeStrobeAndFade'), it('Popcorn'), ch('RotatingHalfs'), ch('TwoCorners'), it('FlareAndBreak'),
  /* 134 */ it('PaletteTrueStrobe'), it('PaletteDrip'), it('PaletteGlow'), it('PaletteFlare'), it('PalettePartyStrobe'),
  /* 139 */ it('PaletteSplit'), it('ThreeStageStrobeMod'), it('ThreeStageFadeMod'), it('ThreeStageFlareMod'),
  /* 143 */ studio('StudioN1'),
  /* 144 */ internal('The Studio engine\'s own entry; its notes and backgrounds are the Studio presets'),
  /* 145 */ studio('StudioN2'), studio('StudioN3'), studio('StudioN4'), studio('StudioN5'),
  /* 149 */ studio('StudioC1'), studio('StudioC2'), studio('StudioC3'), studio('StudioC4'), studio('StudioC5'),
  /* 154 */ studio('Studio5x1'), studio('Studio5x2'), studio('Studio5x3'), studio('Studio5x4'), studio('Studio5x5'),
  /* 159 */ studio('StudioSwirl'), studio('StudioWave'), command('StudioStop', 'stop'), studio('StudioFireworks'),
  /* 163 */ studio('StudioFlashes'), command('ComboBreak', 'comboBreak'), command('ToggleDirection', 'toggleDirection'),
  /* 166 */ command('FadeToBaseline', 'fadeToBaseline'), command('SetPulserBaselineColor', 'setPulserBaselineColor'),
  /* 168 */ internal('Opens the connection to the lamps before the first effect plays; draws nothing'),
  /* 169 */ internal('The bitmap engine; each of its patterns is a preset', BITMAP_PATTERNS.map((pattern) => `ldj.bitmap.${pattern}`)),
  /* 170 */ internal('Carries sequence commands (go to a sheet or playlist, set the palette, tempo or brightness), which belong to the sequencer'),
  /* 171 */ internal('A player for 3-D volumetric animations; not supported'),
];

const freeze = (row: LdjClass): LdjClass => Object.freeze(row.kind === 'internal' && row.presets
  ? { ...row, presets: Object.freeze([...row.presets]) } : row);

/** Ordinals 0..171 of Light DJ's effect-type list. */
export const LDJ_IDS: Readonly<Record<number, LdjClass>> = Object.freeze(Object.fromEntries(ROWS.map((row, i) => [i, freeze(row)])));
