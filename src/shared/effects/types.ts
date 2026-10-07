import type { ZodType } from 'zod';
import type { Colour } from '../../types/rig.ts';
import type { LampRoom, Room } from '../room.ts';
import type { AudioFrame } from './audio-frame.ts';
import type { PaletteAccess } from './palette.ts';
import type { GradientSettings, ResolvedGradient } from '../palette-model.ts';
export type { PaletteEntry } from '../palette-model.ts';
import type { PaletteEntry } from '../palette-model.ts';

export type Curve = 'linear' | 'easeIn' | 'easeOut' | 'easeInOut' | 'cut';
export type Direction = 'forward' | 'reverse' | 'alternate' | 'random';
export type LightOrder = 'position' | 'track' | 'random';
export type Band = 'full' | 'bass' | 'mid' | 'high';
export type TriggerMode = 'timeline' | 'beatAccent' | 'volumeGate';
export type AudioMode = 'off' | 'tempo' | 'reactive';

export interface Spatial { x: number; y: number; z: number; radius: number; angle: number }
export interface Trigger { mode: TriggerMode; band: Band; beatInterval: number; threshold: number; reactiveDepth: number }
// Envelope times are loop fractions; sustain and peak are levels in 0..1.
export interface Ahdsr { attack: number; hold: number; decay: number; sustain: number; release: number; peak?: number }
export interface RgbEnvelope { colourMode: 'all' | 'singleColour'; singleColour: string; r: Ahdsr; g: Ahdsr; b: Ahdsr; brightness: Ahdsr }

export interface HdParams {
  curve: Curve; attack: number; hold: number; release: number; stagger: number; direction: Direction; order: LightOrder;
  probability: number; repetitions: number; trail: number; spatial: Spatial; trigger: Trigger; loopLength: number | null;
  rgbEnvelope?: RgbEnvelope | null;
}

// Nested capabilities are separate because a family can use angle without radius.
export type HdCapability = keyof HdParams | `spatial.${keyof Spatial}` | `trigger.${keyof Trigger}`;

// Parsed colours stay outside specs so wire data remains serializable.
export type ParsedPaletteEntry = Colour | { random: true };

export interface EffectSpec extends GradientSettings {
  kind: string;
  params: Record<string, unknown>;
  palette?: PaletteEntry[] | null;
  brightness?: number;
  rapidFlash?: boolean;
  minFlashIntervalMs?: number;
  scope?: 'singleBeat' | 'measure';
}

// Slot kind preserves the innermost family so safety guards also cover macro steps.
export interface EffectSlot { colour: Colour; level: number; strength: number; strobe?: number; kind?: string }

export interface HdMaster {
  sensitivity: number; smoothing: number; attackMs: number; releaseMs: number;
  threshold: number;
  reactiveDepth: number; brightness: number;
}
export const HD_MASTER_DEFAULTS: HdMaster = { sensitivity: 0.5, smoothing: 0.35, attackMs: 30, releaseMs: 220, threshold: 0.15, reactiveDepth: 1, brightness: 1 };

// The seed is four unsigned 32-bit words.
export type Seed = [number, number, number, number];

export type EffectCommand = 'stop' | 'comboBreak' | 'toggleDirection' | 'fadeToBaseline' | 'setPulserBaselineColor';

export interface EffectFrame {
  gradient?: ResolvedGradient | null;
  lookGradient?: GradientSettings | null;
  overrideGradient?: GradientSettings | null;
  beatPos: number; bpm: number; nowMs: number; dtMs: number; anchorBeat: number;
  startedAtMs?: number;
  spec: EffectSpec;
  // Override precedes spec palette and look slots; random entries resolve per instance.
  palette: Colour[]; lookPalette: Colour[]; paletteOverride: Colour[] | null; roll: number;
  // Refreshes appear next render so all samples in one render see the same palette.
  paletteAccess?: PaletteAccess;
  audio: AudioFrame | null; audioMode: AudioMode; master: HdMaster; seed: Seed; acknowledged: boolean; hueStrobe: 'flash' | 'pulse';
  // Ids follow the kind's level: one per lamp, repeated per cell for pixel kinds.
  fixtureIds?: readonly (number | string)[];
  // Manual strobe activity suppresses Disco automatic strobes.
  manualStrobeActive?: boolean;
  expressionLevel?: number;
  instanceId?: string;
}
export type FrameBase = Omit<EffectFrame, 'spec' | 'palette' | 'roll' | 'gradient'>;

export interface EffectKindDef<P = unknown, S = unknown> {
  level?: 'lamp' | 'cell';
  renderCells?(params: P, state: S, room: LampRoom, frame: EffectFrame, out: EffectSlot[]): void;
  kind: string; app: 'hd' | 'ldj' | 'own'; schema: ZodType<P>;
  defaults: GradientSettings & { params: P; palette?: PaletteEntry[] | null; brightness?: number; rapidFlash?: boolean; minFlashIntervalMs?: number; scope?: 'singleBeat' | 'measure' };
  capabilities?: Partial<Record<HdCapability, boolean>> | null;
  rapidFlash?: boolean; stateful?: boolean; rideLevel?: boolean;
  // Wall-clock kinds ignore cadence, so the editor must omit it.
  wallClock?: boolean;
  // Pattern bundles are server-built; public validation must not accept them.
  internal?: boolean;
  rapidFlashWhen?(params: P): boolean;
  // Fresh instances reset self-paced flash limits, so macros and clips must reject them.
  pacesOwnFlashes?(params: P): boolean;
  command?(state: S, cmd: EffectCommand, arg?: Colour): void;
  rollOf?(state: S): number;
  init(params: P, room: Room, frame: EffectFrame): S;
  render(params: P, state: S, room: Room, frame: EffectFrame, out: EffectSlot[]): void;
}
