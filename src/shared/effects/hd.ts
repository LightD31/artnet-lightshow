import { HEX_COLOUR } from '../palette-model.ts';
// Hue Dynamics Party's ten families share timing and colours, while each keeps
// its own spatial kernel, recommended controls and audio response. All times
// here are beats, so the worker and the rehearsal preview use the same clock.

import { z } from 'zod';
import type { ZodType } from 'zod';
import type { Colour } from '../../types/rig.ts';
import type { LampRoom, Room } from '../room.ts';
import { activeEvents, composeEvents, curveApply, envelopeLength, eventInterval, EventAdmission, isReversed, sampleEnvelope, staggerOffset } from './envelope.ts';
import { hash01 } from './hash.ts';
import { parseHex, samplePalette } from './palette.ts';
import { registerKind } from './registry.ts';
import type { Ahdsr, Curve, EffectFrame, EffectKindDef, EffectSlot, EffectSpec, HdCapability, HdMaster, HdParams, RgbEnvelope, Seed, Trigger } from './types.ts';

export type HdKind = 'hd.simpleAdsr' | 'hd.positionChase' | 'hd.radialPulse' | 'hd.spatialWash' | 'hd.bouncingScan'
  | 'hd.streak' | 'hd.twinkle' | 'hd.breathingFade' | 'hd.volumeGateWash' | 'hd.frequencyBurst';

const TICK = 1 / 960;
const clamp = (x: number, low = 0, high = 1) => Math.max(low, Math.min(high, x));
const frac = (x: number) => x - Math.floor(x);
const BLACK: Colour = { r: 0, g: 0, b: 0, w: 0, a: 0, uv: 0 };

// These are the shared starting controls, before a family supplies its
// recommendation. Palette fallback belongs to the shared instance renderer.
export const HD_BASE: HdParams = {
  curve: 'easeInOut', attack: 120 / 960, hold: 240 / 960, release: 480 / 960, stagger: 120 / 960,
  direction: 'forward', order: 'position', probability: 1, repetitions: 1, trail: 480 / 960,
  spatial: { x: 0.5, y: 0.5, z: 0.5, radius: 0.5, angle: 0 },
  trigger: { mode: 'timeline', band: 'full', beatInterval: 1, threshold: 0.2, reactiveDepth: 1 }, loopLength: null,
};

// RGB channels start alike; the single-colour brightness envelope has its own
// short attack and long release. An explicit null envelope uses these defaults.
const CHANNEL: Ahdsr = { attack: 0.1, hold: 0.1, decay: 0.2, sustain: 0.5, release: 0.2, peak: 1 };
const RGB_BASE: RgbEnvelope = {
  colourMode: 'all', singleColour: '#FFFFFF', r: { ...CHANNEL }, g: { ...CHANNEL }, b: { ...CHANNEL },
  brightness: { attack: 0.04, hold: 0.08, decay: 0.16, sustain: 0.16, release: 0.62, peak: 1 },
};

// Validation rejects invalid user controls; envelope time normalization is a
// playback operation and must never rewrite the stored preset.
const unit = z.number().min(0).max(1);
const beats = z.number().min(0);
const ahdsrSchema = z.object({ attack: unit, hold: unit, decay: unit, sustain: unit, release: unit, peak: unit.optional() });
const rgbSchema = z.object({
  colourMode: z.enum(['all', 'singleColour']), singleColour: z.string().regex(HEX_COLOUR, 'expected a full colour hex value'),
  r: ahdsrSchema, g: ahdsrSchema, b: ahdsrSchema, brightness: ahdsrSchema,
});
// Unsupported controls still round-trip when switching families. Capability
// metadata controls the inspector; it does not delete a user's saved settings.
export const hdSchema: ZodType<HdParams> = z.object({
  curve: z.enum(['linear', 'easeIn', 'easeOut', 'easeInOut', 'cut']), attack: beats, hold: beats, release: beats, stagger: beats,
  direction: z.enum(['forward', 'reverse', 'alternate', 'random']), order: z.enum(['position', 'track', 'random']),
  probability: unit, repetitions: z.number().int().min(1), trail: beats,
  spatial: z.object({ x: unit, y: unit, z: unit, radius: unit, angle: z.number() }),
  trigger: z.object({ mode: z.enum(['timeline', 'beatAccent', 'volumeGate']), band: z.enum(['full', 'bass', 'mid', 'high']),
    beatInterval: z.number().min(TICK), threshold: unit, reactiveDepth: unit }),
  loopLength: z.number().min(1 / 16).nullable(), rgbEnvelope: rgbSchema.nullable().optional(),
});

// Each recommendation owns its nested objects. Editing one family cannot
// change the defaults of another family or its inspector controls.
function recommend(kind: HdKind): EffectKindDef<HdParams>['defaults'] {
  const p = structuredClone(HD_BASE);
  let brightness = 1;
  switch (kind) {
    case 'hd.simpleAdsr': p.curve = 'linear'; p.rgbEnvelope = { ...structuredClone(RGB_BASE), colourMode: 'singleColour' }; break;
    case 'hd.positionChase': p.curve = 'easeOut'; p.attack = 80 / 960; p.hold = 160 / 960; p.release = 400 / 960; break;
    case 'hd.radialPulse':
      p.spatial.radius = 1; p.trigger = { ...p.trigger, mode: 'beatAccent', band: 'bass', beatInterval: 4, reactiveDepth: 0.6 };
      p.attack = 1.5; p.hold = 0.5; p.release = 2; break;
    case 'hd.spatialWash': brightness = 0.72; p.direction = 'alternate'; p.attack = 2; p.hold = 1; p.release = 2; p.spatial.radius = 1; break;
    case 'hd.bouncingScan': p.direction = 'alternate'; p.trail = 360 / 960; p.spatial.angle = 28; break;
    case 'hd.streak': p.direction = 'random'; p.probability = 0.68; p.trail = 1; p.spatial.angle = 42; break;
    case 'hd.twinkle': brightness = 0.82; p.probability = 0.35; p.attack = 40 / 960; p.release = 720 / 960; break;
    case 'hd.breathingFade': brightness = 0.65; p.attack = 1.5; p.hold = 0.5; p.release = 1.5; break;
    case 'hd.volumeGateWash':
      brightness = 0.75; p.release = 1; p.trigger = { ...p.trigger, mode: 'volumeGate', threshold: 0.25, reactiveDepth: 0.8 }; break;
    case 'hd.frequencyBurst':
      p.probability = 0.75; p.curve = 'easeOut'; p.attack = 40 / 960; p.hold = 160 / 960; p.release = 440 / 960;
      p.trigger = { ...p.trigger, mode: 'beatAccent', band: 'high', threshold: 0.15, reactiveDepth: 0.6 }; break;
  }
  // Output settings travel alongside params, so applying a recommendation
  // also restores its brightness, acknowledgement requirement and loop scope.
  return { params: p, brightness, rapidFlash: kind === 'hd.frequencyBurst', minFlashIntervalMs: kind === 'hd.frequencyBurst' ? 400 : 250,
    scope: kind === 'hd.simpleAdsr' ? 'singleBeat' : 'measure' };
}

const KINDS: HdKind[] = ['hd.simpleAdsr', 'hd.positionChase', 'hd.radialPulse', 'hd.spatialWash', 'hd.bouncingScan',
  'hd.streak', 'hd.twinkle', 'hd.breathingFade', 'hd.volumeGateWash', 'hd.frequencyBurst'];
export const HD_DEFAULTS = Object.fromEntries(KINDS.map((kind) => [kind, recommend(kind)])) as Record<HdKind, EffectKindDef<HdParams>['defaults']>;

// Common timing controls remain visible; nested capability keys distinguish
// an origin from an angle or spread without changing the older top-level keys.
function capabilities(kind: HdKind): Partial<Record<HdCapability, boolean>> {
  const simple = kind === 'hd.simpleAdsr';
  const ordered = ['hd.positionChase', 'hd.bouncingScan', 'hd.streak'].includes(kind);
  const angle = ordered || kind === 'hd.spatialWash' || kind === 'hd.volumeGateWash';
  const origin = kind === 'hd.radialPulse';
  const radius = origin || kind === 'hd.spatialWash';
  return {
    curve: true, attack: !simple, hold: !simple, release: !simple, repetitions: !simple, loopLength: true, rgbEnvelope: simple,
    stagger: kind === 'hd.positionChase', trail: kind === 'hd.bouncingScan' || kind === 'hd.streak',
    probability: ['hd.streak', 'hd.twinkle', 'hd.frequencyBurst'].includes(kind),
    direction: ordered || origin || kind === 'hd.spatialWash' || kind === 'hd.volumeGateWash', order: ordered,
    spatial: angle || origin || radius, 'spatial.x': origin, 'spatial.y': origin, 'spatial.z': origin, 'spatial.angle': angle, 'spatial.radius': radius,
    trigger: !simple, 'trigger.mode': !simple, 'trigger.band': !simple, 'trigger.beatInterval': !simple,
    'trigger.threshold': !simple, 'trigger.reactiveDepth': !simple,
  };
}
export const HD_CAPABILITIES = Object.fromEntries(KINDS.map((kind) => [kind, capabilities(kind)])) as Record<HdKind, Partial<Record<HdCapability, boolean>>>;

/** Single-beat envelopes loop once a beat; measure effects stretch the bar to fit their envelope. */
export function scopedLoopLength(spec: EffectSpec, p: HdParams): number {
  return p.loopLength ?? (spec.scope === 'singleBeat' ? 1 : Math.max(4, envelopeLength(p)));
}

/** The seeded order is fixed for the instance; direction changes traverse that order. */
export function orderTargets(p: HdParams, room: Room, seed: Seed): number[] {
  const order = Array.from({ length: room.n }, (_, i) => i);
  if (p.order === 'track') return order;
  // Stable ties keep colocated lamps ordered identically across processes.
  const values = p.order === 'random' ? order.map((i) => hash01(seed, i, 0)) : room.hdProject(p.spatial.angle);
  return order.sort((a, b) => values[a] - values[b] || (p.order === 'position' ? room.Z[a] - room.Z[b] : 0) || a - b);
}

/** The endpoint is the formula's limit: only full input passes a full threshold. */
export function gateStrength(level: number, master: HdMaster, trigger: Trigger): number {
  // Use the exact slope even above .99; a high threshold must not silently
  // broaden the responsive range chosen by the operator.
  const threshold = clamp(Math.max(master.threshold, trigger.threshold));
  return threshold === 1 ? Number(level >= 1) : clamp((level - threshold) / (1 - threshold));
}

interface Follower {
  phase: 'idle' | 'attack' | 'hold' | 'release';
  start: number; holdUntil: number; from: number; target: number; lastInput: number; output: number; beat: number | null;
}
const follower = (): Follower => ({ phase: 'idle', start: 0, holdUntil: 0, from: 0, target: 0, lastInput: 0, output: 0, beat: null });

// Phase starts stay in beats. A tempo change changes how fast the phase moves
// in wall time, without changing the level or restarting its attack.
function beginFollower(s: Follower, phase: 'attack' | 'release', beat: number, target: number): void {
  s.phase = phase; s.start = beat; s.from = s.output; s.target = target;
}
function advanceFollower(s: Follower, beat: number, p: HdParams): void {
  if (s.phase === 'hold') {
    if (beat < s.holdUntil) return;
    // Begin at the hold deadline, even if this frame arrives later, so the
    // release catches up instead of stretching with a dropped render frame.
    beginFollower(s, 'release', s.holdUntil, s.target);
  }
  if (s.phase !== 'attack' && s.phase !== 'release') return;
  const duration = s.phase === 'attack' ? p.attack : p.release;
  if (duration === 0 || p.curve === 'cut') { s.output = s.target; s.phase = 'idle'; return; }
  const progress = clamp((beat - s.start) / duration);
  s.output = s.from + (s.target - s.from) * curveApply(progress, p.curve);
  if (progress >= 1) s.phase = 'idle';
}
function follow(s: Follower, input: number, beat: number, p: HdParams): number {
  // A room can be sampled twice at one position; its follower still advances
  // only once. Seeking backwards starts a fresh envelope at the new position.
  if (s.beat === beat) return s.output;
  if (s.beat !== null && beat < s.beat) Object.assign(s, follower());
  const level = clamp(input);
  advanceFollower(s, beat, p);
  // A new rise at the held output ends the hold, so the next fall can start
  // a fresh hold instead of inheriting the older falling edge.
  if (s.phase === 'hold' && level >= s.output - 1e-6 && level > s.lastInput + 1e-6) { s.phase = 'idle'; s.target = level; }
  if (level > s.output + 1e-6) {
    // A changed attack target starts from the current output, not from zero.
    if (s.phase !== 'attack' || Math.abs(s.target - level) > 1e-6) beginFollower(s, 'attack', beat, level);
    advanceFollower(s, beat, p);
  } else if (level < s.lastInput - 1e-6 && level < s.output) {
    s.phase = 'hold'; s.holdUntil = beat + p.hold; s.from = s.output; s.target = level;
    advanceFollower(s, beat, p);
  } else if (s.phase === 'release' && Math.abs(s.target - level) > 1e-6) {
    // Follow a moving floor continuously after the hold has finished.
    beginFollower(s, 'release', beat, level); advanceFollower(s, beat, p);
  }
  s.lastInput = level; s.beat = beat;
  return s.output;
}

// Ordinary data and the existing admission class are deliberately cloneable:
// preview checkpoints must retain both pending fades and previous decisions.
interface HdState {
  admission: EventAdmission;
  follower: Follower;
  lastPosition: number | null;
  rgb: RgbEnvelope;
  single: Colour;
}

// Normalize a runtime copy only: saved values remain exactly what the user
// edited, including an overfull time budget or a sustain above its peak.
function normalizeEnvelope(input: Ahdsr): Ahdsr {
  const out = { ...input, peak: input.peak ?? 1 };
  const length = out.attack + out.hold + out.decay + out.release;
  if (length > 1) { out.attack /= length; out.hold /= length; out.decay /= length; out.release /= length; }
  out.sustain = Math.min(out.peak, out.sustain);
  return out;
}
function initHd(p: HdParams): HdState {
  // Fixed single colours are parsed once, just like prepared effect palettes.
  const rgb = p.rgbEnvelope ?? RGB_BASE;
  return { admission: new EventAdmission(350), follower: follower(), lastPosition: null,
    rgb: { ...rgb, r: normalizeEnvelope(rgb.r), g: normalizeEnvelope(rgb.g), b: normalizeEnvelope(rgb.b), brightness: normalizeEnvelope(rgb.brightness) },
    single: parseHex(rgb.singleColour) };
}

// AHDSR has a decay and a sustain level in addition to the event envelope.
// Release occupies the end of the loop; any remaining time is sustain.
function sampleAhdsr(e: Ahdsr, progress: number, curve: Curve): number {
  const peak = e.peak ?? 1;
  // AHDSR cut ramps jump at their start, including exactly progress zero.
  const ramp = (a: number, b: number, position: number) => a + (b - a) * (curve === 'cut' ? 1 : curveApply(position, curve));
  if (!Number.isFinite(progress) || progress < 0 || progress >= 1) return 0;
  if (progress < e.attack) return ramp(0, peak, progress / e.attack);
  if (progress < e.attack + e.hold) return peak;
  if (progress < e.attack + e.hold + e.decay) return ramp(peak, e.sustain, (progress - e.attack - e.hold) / e.decay);
  if (progress < 1 - e.release) return e.sustain;
  return e.release > 0 ? ramp(e.sustain, 0, (progress - (1 - e.release)) / e.release) : 0;
}
function renderAdsr(p: HdParams, s: HdState, room: Room, frame: EffectFrame, out: EffectSlot[]): void {
  const progress = frac(Math.max(0, frame.beatPos - frame.anchorBeat) / scopedLoopLength(frame.spec, p));
  let colour: Colour, level: number;
  if (s.rgb.colourMode === 'singleColour') {
    const peak = Math.max(s.single.r, s.single.g, s.single.b, s.single.w ?? 0, s.single.a ?? 0, s.single.uv ?? 0) / 255;
    level = peak * sampleAhdsr(s.rgb.brightness, progress, p.curve);
    const channel = (key: keyof Colour) => Math.round((s.single[key] ?? 0) / peak);
    colour = level > 0 ? { r: channel('r'), g: channel('g'), b: channel('b'), w: channel('w'), a: channel('a'), uv: channel('uv') } : BLACK;
  } else {
    const r = sampleAhdsr(s.rgb.r, progress, p.curve), g = sampleAhdsr(s.rgb.g, progress, p.curve), b = sampleAhdsr(s.rgb.b, progress, p.curve);
    level = Math.max(r, g, b);
    colour = level > 0 ? { r: Math.round(255 * r / level), g: Math.round(255 * g / level), b: Math.round(255 * b / level), w: 0, a: 0, uv: 0 } : BLACK;
  }
  for (let i = 0; i < room.n; i++) out[i] = { colour, level, strength: level > 0 ? 1 : 0 };
}

function reactiveLevel(kind: HdKind, p: HdParams, state: HdState, frame: EffectFrame): number {
  // Missing live input keeps the clock-driven show running. A timeline trigger
  // also ignores audio, even when the transport's audio mode is reactive.
  if (frame.audioMode !== 'reactive' || !frame.audio || p.trigger.mode === 'timeline') return 1;
  const depth = clamp(frame.master.reactiveDepth * p.trigger.reactiveDepth);
  let level = clamp(frame.audio.party[p.trigger.band]);
  if (p.trigger.mode === 'volumeGate' || (kind === 'hd.frequencyBurst' && p.trigger.mode === 'beatAccent')) level = gateStrength(level, frame.master, p.trigger);
  if (kind === 'hd.volumeGateWash' && p.trigger.mode === 'volumeGate') level = follow(state.follower, level, frame.beatPos, p);
  return 1 - depth + level * depth;
}

interface KernelSample { strength: number; palettePos: number }
const raisedCosine = (phase: number) => (Math.cos(frac(phase) * Math.PI * 2) + 1) / 2;

// Index and progress have already been reversed by the event sampler. Only
// Breathing Fade uses raw progress: it has no direction control in the app.
function kernel(kind: HdKind, p: HdParams, room: Room, slot: number, index: number, progress: number,
  rawProgress: number, duration: number, event: number, seed: Seed): KernelSample {
  const position = index / Math.max(1, room.n - 1);
  switch (kind) {
    case 'hd.positionChase': return { strength: 1, palettePos: (index + event) / Math.max(1, room.n) };
    case 'hd.radialPulse': {
      const { x, y, z, radius } = p.spatial;
      // Scale by the farthest room corner from the chosen origin, rather than
      // by the lamps present; changing the rig must not change the wave speed.
      const corner = Math.hypot(Math.max(x, 1 - x), Math.max(y, 1 - y), Math.max(z, 1 - z));
      const distance = Math.hypot(room.X[slot] - x, room.Y[slot] - y, room.Z[slot] - z) / (Math.max(0.05, radius) * corner);
      const edge = clamp((Math.abs(distance - progress) - 0.12) / (0.45 - 0.12));
      return { strength: 1 - edge * edge * (3 - 2 * edge), palettePos: distance + progress };
    }
    case 'hd.spatialWash':
    case 'hd.volumeGateWash': {
      const gated = kind === 'hd.volumeGateWash';
      const phase = room.hdProject(p.spatial.angle)[slot] / (gated ? 1 : Math.max(0.08, p.spatial.radius)) - progress + 0.11 * event;
      const wave = Math.max(raisedCosine(phase), raisedCosine(phase + 1 / 3), raisedCosine(phase + 2 / 3));
      return { strength: gated ? 0.72 + 0.28 * wave : 0.55 + 0.45 * wave, palettePos: phase };
    }
    case 'hd.bouncingScan': {
      const head = 1 - Math.abs(2 * progress - 1);
      // The minimum width gives even a zero-trail control a finite sample.
      const trail = clamp(p.trail / duration, 0.035, 0.7);
      return { strength: Math.exp(-4.5 * ((position - head) / trail) ** 2), palettePos: head + position };
    }
    case 'hd.streak': {
      // One roll admits the whole streak; twinkle and burst roll per lamp.
      const roll = hash01(seed, 0, event);
      if (roll > p.probability) return { strength: 0, palettePos: roll };
      const trail = clamp(p.trail / duration, 0.03, 0.95);
      const distance = progress - position;
      return { strength: distance >= 0 && distance <= 4 * trail ? Math.exp(-3.2 * distance / trail) : 0, palettePos: progress + position + roll };
    }
    case 'hd.twinkle': {
      const roll = hash01(seed, slot, event);
      return { strength: roll <= p.probability ? 1 : 0, palettePos: roll + 0.07 * event };
    }
    case 'hd.breathingFade': return { strength: 1, palettePos: rawProgress + 0.17 * event };
    case 'hd.frequencyBurst': {
      const roll = hash01(seed, slot, 17 * event);
      return { strength: roll < p.probability ? 1 : 0, palettePos: roll + 0.31 * event };
    }
    // Simple ADSR samples the whole loop directly, before this event path.
    case 'hd.simpleAdsr': return { strength: 0, palettePos: 0 };
  }
}

function renderHd(kind: HdKind, p: HdParams, state: HdState, room: Room, f: EffectFrame, out: EffectSlot[], lamps?: LampRoom): void {
  // Simple ADSR has no event admission; the shared renderer already enforces
  // acknowledgement when this or any other spec is marked as rapid flashing.
  if (kind === 'hd.simpleAdsr') { renderAdsr(p, state, room, f, out); return; }
  const order = orderTargets(p, room, f.seed);
  const indices = new Array<number>(room.n);
  order.forEach((slot, index) => { indices[slot] = index; });
  const position = f.beatPos - f.anchorBeat;
  const length = envelopeLength(p);
  let events = activeEvents(position, eventInterval(p, scopedLoopLength(f.spec, p), f.audioMode), length,
    kind === 'hd.positionChase' ? p.stagger * Math.max(0, room.n - 1) : 0);
  if (kind === 'hd.frequencyBurst' || f.spec.rapidFlash) {
    if (state.lastPosition !== null && position < state.lastPosition) state.admission.reset();
    state.admission.minIntervalMs = Math.max(350, f.spec.minFlashIntervalMs ?? 350);
    // Event identity remains musical, but admission is in elapsed wall time.
    // Rescaling the entire beat origin after a tap would suppress many seconds.
    events = events.filter((event) => event.age < 0 || state.admission.admit(event.index, f.nowMs - event.age * 60000 / f.bpm));
  }
  state.lastPosition = position;
  const reactive = reactiveLevel(kind, p, state, f);
  const positions = lamps && cellPositions(lamps, p);
  for (let target = 0; target < (lamps?.cells.n ?? room.n); target++) {
    const slot = lamps ? lamps.lampOf[target] : target;
    const index = indices[slot] + (positions ? positions[target] - 0.5 : 0);
    // Overlapping envelopes compete by strength, rather than adding levels.
    // Their palette positions follow the same winning event and tie rule.
    const composed = composeEvents(events, (event, rawAge) => {
      const reversed = isReversed(p.direction, event.index, f.seed);
      const age = rawAge - (kind === 'hd.positionChase' ? staggerOffset(p.stagger, index, room.n, reversed) : 0);
      if (age < 0) return null;
      const envelope = sampleEnvelope(age, p);
      if (envelope <= 0) return null;
      const rawProgress = length > 0 ? clamp(age / length) : 0;
      const sample = kernel(kind, p, room, slot, reversed ? room.n - 1 - index : index,
        reversed ? 1 - rawProgress : rawProgress, rawProgress, Math.max(TICK, length), event.index, f.seed);
      return { strength: clamp(envelope * sample.strength), palettePos: sample.palettePos };
    });
    const level = composed.strength * reactive;
    out[target] = { colour: f.gradient?.sample(composed.palettePos) ?? samplePalette(f.palette, composed.palettePos), level, strength: level > 0 ? 1 : 0 };
  }
}

const cellPositionMemo = new WeakMap<LampRoom, Map<number, number[]>>();
function cellPositions(lamps: LampRoom, p: HdParams): readonly number[] {
  if (p.order !== 'position') return lamps.cellAlong;
  let angles = cellPositionMemo.get(lamps);
  if (!angles) { angles = new Map(); cellPositionMemo.set(lamps, angles); }
  const angle = p.spatial.angle;
  let positions = angles.get(angle);
  if (positions) return positions;
  const projected = lamps.cells.hdProject(angle);
  positions = new Array<number>(lamps.cells.n);
  for (const slots of lamps.slots) {
    let lo = Infinity, hi = -Infinity;
    for (const slot of slots) { lo = Math.min(lo, projected[slot]); hi = Math.max(hi, projected[slot]); }
    for (const slot of slots) positions[slot] = hi - lo > 1e-9 ? (projected[slot] - lo) / (hi - lo) : 0.5;
  }
  if (angles.size >= 64) angles.clear();
  angles.set(angle, positions);
  return positions;
}

const ALONG_KINDS = new Set(['hd.positionChase', 'hd.bouncingScan', 'hd.streak']);
const LAMP_KINDS = new Set([...ALONG_KINDS, 'hd.twinkle', 'hd.frequencyBurst']);
for (const kind of KINDS) registerKind<HdParams, HdState>({
  kind, level: LAMP_KINDS.has(kind) ? 'lamp' : 'cell', app: 'hd', schema: hdSchema, defaults: HD_DEFAULTS[kind], capabilities: HD_CAPABILITIES[kind],
  rapidFlash: kind === 'hd.frequencyBurst', stateful: true,
  ...(ALONG_KINDS.has(kind) ? { renderCells: (params: HdParams, state: HdState, lamps: LampRoom, frame: EffectFrame, out: EffectSlot[]) =>
    renderHd(kind, params, state, lamps, frame, out, lamps) } : {}),
  init: initHd, render: (params, state, room, frame, out) => renderHd(kind, params, state, room, frame, out),
});
