// The effect model both party apps are ported into: a spec names a kind and
// its parameters, a kind renders one instance of it per frame into slots.
// Browser-safe: the engine, the worker and the preview share it.

import type { ZodType } from 'zod';
import type { Colour } from '../../types/rig.ts';
import type { Room } from '../room.ts';
import type { AudioFrame } from './audio-frame.ts';
import type { PaletteAccess } from './palette.ts';

export type Curve = 'linear' | 'easeIn' | 'easeOut' | 'easeInOut' | 'cut';
export type Direction = 'forward' | 'reverse' | 'alternate' | 'random';
export type LightOrder = 'position' | 'track' | 'random';
export type Band = 'full' | 'bass' | 'mid' | 'high';
export type TriggerMode = 'timeline' | 'beatAccent' | 'volumeGate';
export type AudioMode = 'off' | 'tempo' | 'reactive';

export interface Spatial { x: number; y: number; z: number; radius: number; angle: number }
export interface Trigger { mode: TriggerMode; band: Band; beatInterval: number; threshold: number; reactiveDepth: number }
/** Times are fractions of the loop; sustain and peak are levels, 0..1. Missing peak means full. */
export interface Ahdsr { attack: number; hold: number; decay: number; sustain: number; release: number; peak?: number }
export interface RgbEnvelope { colourMode: 'all' | 'singleColour'; singleColour: string; r: Ahdsr; g: Ahdsr; b: Ahdsr; brightness: Ahdsr }

/** Hue Dynamics Party's settings, shared by all ten of its families. */
export interface HdParams {
  curve: Curve; attack: number; hold: number; release: number; stagger: number; direction: Direction; order: LightOrder;
  probability: number; repetitions: number; trail: number; spatial: Spatial; trigger: Trigger; loopLength: number | null;
  rgbEnvelope?: RgbEnvelope | null;
}

/** Nested controls have separate applicability: a family can use an angle without a radius. */
export type HdCapability = keyof HdParams | `spatial.${keyof Spatial}` | `trigger.${keyof Trigger}`;

/** Specs keep hex colours on the wire; a `random` entry stays a sentinel until an instance rolls it. */
export type PaletteEntry = string | { random: true };
/** Fixed colours are parsed once when preparing an instance, never written back into its spec. */
export type ParsedPaletteEntry = Colour | { random: true };

export interface EffectSpec {
  kind: string;
  params: Record<string, unknown>;
  palette?: PaletteEntry[] | null;
  brightness?: number;
  rapidFlash?: boolean;
  minFlashIntervalMs?: number;
  scope?: 'singleBeat' | 'measure';
}

/**
 * One slot's output. level 0..1 before brightness; strength 0 = transparent; strobe = a fixture strobe-channel value (energy kinds).
 * kind: the kind that drew the slot where that is not the rendered instance's own. A macro's slots name their step's kind, so
 * Hue Dynamics' flash guard, which covers its own kinds only, still finds an hd.* step inside a macro. Absent: the instance's kind.
 */
export interface EffectSlot { colour: Colour; level: number; strength: number; strobe?: number; kind?: string }

export interface HdMaster {
  sensitivity: number; smoothing: number; attackMs: number; releaseMs: number;
  /** Hue Dynamics' volume threshold. */
  threshold: number;
  reactiveDepth: number; brightness: number;
}
export const HD_MASTER_DEFAULTS: HdMaster = { sensitivity: 0.5, smoothing: 0.35, attackMs: 30, releaseMs: 220, threshold: 0.15, reactiveDepth: 1, brightness: 1 };

/** 128 bits as four unsigned 32-bit words. */
export type Seed = [number, number, number, number];

/** Pure operations on an initialized Studio or visualizer instance. */
export type EffectCommand = 'stop' | 'comboBreak' | 'toggleDirection' | 'fadeToBaseline' | 'setPulserBaselineColor';

export interface EffectFrame {
  beatPos: number; bpm: number; nowMs: number; dtMs: number; anchorBeat: number;
  /** Instance launch time for wall-clock effects; optional for hand-built frames. */
  startedAtMs?: number;
  /** The spec being rendered (scope, brightness, rapidFlash, minFlashIntervalMs live here, not in params). */
  spec: EffectSpec;
  /** Resolved for this instance by renderEffect: paletteOverride → spec.palette (random entries rolled with `roll`) → lookPalette. */
  palette: Colour[]; lookPalette: Colour[]; paletteOverride: Colour[] | null; roll: number;
  /** Runtime-only access; ordered colour refreshes become visible on the next render. */
  paletteAccess?: PaletteAccess;
  audio: AudioFrame | null; audioMode: AudioMode; master: HdMaster; seed: Seed; acknowledged: boolean; hueStrobe: 'flash' | 'pulse';
  /** Fixture id per room slot, repeated on each cell of one fixture; Disco's manual bands are keyed by it. Absent: the slot index. */
  fixtureIds?: readonly (number | string)[];
  /** A manual strobe (hold, burst or latch) runs: Disco's automatic strobe stands down. Absent: false. */
  manualStrobeActive?: boolean;
  /** The look's smoothed expression level, 0..1, which energy.glow rides on its own curve. Absent: 1. */
  expressionLevel?: number;
  /** The rendering instance's id, filled by renderEffect; a macro names its steps' states after it. */
  instanceId?: string;
}
/** What callers hand renderEffect; it fills in the rest per instance. */
export type FrameBase = Omit<EffectFrame, 'spec' | 'palette' | 'roll'>;

export interface EffectKindDef<P = unknown, S = unknown> {
  kind: string; app: 'hd' | 'ldj' | 'own'; schema: ZodType<P>;
  /** Defaults as a spec fragment, so the recommended palette and output settings travel with the parameters. */
  defaults: { params: P; palette?: PaletteEntry[] | null; brightness?: number; rapidFlash?: boolean; minFlashIntervalMs?: number; scope?: 'singleBeat' | 'measure' };
  capabilities?: Partial<Record<HdCapability, boolean>> | null;
  rapidFlash?: boolean; stateful?: boolean; rideLevel?: boolean;
  /** Steps on the wall clock: `params.cadence` changes nothing, and an editor leaves it out. */
  wallClock?: boolean;
  /** Additional parameter-dependent acknowledgement shared by rendering and admission. */
  rapidFlashWhen?(params: P): boolean;
  /**
   * Whether the spec keeps its flash rate under its limit by state of its own
   * (the strobe's permit, Disco's automatic strobe). A fresh instance starts
   * that limit again, so such a spec never plays where each lap or step is a
   * fresh instance: a macro's steps, a sequence's clips.
   */
  pacesOwnFlashes?(params: P): boolean;
  command?(state: S, cmd: EffectCommand, arg?: Colour): void;
  /** Whole-palette rerolls remain available alongside selective refreshes; the renderer reads this after state initialization. */
  rollOf?(state: S): number;
  init(params: P, room: Room, frame: EffectFrame): S;
  render(params: P, state: S, room: Room, frame: EffectFrame, out: EffectSlot[]): void;
}
