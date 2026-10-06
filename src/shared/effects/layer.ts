// The effects on the rig: a base effect in place of the look's pattern, and
// voices over it, each launched on fixtures and laid over the base by tier and
// launch. The server's renderer and the rehearsal preview compose through
// these, on the cells of the rig's layouts, so the two cannot drift.
// Browser-safe: nothing here reads server state.

import { renderEffect } from './render.ts';
import { roomOf } from '../room.ts';
import type { Colour } from '../../types/rig.ts';
import type { Layout, Rig } from '../rig.ts';
import type { Room } from '../room.ts';
import type { EffectInstance, EffectStepper } from './stepper.ts';
import type { EffectSlot, EffectSpec, FrameBase, Seed } from './types.ts';

/** One launched voice, as the renderer is handed it. Times are on the renderer's clock. */
export interface VoiceFrame {
  id: string;
  spec: EffectSpec;
  /** Fixture ids; null covers the rig. An id no fixture has covers nothing. */
  targets: number[] | null;
  tier: 'strobe' | 'voice';
  launchSeq: number;
  startedAtMs: number;
  /** Ends at this time (half-open); null runs until it is taken away. */
  untilMs: number | null;
  anchorBeat: number;
  seed: Seed;
  /**
   * Stays on the global beat grid when the music jumps (a new epoch), where
   * any other voice moves its anchor to the beat it is in: the energy
   * endpoints' voices, played as the energy burst always was.
   */
  holdsGrid?: boolean;
}

/** A value's canonical text: objects with their keys sorted, so a rebuilt snapshot compares equal. */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
}

/** What makes an effect the same effect: its kind and every setting but its colours and brightness. */
export function effectContentKey(spec: EffectSpec): string {
  return canonical({ kind: spec.kind, params: spec.params ?? null, scope: spec.scope ?? null,
    minFlashIntervalMs: spec.minFlashIntervalMs ?? null, rapidFlash: spec.rapidFlash ?? null });
}

/** What makes a launch new under a voice's id: its launch fields and content. The strobe's never is, so its permit carries on. */
export function voiceLaunchKey(v: VoiceFrame): string {
  return v.spec.kind === 'strobe' ? 'strobe' : canonical([v.launchSeq, v.startedAtMs, v.seed, effectContentKey(v.spec)]);
}

/** A voice id's launch as the renderer and the preview keep it, and the musical anchor it plays from. */
export interface VoiceRecord { launch: string; kind: string; wireAnchor: number; anchor: number; epoch: number }

/**
 * The anchor a voice plays from this frame, keeping its record: a new launch
 * under its id starts its state again (a strobe keeps its permit), a changed
 * wire anchor takes it, and a new clock epoch (the music jumped) moves it to
 * the start of the beat the music is now in, `beatNow`, unless `holdsGrid`:
 * the hold strobe keeps the global beat grid it has always flashed on.
 */
export function voiceAnchor(records: Map<string, VoiceRecord>, stepper: EffectStepper, v: VoiceFrame, launch: string, epoch: number,
  beatNow: number, holdsGrid: boolean): number {
  const kind = v.spec.kind;
  let rec = records.get(v.id);
  if (!rec || rec.launch !== launch || rec.kind !== kind) {
    if (!(kind === 'strobe' && (!rec || rec.kind === 'strobe'))) stepper.forget(v.id);
    rec = { launch, kind, wireAnchor: v.anchorBeat, anchor: v.anchorBeat, epoch };
    records.set(v.id, rec);
  } else if (rec.wireAnchor !== v.anchorBeat) {
    rec.wireAnchor = rec.anchor = v.anchorBeat;
    rec.epoch = epoch;
  } else if (rec.epoch !== epoch) {
    if (!holdsGrid) rec.anchor = Math.floor(beatNow + 1e-9);
    rec.epoch = epoch;
  }
  return rec.anchor;
}

/**
 * The base effect launched again under a new key: the strobe hands its state
 * on to the new id, so its per-lamp permit carries through a relaunch or an
 * edit (or relaunching a strobe look would outrun its cap); anything else
 * starts afresh, with nothing of the old id's left.
 */
export function relaunchEffect(stepper: EffectStepper, previous: { id: string; kind: string } | null, id: string, kind: string): void {
  if (previous && previous.kind === 'strobe' && kind === 'strobe') stepper.move(previous.id, id);
  else {
    if (previous) stepper.forget(previous.id);
    stepper.forget(id);
  }
}

/**
 * One strobe voice taking over from another (the manual strobe from the
 * energy endpoints', a hold over a latch, either way round): a strobe voice
 * with no state yet takes that of the strobe voice last played and now gone,
 * so the permit carries through the handover as through a relaunch. `trail`
 * is the caller's: the strobe voice ids whose state the stepper still has.
 */
export function handOverStrobes(stepper: EffectStepper, trail: Set<string>, playing: readonly VoiceFrame[]): void {
  const now = new Set<string>();
  for (const v of playing) if (v.spec.kind === 'strobe') now.add(v.id);
  for (const id of trail) if (stepper.seenAt(id) === null) trail.delete(id);
  for (const id of now) {
    if (stepper.seenAt(id) === null) {
      let from: string | null = null, seen = -Infinity;
      for (const gone of trail) {
        const at = now.has(gone) ? null : stepper.seenAt(gone);
        if (at !== null && at > seen) { from = gone; seen = at; }
      }
      if (from !== null) { stepper.move(from, id); trail.delete(from); }
    }
    trail.add(id);
  }
}

/** What a voice's priority reads. */
export type VoiceRank = Pick<VoiceFrame, 'tier' | 'launchSeq' | 'startedAtMs'> & { targets: readonly unknown[] | null };

/**
 * The renderer's order among voices, highest first: the strobe tier, then the
 * later launch, then one launched on chosen fixtures over one on the whole
 * rig, then the later start. A stable sort keeps the order given for the rest.
 * The audio detectors pick their owner in this same order.
 */
export function voiceOrder(a: VoiceRank, b: VoiceRank): number {
  return Number(b.tier === 'strobe') - Number(a.tier === 'strobe') || b.launchSeq - a.launchSeq
    || Number(b.targets !== null) - Number(a.targets !== null) || b.startedAtMs - a.startedAtMs;
}

// Hue Dynamics' Party families, the only kinds its per-lamp flash limit covers:
// Disco's strobes have their own rate and are exempt, as in the app.
const HD_GUARDED = new Set(['hd.simpleAdsr', 'hd.positionChase', 'hd.radialPulse', 'hd.spatialWash', 'hd.bouncingScan',
  'hd.streak', 'hd.twinkle', 'hd.breathingFade', 'hd.volumeGateWash', 'hd.frequencyBurst']);

/** Does Hue Dynamics' 350 ms limit cover what this kind draws. */
export function hdGuarded(kind: string | null | undefined): boolean {
  return !!kind && HD_GUARDED.has(kind);
}

/** The room the effects play over on a layout's cells: one slot per cell, in the layout's order. */
export function effectRoom(layout: Layout): Room {
  const { list, xs, ys, plan, noFlash } = layout.units;
  return roomOf({ fixtureCount: list.length, xs, ys, plan, noFlash });
}

/** The layout voices play on: every fixture, the whole stage, whatever the look's split and pixel map. */
export function voiceLayout(rig: Rig): Layout {
  return rig.layout(null, 'stage');
}

/** Receives each unit of the base effect, with the kind that drew it (null for the black under a transparent slot). */
export type EffectLayerSet = (unit: number, colour: Colour, dim: number, strobe: number, kind: string | null) => void;

const BLACK: Colour = { r: 0, g: 0, b: 0, w: 0, a: 0, uv: 0 };
// renderEffect writes each slot it covers afresh; one it leaves empty is transparent.
const unwritten = (n: number): EffectSlot[] => new Array<EffectSlot>(n);

/**
 * The base effect on a layout's cells. Every cell is written: a slot the
 * effect leaves transparent, or a kind that is gated or unknown, is black,
 * so nothing the layer held before shows through.
 */
export function renderEffectLayer(rig: Rig, layout: Layout, frame: FrameBase, instance: EffectInstance, stepper: EffectStepper,
  set: EffectLayerSet, prepare?: (state: unknown) => void): void {
  const { list } = layout.units;
  // An empty layout has no room: no kind is initialized for it.
  if (!list.length) return;
  const room = effectRoom(layout);
  const out = unwritten(room.n);
  renderEffect(instance, frame, room, stepper, out, prepare);
  for (let k = 0; k < list.length; k++) {
    const slot = out[k] as EffectSlot | undefined;
    if (slot && slot.strength > 0) set(list[k], slot.colour, 255 * slot.level, slot.strobe ?? 0, slot.kind ?? instance.spec.kind);
    else set(list[k], BLACK, 0, 0, null);
  }
}

/** The slots a voice's fixture ids cover on a layout: every cell of each fixture named. */
export function voiceSlots(targets: readonly number[] | null, fixtureIds: FrameBase['fixtureIds'], n: number): number[] | null {
  if (targets === null) return null;
  // Without the slots' fixture ids nothing can be matched; a slot index is never a fixture id.
  if (!fixtureIds) return [];
  const wanted = new Set<number | string>(targets);
  const slots: number[] = [];
  for (let k = 0; k < n; k++) if (wanted.has(fixtureIds[k])) slots.push(k);
  return slots;
}

export interface VoiceOptions {
  /** Voices admitted without the acknowledgement: the renderer's compatibility energy for an input that carries no safety at all. */
  admit?: ReadonlySet<VoiceFrame>;
}

/**
 * Every voice on a layout's cells, and per cell the slot of the voice on top
 * there, or null where none draws (the base shows). Strength is ownership: a
 * black slot at strength 1 hides the base. Each winning slot names the kind
 * that drew it (`kind`), so the caller can tell Hue Dynamics' cells apart.
 *
 * Voices of the strobe kind hold a lamp by covering it, not by drawing on it:
 * where two cover one lamp only the higher plays there, so one strobe's
 * five-a-second permit governs each lamp and two can never interleave.
 */
export function renderVoices(rig: Rig, layout: Layout, frame: FrameBase, voices: readonly VoiceFrame[], stepper: EffectStepper,
  options: VoiceOptions = {}): (EffectSlot | null)[] {
  const n = layout.units.list.length;
  const winners: (EffectSlot | null)[] = new Array(n).fill(null);
  if (!n || !voices.length) return winners;
  const room = effectRoom(layout);
  const ordered = [...voices].sort(voiceOrder);
  const strobeHeld = new Array<boolean>(n).fill(false);
  for (const voice of ordered) {
    const slots = voiceSlots(voice.targets, frame.fixtureIds, n);
    const out = unwritten(room.n);
    const instance: EffectInstance = { id: voice.id, spec: voice.spec, seed: voice.seed, anchorBeat: voice.anchorBeat,
      startedAtMs: voice.startedAtMs, targets: slots };
    const acknowledged = frame.acknowledged || !!options.admit?.has(voice);
    renderEffect(instance, acknowledged === frame.acknowledged ? frame : { ...frame, acknowledged }, room, stepper, out);
    const strobe = voice.spec.kind === 'strobe';
    let covers: boolean[] | null = null;
    if (strobe && slots) {
      covers = new Array<boolean>(n).fill(false);
      for (const k of slots) covers[k] = true;
    }
    for (let k = 0; k < n; k++) {
      if (strobe) {
        if (covers && !covers[k]) continue;
        if (strobeHeld[k]) continue;
        strobeHeld[k] = true;
      }
      // The slot is this frame's own copy (renderEffect's), so it can carry its kind.
      const slot = out[k] as EffectSlot | undefined;
      if (winners[k] || !slot || !(slot.strength > 0)) continue;
      slot.kind ??= voice.spec.kind;
      winners[k] = slot;
    }
  }
  return winners;
}
