import { renderEffect } from './render.ts';
import { roomOf } from '../room.ts';
import type { Colour } from '../../types/rig.ts';
import type { Layout, Rig } from '../rig.ts';
import type { Room } from '../room.ts';
import type { EffectInstance, EffectStepper } from './stepper.ts';
import type { EffectSlot, EffectSpec, FrameBase, Seed } from './types.ts';

export interface VoiceFrame {
  id: string;
  spec: EffectSpec;
  targets: number[] | null;
  tier: 'strobe' | 'voice';
  launchSeq: number;
  startedAtMs: number;
  untilMs: number | null;
  anchorBeat: number;
  seed: Seed;
  // Compatibility energy voices stay on the global grid when the music jumps.
  holdsGrid?: boolean;
}

// Sort keys so rebuilt snapshots compare equal.
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
}

export function effectContentKey(spec: EffectSpec): string {
  return canonical({ kind: spec.kind, params: spec.params ?? null, scope: spec.scope ?? null,
    minFlashIntervalMs: spec.minFlashIntervalMs ?? null, rapidFlash: spec.rapidFlash ?? null });
}

// Strobe launches retain identity so relaunching cannot reset their safety permit.
export function voiceLaunchKey(v: VoiceFrame): string {
  return v.spec.kind === 'strobe' ? 'strobe' : canonical([v.launchSeq, v.startedAtMs, v.seed, effectContentKey(v.spec)]);
}

export interface VoiceRecord { launch: string; kind: string; wireAnchor: number; anchor: number; epoch: number }

// Clock epochs re-anchor ordinary voices but preserve the global grid of compatibility energies.
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

// Transfer strobe state on relaunch so edits cannot outrun its cap.
export function relaunchEffect(stepper: EffectStepper, previous: { id: string; kind: string } | null, id: string, kind: string): void {
  if (previous && previous.kind === 'strobe' && kind === 'strobe') stepper.move(previous.id, id);
  else {
    if (previous) stepper.forget(previous.id);
    stepper.forget(id);
  }
}

// Transfer permits across strobe handovers so replacing a voice cannot reset its flash rate.
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

export type VoiceRank = Pick<VoiceFrame, 'tier' | 'launchSeq' | 'startedAtMs'> & { targets: readonly unknown[] | null };

// Order by tier, launch, targeted coverage, then start time so rendering and detectors agree.
export function voiceOrder(a: VoiceRank, b: VoiceRank): number {
  return Number(b.tier === 'strobe') - Number(a.tier === 'strobe') || b.launchSeq - a.launchSeq
    || Number(b.targets !== null) - Number(a.targets !== null) || b.startedAtMs - a.startedAtMs;
}

// Disco paces its own strobes, so the HD Party guard excludes it.
const HD_GUARDED = new Set(['hd.simpleAdsr', 'hd.positionChase', 'hd.radialPulse', 'hd.spatialWash', 'hd.bouncingScan',
  'hd.streak', 'hd.twinkle', 'hd.breathingFade', 'hd.volumeGateWash', 'hd.frequencyBurst']);

export function hdGuarded(kind: string | null | undefined): boolean {
  return !!kind && HD_GUARDED.has(kind);
}

const effectRooms = new WeakMap<Layout['units'], Room>();

export function effectRoom(layout: Layout): Room {
  const { list, xs, ys, plan, noFlash } = layout.units;
  const cells = roomOf({ fixtureCount: list.length, xs, ys, plan, noFlash });
  if (!layout.lamps) return cells;
  const remembered = effectRooms.get(layout.units);
  if (remembered) return remembered;
  const lamps = layout.lamps;
  const hue = noFlash && lamps.slots.map((slots) => noFlash[slots[0]]);
  const room: Room = { ...cells, lamps: {
    ...roomOf({ fixtureCount: lamps.slots.length, xs: lamps.xs, ys: null, plan: lamps.plan, noFlash: hue }),
    cells, slots: lamps.slots, lampOf: lamps.lampOf, cellAlong: lamps.cellAlong,
  } };
  effectRooms.set(layout.units, room);
  return room;
}

export function voiceLayout(rig: Rig): Layout {
  return rig.layout(null, 'stage');
}

export type EffectLayerSet = (unit: number, colour: Colour, dim: number, strobe: number, kind: string | null, owner?: string) => void;

const BLACK: Colour = { r: 0, g: 0, b: 0, w: 0, a: 0, uv: 0 };
const unwritten = (n: number): EffectSlot[] => new Array<EffectSlot>(n);

// Clear every unwritten base slot so previous frames cannot leak through transparent effects.
export function renderEffectLayer(rig: Rig, layout: Layout, frame: FrameBase, instance: EffectInstance, stepper: EffectStepper,
  set: EffectLayerSet, prepare?: (state: unknown) => void): void {
  const { list } = layout.units;
  if (!list.length) return;
  const room = effectRoom(layout);
  const out = unwritten(room.n);
  renderEffect(instance, frame, room, stepper, out, prepare);
  for (let k = 0; k < list.length; k++) {
    const slot = out[k] as EffectSlot | undefined;
    if (slot && slot.strength > 0) set(list[k], slot.colour, 255 * slot.level, slot.strobe ?? 0, slot.kind ?? instance.spec.kind, slot.owner);
    else set(list[k], BLACK, 0, 0, null);
  }
}

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
  admit?: ReadonlySet<VoiceFrame>;
}

// Black at strength 1 owns the slot; retain its kind so family-specific guards still apply.
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
      if (out[k]?.excluded) continue;
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
