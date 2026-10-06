// Hue Dynamics' Disco: lamps answer the hits in three bands (Spectrum), the
// loudest peaks (Peak) or a running reading of pitch and level (Neural), with
// idle washes between hits and an automatic strobe. The app streams to its
// lamps on a wall clock, so every time here is in milliseconds, not beats.

import { z } from 'zod';
import type { ZodType } from 'zod';
import type { Colour } from '../../types/rig.ts';
import type { Room } from '../room.ts';
import { MAX_LAMP_FLASH_HZ } from '../patterns.ts';
import { BAND_HZ_MAX, perBinFloorDb, validBand } from '../spectrum-bands.ts';
import type { AudioFrame } from './audio-frame.ts';
import { hash01 } from './hash.ts';
import { parseHex, toHex } from './palette.ts';
import { registerKind } from './registry.ts';
import type { EffectFrame, EffectSlot } from './types.ts';

export type DiscoBand = 'bass' | 'voice' | 'treble';
export interface DiscoChannel {
  enabled: boolean; fade: boolean; allowPulse: boolean; minHue: number; maxHue: number; fadeBrightness: number; fadeSaturation: number;
  idleFadeBrightness: number; sequenceLength: number; useAmbience: boolean; palette: string[] | null; strobeOn: boolean; linkLights: boolean;
  modulateSaturation: boolean;
}
/** The hit detector's settings: the audio features read them, the kind does not. */
export interface DiscoGlobals {
  sensitivity: number; advancedDecay: number; smoothness: number; minimumThreshold: number; simpleSensitivity: number; simpleDecay: number;
  simpleMinimumThreshold: number; analyserSensitivity: number; smoothnessAnalyser: number;
}
export interface DiscoParams {
  style: 'spectrum' | 'peak' | 'neural';
  /** 0–2 Spectrum bass, voice and treble; 3 Peak; 4 Neural. */
  channels: [DiscoChannel, DiscoChannel, DiscoChannel, DiscoChannel, DiscoChannel];
  allowStrobe: boolean;
  /** The automatic strobe's colours; the rate is the manual strobe's and does not slow the automatic one. */
  strobe: { palette: string[]; flashesPerSecond: number };
  /** Manual bands by fixture id; the other lamps are balanced across the enabled bands. */
  assign: Record<string, DiscoBand>;
  /** Output smoothness: lengthens or shortens every release. globals.smoothness only mirrors it. */
  smoothness: number;
  maxLightsPerBatch: number;
  /** Band edges in Hz, and each band's per-bin trigger floor in dB. */
  bands: { bass: [number, number]; voice: [number, number]; treble: [number, number]; floorDb: [number, number, number] };
  globals: DiscoGlobals;
}

const BANDS: readonly DiscoBand[] = ['bass', 'voice', 'treble'];
// The app's timing on the entertainment stream.
const ADMIT_MS = 100;
const IDLE_MS = 2000;
const SPECTRUM_RELEASE_DELAY_MS = 32;
const PEAK_HOLD_MS = 100;
const PEAK_FADE_MS = 300;
const PULSE_MS = 200;
const MAX_INTERVAL_MS = 1400;
// The automatic flash: full, then down to 40 over 200 ms, whatever the channel's own release.
const FLASH_FALL_MS = 200;
const FLASH_FLOOR = 40;
const FULL = 254;
const HUE_PER_DEGREE = 182.04;
// The app's detector floor is minimumThreshold / 200000 in total over a band's bins.
const FLOOR_PER_THRESHOLD = 1 / 200000;
// Hash key base for the Disco's draws: one stream per channel, one for strobe colours.
const DRAW_KEY = 0xd15c0;
const STROBE_STREAM = 5;

// Neural reproduces the app's single-precision products, which move some hues a degree.
const f32 = Math.fround;
const clamp = (x: number, low: number, high: number) => Math.max(low, Math.min(high, x));
// Audio features arrive as JSON; anything but a finite number reads as silence.
const unit = (x: unknown) => typeof x === 'number' && Number.isFinite(x) ? clamp(x, 0, 1) : 0;
const rgb = (r: number, g: number, b: number): Colour => ({ r, g, b, w: 0, a: 0, uv: 0 });
const solid = (c: Colour): Colour => ({ r: c.r, g: c.g, b: c.b, w: c.w ?? 0, a: c.a ?? 0, uv: c.uv ?? 0 });

// The app's own HSV at full value: double precision, bytes truncated, not the
// rounded 32-bit converter Light DJ uses.
function hsvDegrees(degrees: number, saturation: number): Colour {
  if (saturation === 0) return rgb(255, 255, 255);
  const sector = degrees / 60, i = Math.floor(sector), f = sector - i;
  const p = 1 - saturation, q = 1 - saturation * f, t = 1 - saturation * (1 - f);
  const [r, g, b] = i === 1 ? [q, 1, p] : i === 2 ? [p, 1, t] : i === 3 ? [p, q, 1] : i === 4 ? [t, p, 1] : i === 5 ? [1, p, q] : [1, t, p];
  const byte = (x: number) => Math.trunc(Math.max(x * 255, 0));
  return rgb(byte(r), byte(g), byte(b));
}
// Hue units clamp to 65534 as the app's converter does: 65535 is the same red.
const toDegrees = (hue: number) => Math.trunc(clamp(Math.trunc(Number.isFinite(hue) ? hue : 0), 0, 65534) / HUE_PER_DEGREE);
const hdColour = (degrees: number, saturation: number) =>
  hsvDegrees(degrees, clamp(Math.trunc(Number.isFinite(saturation) ? saturation : 0), 0, 254) / 254);

/** A Hue colour (hue 0..65535, saturation 0..255) as the app streams it: whole degrees of hue / 182.04 at full value. */
export function hdHsbToColour(hue: number, saturation: number): Colour {
  return hdColour(toDegrees(hue), saturation);
}

// Ambience palettes give a hue only; saturation stays the channel's.
function hueDegrees(c: Colour): number {
  const max = Math.max(c.r, c.g, c.b), d = max - Math.min(c.r, c.g, c.b);
  if (d === 0) return 0;
  const h = max === c.r ? (c.g - c.b) / d : max === c.g ? (c.b - c.r) / d + 2 : (c.r - c.g) / d + 4;
  return Math.trunc((h * 60 + 360) % 360);
}

/** The automatic strobe's permit: now ≥ last + ceil(1000 / rate), the rate held to 1..5 a second. Never flashed: last = −Infinity. */
export function hdAutoStrobeFlash(nowMs: number, lastFlashMs: number, maxRate: number): boolean {
  if (!Number.isFinite(nowMs) || !Number.isFinite(maxRate) || Number.isNaN(lastFlashMs)) return false;
  return nowMs >= lastFlashMs + Math.ceil(1000 / clamp(maxRate, 1, 5));
}

/**
 * Each slot's band index (0 bass, 1 voice, 2 treble), or −1 for a dark one.
 * Manual bands go first and count; each other slot, in order, joins the
 * enabled band with the fewest, ties going bass, voice, treble. A slot whose
 * manual band is off stays dark rather than moving. Repeated ids are a
 * fixture's cells and all take its band.
 */
export function assignDiscoBands(ids: readonly string[], assign: Readonly<Record<string, DiscoBand>>, enabled: readonly boolean[]): number[] {
  const counts = [0, 0, 0];
  const manual = ids.map((id) => Object.prototype.hasOwnProperty.call(assign, id) ? BANDS.indexOf(assign[id]) : -1);
  const out = manual.map((band) => band >= 0 && enabled[band] ? band : -1);
  out.forEach((band) => { if (band >= 0) counts[band]++; });
  const open = [0, 1, 2].filter((band) => enabled[band]);
  manual.forEach((band, slot) => {
    if (band >= 0 || !open.length) return;
    const pick = open.reduce((best, x) => counts[x] < counts[best] ? x : best);
    out[slot] = pick;
    counts[pick]++;
  });
  return out;
}

// The settings every channel starts from; each lists only what differs.
function channel(over: Partial<DiscoChannel>): DiscoChannel {
  return { enabled: true, fade: true, allowPulse: false, minHue: 0, maxHue: 60000, fadeBrightness: 40, fadeSaturation: 255, idleFadeBrightness: 254,
    sequenceLength: 8, useAmbience: false, palette: null, strobeOn: false, linkLights: false, modulateSaturation: false, ...over };
}

// Per-bin floors for this service's bins, so each band keeps the app's total floor.
function floorsFor(bands: Pick<DiscoParams['bands'], DiscoBand>, minimumThreshold: number): [number, number, number] {
  const total = minimumThreshold * FLOOR_PER_THRESHOLD;
  return [perBinFloorDb(total, ...bands.bass), perBinFloorDb(total, ...bands.voice), perBinFloorDb(total, ...bands.treble)];
}

// A fresh object every call: presets and the defaults never share arrays.
function discoDefaults(): DiscoParams {
  const edges: Pick<DiscoParams['bands'], DiscoBand> = { bass: [0, 160], voice: [750, 2000], treble: [3000, 9000] };
  return {
    style: 'spectrum',
    channels: [
      channel({ allowPulse: true, maxHue: 10000 }),
      channel({ fade: false }),
      channel({ minHue: 38000, maxHue: 52000 }),
      channel({ allowPulse: true, idleFadeBrightness: 140, sequenceLength: 16 }),
      channel({ allowPulse: true, minHue: 24800, maxHue: 65534, idleFadeBrightness: 140, sequenceLength: 16, modulateSaturation: true }),
    ],
    allowStrobe: false, strobe: { palette: ['#FFFFFF'], flashesPerSecond: 2 }, assign: {}, smoothness: 500, maxLightsPerBatch: 10,
    bands: { ...edges, floorDb: floorsFor(edges, 2) },
    globals: { sensitivity: 50, advancedDecay: 25, smoothness: 500, minimumThreshold: 2, simpleSensitivity: 44, simpleDecay: 20,
      simpleMinimumThreshold: 30, analyserSensitivity: 50, smoothnessAnalyser: 3 },
  };
}

export const DISCO_DEFAULTS: DiscoParams = discoDefaults();

type BandRecipe = [lo: number, hi: number, minHue: number, maxHue: number, allowPulse: boolean];
interface Recipe {
  id: string; name: string; decay: number; sensitivity: number; smoothness: number; relaxed: boolean; sequence: number; autoStrobe: boolean;
  rate: number; strobe: [hue: number, saturation: number][]; bands: [BandRecipe, BandRecipe, BandRecipe];
}
// The app's white: no saturation, so the hue does not matter.
const WHITE_HSB: [number, number] = [49000, 0];
// The app's eleven genre presets. Dance, Drum and Bass, Trance and Ambient
// reach 12–14 kHz there; this service hears up to 11 025 Hz, so their treble
// ends at that edge and its floors are recounted over the bins it keeps.
const RECIPES: Recipe[] = [
  { id: 'hd.disco.pop', name: 'Pop', decay: 24, sensitivity: 60, smoothness: 500, relaxed: false, sequence: 8, autoStrobe: false, rate: 2,
    strobe: [[54613, 255], [32768, 255], WHITE_HSB], bands: [[40, 250, 52000, 62000, true], [300, 3000, 0, 11000, false], [4000, 11000, 10000, 24000, false]] },
  { id: 'hd.disco.rock', name: 'Rock', decay: 28, sensitivity: 55, smoothness: 400, relaxed: false, sequence: 8, autoStrobe: false, rate: 3,
    strobe: [[0, 255], WHITE_HSB], bands: [[40, 215, 58000, 65534, true], [250, 2500, 3000, 8500, false], [3000, 9000, 8000, 14000, false]] },
  { id: 'hd.disco.hipHop', name: 'Hip Hop', decay: 18, sensitivity: 62, smoothness: 550, relaxed: false, sequence: 8, autoStrobe: false, rate: 2,
    strobe: [[0, 255], [9000, 255], [49151, 255]], bands: [[40, 250, 61000, 65534, true], [300, 3500, 3000, 11000, false], [4500, 10000, 50000, 58000, false]] },
  { id: 'hd.disco.rAndB', name: 'R&B', decay: 10, sensitivity: 65, smoothness: 850, relaxed: true, sequence: 8, autoStrobe: false, rate: 1,
    strobe: [[60000, 150], [49151, 100]], bands: [[40, 250, 60000, 65534, false], [300, 4000, 52000, 60000, false], [4500, 10000, 5000, 12000, false]] },
  { id: 'hd.disco.dance', name: 'Dance', decay: 30, sensitivity: 58, smoothness: 400, relaxed: false, sequence: 8, autoStrobe: false, rate: 4,
    strobe: [[32768, 255], [54613, 255], WHITE_HSB], bands: [[40, 200, 60000, 65534, true], [250, 3200, 16000, 26000, false], [4000, 11025, 38000, 50000, false]] },
  { id: 'hd.disco.classical', name: 'Classical', decay: 7, sensitivity: 65, smoothness: 950, relaxed: true, sequence: 8, autoStrobe: false, rate: 1,
    strobe: [[8000, 60]], bands: [[40, 350, 42000, 48000, false], [400, 3000, 47000, 54000, false], [3500, 10000, 7000, 14000, false]] },
  { id: 'hd.disco.jazz', name: 'Jazz', decay: 16, sensitivity: 60, smoothness: 650, relaxed: true, sequence: 8, autoStrobe: false, rate: 1,
    strobe: [[43690, 255], [49151, 255]], bands: [[40, 300, 3000, 9000, false], [350, 2500, 56000, 65534, false], [3000, 9000, 38000, 46000, false]] },
  { id: 'hd.disco.acoustic', name: 'Acoustic', decay: 14, sensitivity: 66, smoothness: 750, relaxed: true, sequence: 8, autoStrobe: false, rate: 1,
    strobe: [[8000, 60], [6000, 220]], bands: [[70, 300, 59000, 65534, false], [350, 3000, 5000, 12000, false], [3500, 10000, 38000, 46000, false]] },
  { id: 'hd.disco.drumAndBass', name: 'Drum and Bass', decay: 40, sensitivity: 60, smoothness: 400, relaxed: false, sequence: 4, autoStrobe: true, rate: 5,
    strobe: [[32768, 255], [54613, 255], WHITE_HSB], bands: [[40, 200, 60000, 65534, true], [250, 2500, 26000, 38000, false], [3000, 11025, 50000, 62000, true]] },
  { id: 'hd.disco.trance', name: 'Trance', decay: 38, sensitivity: 60, smoothness: 400, relaxed: false, sequence: 4, autoStrobe: true, rate: 4,
    strobe: [[43690, 255], [32768, 255], WHITE_HSB], bands: [[40, 180, 52000, 62000, true], [220, 2000, 40000, 52000, false], [3000, 11025, 27000, 38000, true]] },
  { id: 'hd.disco.ambient', name: 'Ambient', decay: 5, sensitivity: 70, smoothness: 1000, relaxed: true, sequence: 8, autoStrobe: false, rate: 1,
    strobe: [[43690, 80], [49151, 100]], bands: [[40, 400, 43000, 50000, false], [450, 4000, 35000, 44000, false], [4500, 11025, 28000, 36000, false]] },
];

function fromRecipe(r: Recipe): DiscoParams {
  const p = discoDefaults();
  p.globals = { ...p.globals, advancedDecay: r.decay, sensitivity: r.sensitivity, smoothness: r.smoothness, minimumThreshold: 2 };
  p.smoothness = r.smoothness;
  p.allowStrobe = r.autoStrobe;
  // Converted once with the streaming converter; they play as these RGB values.
  p.strobe = { palette: r.strobe.map(([hue, saturation]) => toHex(hdHsbToColour(hue, saturation))), flashesPerSecond: r.rate };
  // Relaxed genres fall and idle to a soft 176 on every channel.
  for (const c of p.channels) Object.assign(c, { fadeBrightness: r.relaxed ? 176 : 40, idleFadeBrightness: r.relaxed ? 176 : 254,
    fadeSaturation: 255, useAmbience: false, palette: null });
  r.bands.forEach(([, , minHue, maxHue, allowPulse], i) =>
    Object.assign(p.channels[i], { enabled: true, fade: true, allowPulse, minHue, maxHue, sequenceLength: r.sequence }));
  const [bass, voice, treble] = r.bands.map(([lo, hi]): [number, number] => [lo, hi]);
  p.bands = { bass, voice, treble, floorDb: floorsFor({ bass, voice, treble }, 2) };
  return p;
}

export const DISCO_PRESETS: { id: string; name: string; params: DiscoParams }[] =
  RECIPES.map((r) => ({ id: r.id, name: r.name, params: fromRecipe(r) }));

// Hues, levels and saturations are the app's integer units. Unknown keys are
// refused: a misspelt floor or band must not be dropped without a word.
// Colours stay hex on the wire, as in every other kind's spec.
const hex = z.string().regex(/^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i, 'expected a hex colour');
const hue = z.number().int().min(0).max(65535);
const brightness = z.number().int().min(0).max(FULL);
const channelSchema = z.object({
  enabled: z.boolean(), fade: z.boolean(), allowPulse: z.boolean(), minHue: hue, maxHue: hue, fadeBrightness: brightness,
  fadeSaturation: z.number().int().min(0).max(255), idleFadeBrightness: brightness, sequenceLength: z.number().int().min(1),
  useAmbience: z.boolean(), palette: z.array(hex).nullable(), strobeOn: z.boolean(), linkLights: z.boolean(), modulateSaturation: z.boolean(),
}).strict().refine((c) => c.minHue <= c.maxHue, 'a channel\'s minHue must not exceed its maxHue');
// Invalid edges are refused, never moved: the band list also restarts the
// audio service, which refuses the same edges.
const band = z.tuple([z.number(), z.number()]).refine(([lo, hi]) => validBand(lo, hi),
  `a Disco band is [low, high] Hz with ascending edges, 0 ≤ low < high ≤ ${BAND_HZ_MAX} (half the 22.05 kHz analysis rate)`);
const floorDb = z.number().min(-120).max(0);
const amount = z.number().min(0);
export const discoSchema: ZodType<DiscoParams> = z.object({
  style: z.enum(['spectrum', 'peak', 'neural']),
  channels: z.tuple([channelSchema, channelSchema, channelSchema, channelSchema, channelSchema]),
  allowStrobe: z.boolean(),
  strobe: z.object({ palette: z.array(hex).min(1).max(6), flashesPerSecond: z.number().int().min(1).max(5) }).strict(),
  assign: z.record(z.string(), z.enum(['bass', 'voice', 'treble'])),
  smoothness: z.number().int().min(0),
  maxLightsPerBatch: z.number().int().min(1),
  bands: z.object({ bass: band, voice: band, treble: band, floorDb: z.tuple([floorDb, floorDb, floorDb]) }).strict(),
  globals: z.object({
    sensitivity: amount, advancedDecay: amount, smoothness: amount, minimumThreshold: amount, simpleSensitivity: amount, simpleDecay: amount,
    simpleMinimumThreshold: amount, analyserSensitivity: amount, smoothnessAnalyser: amount,
  }).strict(),
}).strict();

// A lamp is a linear fade of colour and level between two times. Plain data
// throughout, so preview checkpoints clone it with the pending commands.
// `commanded` marks a lamp the Disco has set at least once: the app starts
// its stream from what the lamps already show, so until a hit, flash or idle
// reaches a lamp the layer below stays visible through it.
interface Lamp { from: Colour; fromLevel: number; to: Colour; toLevel: number; start: number; end: number; commanded: boolean }
interface Command { due: number; slots: number[]; colour: Colour; level: number; duration: number }
interface ChannelState { lastHit: number; lastIdle: number; sequence: number; pulse: boolean; draws: number }
interface Layout {
  groupsKey: string; coloursKey: string;
  /** Slots per channel, and how many of them one Spectrum hit or idle takes. */
  groups: number[][]; caps: number[];
  /** Whether a slot belongs to any channel; the Disco keeps the others dark. */
  grouped: boolean[];
  /** Ambience hues in degrees, per channel; null plays the channel's hue range. */
  ambience: (number[] | null)[];
  strobe: Colour[];
}
interface DiscoState {
  layout: Layout; channels: ChannelState[]; lamps: Lamp[]; pending: Command[];
  lastFlash: number | null; strobeDraws: number;
  /** The last hop observed in any audio mode; only a different one is news. */
  heard: { generation: number; t: number } | null;
  now: number;
}
interface Context { p: DiscoParams; s: DiscoState; f: EffectFrame; now: number; literal: Colour[] | null }

const dark = (at: number): Lamp => ({ from: rgb(0, 0, 0), fromLevel: 0, to: rgb(0, 0, 0), toLevel: 0, start: at, end: at, commanded: false });

// Colour and level blend linearly together, as the stream fades both at once.
// Past its end a lamp holds its target; before its start, its origin.
function sample(lamp: Lamp, t: number): { colour: Colour; level: number } {
  if (!(t < lamp.end)) return { colour: { ...lamp.to }, level: lamp.toLevel };
  const k = t <= lamp.start ? 0 : (t - lamp.start) / (lamp.end - lamp.start);
  const mix = (a: number | undefined, b: number | undefined) => Math.round((a ?? 0) + ((b ?? 0) - (a ?? 0)) * k);
  const { from, to } = lamp;
  return { colour: { r: mix(from.r, to.r), g: mix(from.g, to.g), b: mix(from.b, to.b), w: mix(from.w, to.w), a: mix(from.a, to.a), uv: mix(from.uv, to.uv) },
    level: lamp.fromLevel + (lamp.toLevel - lamp.fromLevel) * k };
}

// A command takes over from wherever the lamp is at its start time.
function setLamp(lamp: Lamp, colour: Colour, level: number, at: number, duration: number): void {
  const current = sample(lamp, at);
  // A dark lamp has no colour to fade from: fading from black would dim the rise twice.
  lamp.from = current.level > 0 ? current.colour : solid(colour);
  lamp.fromLevel = current.level;
  lamp.to = solid(colour);
  lamp.toLevel = level;
  lamp.start = at;
  lamp.end = at + Math.max(0, duration);
  lamp.commanded = true;
}

// Releases wait in deadline order; equal deadlines keep the order they were queued in.
function schedule(s: DiscoState, due: number, slots: readonly number[], colour: Colour, level: number, duration: number): void {
  let at = s.pending.length;
  while (at > 0 && s.pending[at - 1].due > due) at--;
  s.pending.splice(at, 0, { due, slots: [...slots], colour: solid(colour), level, duration });
}

// Each due command starts at its own deadline, so a late render still sees the fade it began.
function drain(s: DiscoState, now: number): void {
  while (s.pending.length && s.pending[0].due <= now) {
    const cmd = s.pending.shift()!;
    for (const i of cmd.slots) if (s.lamps[i]) setLamp(s.lamps[i], cmd.colour, cmd.level, cmd.due, cmd.duration);
  }
}

// Without fixture ids (hand-built frames, the preview) each slot is its own fixture.
function slotIds(n: number, fixtureIds: EffectFrame['fixtureIds']): string[] {
  return Array.from({ length: n }, (_, i) => fixtureIds?.[i] != null ? String(fixtureIds[i]) : String(i));
}

// Spectrum balances the slots across its enabled bands; Peak and Neural take
// every slot on their one channel.
function buildLayout(p: DiscoParams, ids: string[], groupsKey: string, coloursKey: string): Layout {
  const groups: number[][] = [[], [], [], [], []];
  if (p.style === 'spectrum') {
    assignDiscoBands(ids, p.assign, p.channels.map((c) => c.enabled)).forEach((band, slot) => { if (band >= 0) groups[band].push(slot); });
  } else {
    const ch = p.style === 'peak' ? 3 : 4;
    if (p.channels[ch].enabled) groups[ch] = ids.map((_, slot) => slot);
  }
  // Enabled bands share the batch even when they have no lamps.
  const enabledBands = p.channels.slice(0, 3).filter((c) => c.enabled).length;
  const share = Math.max(Math.floor(p.maxLightsPerBatch / Math.max(enabledBands, 1)), 1);
  const grouped = ids.map(() => false);
  for (const group of groups) for (const slot of group) grouped[slot] = true;
  return {
    groupsKey, coloursKey, groups, caps: groups.map((g, ch) => ch < 3 ? Math.min(share, g.length) : g.length), grouped,
    ambience: p.channels.map((c) => c.useAmbience && c.palette?.length ? c.palette.map((h) => hueDegrees(parseHex(h))) : null),
    strobe: p.strobe.palette.map(parseHex),
  };
}

// Edits and layout changes arrive on a live instance: rebuild what they
// touch. A new lamp map drops queued releases, as the app does on reassigning.
function refreshLayout(p: DiscoParams, s: DiscoState, room: Room, f: EffectFrame): void {
  const ids = slotIds(room.n, f.fixtureIds);
  const groupsKey = JSON.stringify([p.style, p.assign, p.channels.map((c) => c.enabled), p.maxLightsPerBatch, ids]);
  const coloursKey = JSON.stringify([p.channels.map((c) => [c.useAmbience, c.palette]), p.strobe.palette]);
  if (s.layout.groupsKey === groupsKey && s.layout.coloursKey === coloursKey) return;
  const remapped = s.layout.groupsKey !== groupsKey;
  if (remapped) s.pending = [];
  s.layout = buildLayout(p, ids, groupsKey, coloursKey);
  while (s.lamps.length < room.n) s.lamps.push(dark(s.now));
  s.lamps.length = room.n;
  // A lamp that leaves every channel goes dark; one that moves between
  // channels keeps the fade it is in, as the app's lamps do on reassignment.
  if (remapped) s.layout.grouped.forEach((inGroup, i) => { if (!inGroup) s.lamps[i] = dark(s.now); });
}

// Each channel draws from its own stream, so one channel's hits never shift another's colours.
const roll = (c: Context, stream: number) =>
  hash01(c.f.seed, DRAW_KEY + stream, stream === STROBE_STREAM ? c.s.strobeDraws++ : c.s.channels[stream].draws++);

// Distinct within one hit; a lamp of the previous hit may be picked again.
function pickBatch(c: Context, ch: number, group: readonly number[], size: number): number[] {
  const pool = [...group];
  for (let i = 0; i < size; i++) {
    const j = i + Math.floor(roll(c, ch) * (pool.length - i));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, size);
}

// Explicit colours (an override, then the effect's palette) play literally;
// otherwise the channel's ambience hues or its hue range, at full saturation
// for the hit and the channel's own for the release.
function hitColours(c: Context, ch: number, releaseSaturation: number): { hit: Colour; release: Colour } {
  if (c.literal) {
    const colour = solid(c.literal[Math.floor(roll(c, ch) * c.literal.length)]);
    return { hit: colour, release: colour };
  }
  const ambience = c.s.layout.ambience[ch], cfg = c.p.channels[ch];
  const degrees = ambience ? ambience[Math.floor(roll(c, ch) * ambience.length)]
    : toDegrees(cfg.minHue + Math.floor(roll(c, ch) * (cfg.maxHue - cfg.minHue)));
  return { hit: hdColour(degrees, 255), release: hdColour(degrees, releaseSaturation) };
}

function flashLamp(lamp: Lamp, colour: Colour, at: number): void {
  Object.assign(lamp, { from: solid(colour), fromLevel: 1, to: solid(colour), toLevel: FLASH_FLOOR / FULL, start: at, end: at + FLASH_FALL_MS, commanded: true });
}

function idleIfDue(c: Context, ch: number): void {
  const cs = c.s.channels[ch], cfg = c.p.channels[ch];
  if (c.now < cs.lastIdle + IDLE_MS) return;
  if (ch < 3) { cs.sequence = 0; cs.pulse = false; }
  // At the render's own time: a sparse render does not replay missed idles.
  cs.lastIdle = c.now;
  const group = c.s.layout.groups[ch];
  // Spectrum idles a batch; Peak and Neural wash their whole group.
  const targets = ch < 3 ? pickBatch(c, ch, group, c.s.layout.caps[ch]) : group;
  const { hit } = hitColours(c, ch, 255);
  for (const i of targets) setLamp(c.s.lamps[i], hit, cfg.idleFadeBrightness / FULL, c.now, IDLE_MS);
}

function hitSpectrum(c: Context, ch: number, flash: Colour | null, interval: number): void {
  const cfg = c.p.channels[ch], cs = c.s.channels[ch];
  const batch = pickBatch(c, ch, c.s.layout.groups[ch], c.s.layout.caps[ch]);
  if (flash) { for (const i of batch) flashLamp(c.s.lamps[i], flash, c.now); return; }
  const { hit, release } = hitColours(c, ch, cfg.fadeSaturation);
  // The hit is instant; the release follows 32 ms later as the app's delayed command does.
  for (const i of batch) setLamp(c.s.lamps[i], hit, 1, c.now, 0);
  // Without Fade the batch holds until a later hit or idle takes it.
  if (!cfg.fade) return;
  const duration = Math.max((cs.pulse ? PULSE_MS : interval) + c.p.smoothness - 500, 0);
  schedule(c.s, c.now + SPECTRUM_RELEASE_DELAY_MS, batch, release, cfg.fadeBrightness / FULL, duration);
}

function hitPeak(c: Context, flash: Colour | null): void {
  const cfg = c.p.channels[3], cs = c.s.channels[3], group = c.s.layout.groups[3];
  const one = () => [group[Math.floor(roll(c, 3) * group.length)]];
  // A flash always takes one lamp, even with linked lights.
  if (flash) { for (const i of one()) flashLamp(c.s.lamps[i], flash, c.now); return; }
  const targets = cfg.linkLights ? group : one();
  const { hit, release } = hitColours(c, 3, cfg.fadeSaturation);
  for (const i of targets) setLamp(c.s.lamps[i], hit, 1, c.now, 0);
  // Peak holds its lamp a full 100 ms before releasing; Fade off holds it outright.
  if (!cfg.fade) return;
  const duration = Math.max((cfg.allowPulse && cs.pulse ? PULSE_MS : PEAK_FADE_MS) + c.p.smoothness - 500, 0);
  schedule(c.s, c.now + PEAK_HOLD_MS, targets, release, cfg.fadeBrightness / FULL, duration);
}

// One channel's turn: a hit (its own, or a strobe colour) if 100 ms have
// passed since the last one it took, else its idle when that is due.
function process(c: Context, ch: number, trigger: boolean, flash: Colour | null): boolean {
  const cs = c.s.channels[ch], cfg = c.p.channels[ch];
  if ((trigger || flash) && c.now >= cs.lastHit + ADMIT_MS) {
    // An ordinary release lasts as long as the gap since the last hit, up to 1.4 s.
    const interval = Math.min(MAX_INTERVAL_MS, c.now - cs.lastHit);
    // The counter steps before the wrap test, so a length of one toggles every hit.
    if (++cs.sequence >= cfg.sequenceLength) { cs.sequence = 0; cs.pulse = cfg.allowPulse && !cs.pulse; }
    cs.lastHit = c.now;
    cs.lastIdle = c.now;
    if (ch < 3) hitSpectrum(c, ch, flash, interval);
    else hitPeak(c, flash);
    return true;
  }
  idleIfDue(c, ch);
  return false;
}

// The automatic strobe needs the photosensitivity acknowledgement and stands
// down under a manual strobe; its rate is the lamp flash limit, whatever the
// manual rate stored beside it.
const autoStrobeAllowed = (c: Context) => c.f.acknowledged && !c.f.manualStrobeActive;
const canFlash = (c: Context) => hdAutoStrobeFlash(c.now, c.s.lastFlash ?? -Infinity, MAX_LAMP_FLASH_HZ);
// An override or the effect's own palette stands in for the strobe palette too.
const strobeColour = (c: Context) => {
  const palette = c.literal ?? c.s.layout.strobe;
  return solid(palette[Math.floor(roll(c, STROBE_STREAM) * palette.length)]);
};

function spectrum(c: Context, heard: AudioFrame | null): void {
  // A band switched off neither hits nor calls the strobe.
  const hit = (ch: number) => heard?.disco?.hit?.[ch] === true && c.p.channels[ch].enabled;
  const wants = autoStrobeAllowed(c) && c.p.allowStrobe && hit(0) && hit(2);
  // One colour for every batch that takes the flash.
  const flash = wants && canFlash(c) ? strobeColour(c) : null;
  let flashed = false;
  for (let ch = 0; ch < 3; ch++) {
    if (!c.p.channels[ch].enabled || !c.s.layout.groups[ch].length) continue;
    if (process(c, ch, hit(ch), flash) && flash) flashed = true;
  }
  // Only a flash some channel took uses up the permit.
  if (flashed) c.s.lastFlash = c.now;
}

function peak(c: Context, heard: AudioFrame | null): void {
  const cfg = c.p.channels[3];
  if (!cfg.enabled || !c.s.layout.groups[3].length) return;
  const hit = heard?.disco?.peakHit === true;
  const wants = autoStrobeAllowed(c) && hit && cfg.strobeOn;
  const flash = wants && canFlash(c) ? strobeColour(c) : null;
  // A flash refused by the cap holds the lamps; it is not played as a pulse.
  if (wants && !flash) return;
  if (process(c, 3, hit, flash) && flash) c.s.lastFlash = c.now;
}

// Every fresh reading sets every lamp at once; between readings they hold.
// The app's arithmetic is 32-bit float, which moves some hues a degree.
function neural(c: Context, heard: AudioFrame | null): void {
  const cfg = c.p.channels[4], group = c.s.layout.groups[4];
  if (!cfg.enabled || !group.length) return;
  if (!heard) { idleIfDue(c, 4); return; }
  const frequency = f32(unit(heard.disco?.neural?.mainFrequency)), amplitude = f32(unit(heard.disco?.neural?.amplitude));
  const bri = Math.trunc(f32(FULL * amplitude));
  const index = (n: number) => Math.trunc(f32(f32(n - 1) * frequency));
  let colour: Colour;
  if (c.literal) colour = solid(c.literal[index(c.literal.length)]);
  else {
    const ambience = c.s.layout.ambience[4];
    const degrees = ambience ? ambience[index(ambience.length)] : toDegrees(Math.trunc(f32(f32(cfg.maxHue - cfg.minHue) * frequency)) + cfg.minHue);
    colour = hdColour(degrees, cfg.modulateSaturation ? bri : 255);
  }
  for (const i of group) setLamp(c.s.lamps[i], colour, bri / FULL, c.now, 0);
  c.s.channels[4].lastIdle = c.now;
}

// Remember every valid hop in every mode, so a hop held across a switch to
// reactive is not news; only reactive mode acts on news.
function hear(s: DiscoState, f: EffectFrame): AudioFrame | null {
  const audio = f.audio;
  if (!audio || !Number.isFinite(audio.t)) return null;
  const generation = Number.isFinite(audio.generation) ? audio.generation! : 0;
  const fresh = !s.heard || s.heard.t !== audio.t || s.heard.generation !== generation;
  s.heard = { generation, t: audio.t };
  return fresh && f.audioMode === 'reactive' ? audio : null;
}

function initDisco(p: DiscoParams, room: Room, f: EffectFrame): DiscoState {
  // Channel timers start at launch: the first hit is taken 100 ms in, the first idle 2 s in.
  const launch = [f.startedAtMs, f.nowMs].find((t): t is number => Number.isFinite(t)) ?? 0;
  const s: DiscoState = {
    layout: { groupsKey: '', coloursKey: '', groups: [], caps: [], grouped: [], ambience: [], strobe: [] },
    channels: Array.from({ length: 5 }, () => ({ lastHit: launch, lastIdle: launch, sequence: 0, pulse: false, draws: 0 })),
    lamps: [], pending: [], lastFlash: null, strobeDraws: 0, heard: null, now: launch,
  };
  refreshLayout(p, s, room, f);
  return s;
}

function renderDisco(p: DiscoParams, s: DiscoState, room: Room, f: EffectFrame, out: EffectSlot[]): void {
  const now = Number.isFinite(f.nowMs) ? f.nowMs : null;
  // Releases due by now land first, under the layout that queued them and
  // before this render's hits, as in the app's loop.
  if (now !== null) drain(s, now);
  refreshLayout(p, s, room, f);
  if (now !== null) {
    const explicit = f.paletteOverride?.length || f.spec.palette?.length ? f.palette : null;
    const c: Context = { p, s, f, now, literal: explicit?.length ? explicit : null };
    s.now = now;
    const heard = hear(s, f);
    if (p.style === 'spectrum') spectrum(c, heard);
    else if (p.style === 'peak') peak(c, heard);
    else neural(c, heard);
  }
  // Ownership follows the stream: a lamp the Disco has set, or one outside
  // every channel, is its own, dark or not; one it has not reached yet is
  // left to the layer below, as a voice's untouched lamps always are.
  for (let i = 0; i < room.n; i++) {
    out[i] = { ...sample(s.lamps[i], s.now), strength: s.lamps[i].commanded || !s.layout.grouped[i] ? 1 : 0 };
  }
}

// Not a rapidFlash kind: only its automatic strobe needs the acknowledgement,
// and that is gated where the flash is decided, so the music plays regardless.
registerKind<DiscoParams, DiscoState>({
  kind: 'hd.disco', app: 'hd', schema: discoSchema, defaults: { params: DISCO_DEFAULTS, brightness: 1 }, stateful: true,
  // The automatic strobe's five-a-second limit is the instance's own (lastFlash), where the style can flash at all.
  pacesOwnFlashes: (p) => (p.style === 'spectrum' && !!p.allowStrobe) || (p.style === 'peak' && !!p.channels?.[3]?.strobeOn),
  init: initDisco, render: renderDisco,
});
