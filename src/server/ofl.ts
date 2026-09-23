/**
 * Fixture profiles from the Open Fixture Library (open-fixture-library.org).
 *
 * An OFL file describes a fixture once: every channel it has, what each range
 * of each channel does, and its DMX modes as lists of those channels. An LED
 * bar is a matrix of pixels, and a mode lists its pixels' channels through a
 * template ("Red $pixelKey") repeated for each pixel or group of pixels.
 *
 * This reads such a file into the shape parseGDTF gives — a name, a maker and
 * a profile per mode — so the settings page offers both the same way. The file
 * is anyone's: it is read through a schema that bounds everything this reads,
 * and every mode is checked as the profile it will become.
 *
 * What a mode becomes:
 *   - its dimmer (16-bit when the mode has the fine byte) and its colours are
 *     what the show drives; a pixel or group with colours of its own is a cell;
 *   - its strobe channel is the show's strobe when it is open at rest and
 *     strobes over the show's standard range, and is otherwise left to the
 *     software strobe;
 *   - every other channel sits at the file's default value, except that a
 *     shutter closed at rest is held open and a dimmer the show does not drive
 *     is held at full, so an imported fixture is never dark for a reason the
 *     operator cannot see;
 *   - a channel that switches meaning with another is read as what it is while
 *     that other channel sits where this import holds it.
 */

import { z } from 'zod';
import { EMITTERS, MAX_CELLS_PER_FIXTURE } from '../shared/rig.ts';
import { HttpError, messageOf } from '../errors.ts';
import { STROBE_FUNCTIONS } from './presets.ts';
import { profileSchema, validate } from './validation.ts';
import type { ChannelDefault, ChannelListEntry, ChannelMap, ImportedFixture, ImportedMode, ProfileCell } from '../types/rig.ts';

// ── The file ────────────────────────────────────────────────────────────────
// Only what this reads is checked, and only as far as it is read: an OFL file
// carries plenty more (physical data, links, wheels), and a newer schema may
// add fields, none of which should stop an import.

const MAX_PIXELS = 1024;
const MAX_MODE_CHANNELS = 512;
const MAX_KEYS = 2048;
// Every template channel for every pixel and group, spelled out once so a mode's
// keys are looked up rather than searched for. A real bar has a few thousand;
// past this the file is not a fixture.
const MAX_TEMPLATE_KEYS = 100_000;
const MAX_WARNINGS = 12;

const text = z.string().min(1).max(256);
const pixelKey = z.string().min(1).max(64);
const fewKeys = (what: string) => (record: Record<string, unknown>) => Object.keys(record).length <= MAX_KEYS || what;

const capabilitySchema = z.object({
  dmxRange: z.tuple([z.number().int().min(0), z.number().int().min(0)]).optional(),
  type: z.string().max(64).optional(),
  color: z.string().max(64).optional(),
  shutterEffect: z.string().max(64).optional(),
  brightness: z.string().max(32).optional(),
  brightnessStart: z.string().max(32).optional(),
  brightnessEnd: z.string().max(32).optional(),
  switchChannels: z.record(z.string().max(256).nullable()).refine((r) => Object.keys(r).length <= 64, 'switches too many channels').optional(),
}).passthrough();

const channelSchema = z.object({
  name: text.optional(),
  fineChannelAliases: z.array(text).max(3).optional(),
  dmxValueResolution: z.string().max(16).optional(),
  defaultValue: z.union([z.number().min(0), z.string().max(16)]).optional(),
  capability: capabilitySchema.optional(),
  capabilities: z.array(capabilitySchema).max(1024).optional(),
}).passthrough();

const axis = z.number().int().min(1).max(MAX_PIXELS);
const constraintSchema = z.object({
  x: z.array(z.string().max(16)).max(16).optional(),
  y: z.array(z.string().max(16)).max(16).optional(),
  z: z.array(z.string().max(16)).max(16).optional(),
  name: z.array(z.string().max(256)).max(16).optional(),
}).passthrough();

const matrixSchema = z.object({
  pixelCount: z.tuple([axis, axis, axis]).optional(),
  pixelKeys: z.array(z.array(z.array(pixelKey.nullable()).max(MAX_PIXELS)).max(MAX_PIXELS)).max(MAX_PIXELS).optional(),
  pixelGroups: z.record(z.union([z.literal('all'), z.array(pixelKey).max(MAX_PIXELS), constraintSchema]))
    .refine(fewKeys('has too many pixel groups')).optional(),
}).passthrough().superRefine((matrix, ctx) => {
  const count = matrix.pixelCount
    ? matrix.pixelCount[0] * matrix.pixelCount[1] * matrix.pixelCount[2]
    : (matrix.pixelKeys || []).flat(2).length;
  if (count > MAX_PIXELS) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `has ${count} pixels, more than ${MAX_PIXELS}` });
});

const insertSchema = z.object({
  insert: z.literal('matrixChannels'),
  repeatFor: z.union([z.string().max(32), z.array(pixelKey).max(MAX_PIXELS)]),
  channelOrder: z.enum(['perPixel', 'perChannel']),
  templateChannels: z.array(text.nullable()).min(1).max(64),
}).passthrough();

const modeSchema = z.object({
  name: text,
  channels: z.array(z.union([text, z.null(), insertSchema])).max(MAX_MODE_CHANNELS),
}).passthrough();

const oflSchema = z.object({
  name: text,
  availableChannels: z.record(channelSchema).refine(fewKeys('has too many channels')).optional(),
  templateChannels: z.record(channelSchema).refine(fewKeys('has too many template channels')).optional(),
  matrix: matrixSchema.optional(),
  modes: z.array(modeSchema).min(1).max(128),
}).passthrough();

type OflChannel = z.output<typeof channelSchema>;
type OflCapability = z.output<typeof capabilitySchema>;
type OflMatrix = z.output<typeof matrixSchema>;
type OflMode = z.output<typeof modeSchema>;
type OflFile = z.output<typeof oflSchema>;

// ── The matrix ──────────────────────────────────────────────────────────────

type Position = [number, number, number];

interface Matrix {
  /** Every pixel, in OFL's own order ("eachPixelABC": by key, numbers as numbers). */
  pixels: string[];
  position: Map<string, Position>;
  /** Each group's pixels; null when they are not known (picked by name, which is not read). */
  groups: Map<string, string[] | null>;
  /** The axes with more than one pixel along them. */
  axes: ('X' | 'Y' | 'Z')[];
  size: Position;
  /** The groups of every pixel: the fixture as a whole. */
  whole: Set<string>;
  /** Where each pixel and group is along the fixture: rows one after another, a group where its first pixel is. */
  rank: Map<string, number>;
}

const AXIS_INDEX = { X: 0, Y: 1, Z: 2 } as const;

function readMatrix(raw: OflMatrix, warnings: string[]): Matrix {
  let structure = raw.pixelKeys;
  if (!structure) {
    if (!raw.pixelCount) throw new Error('its matrix has neither pixelCount nor pixelKeys');
    const [xs, ys, zs] = raw.pixelCount;
    const axes = [xs > 1, ys > 1, zs > 1].filter(Boolean).length;
    // OFL's default keys: the position along the one axis, or "(a, b)" on two.
    const keyAt = (x: number, y: number, z: number) => {
      if (axes <= 1) return String(Math.max(x, y, z));
      if (axes === 2) return `(${xs > 1 ? x : y}, ${zs > 1 ? z : y})`;
      return `(${x}, ${y}, ${z})`;
    };
    structure = Array.from({ length: zs }, (_, z) => Array.from({ length: ys }, (_, y) =>
      Array.from({ length: xs }, (_, x) => keyAt(x + 1, y + 1, z + 1))));
  }

  const position = new Map<string, Position>();
  const size: Position = [1, 1, structure.length || 1];
  structure.forEach((plane, z) => plane.forEach((row, y) => {
    size[1] = Math.max(size[1], plane.length);
    size[0] = Math.max(size[0], row.length);
    row.forEach((key, x) => { if (key !== null) position.set(key, [x + 1, y + 1, z + 1]); });
  }));
  const pixels = [...position.keys()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const axes = (['X', 'Y', 'Z'] as const).filter((a) => size[AXIS_INDEX[a]] > 1);
  const matrix: Matrix = { pixels, position, groups: new Map(), axes, size, whole: new Set(), rank: new Map() };

  for (const [key, group] of Object.entries(raw.pixelGroups || {})) {
    if (group === 'all') matrix.groups.set(key, pixels);
    else if (Array.isArray(group)) matrix.groups.set(key, group.filter((p) => position.has(p)));
    else if (group.name) {
      // A name constraint is a regular expression from the file; running it
      // is not worth what a hostile one could cost.
      warnings.push(`Pixel group "${key}" picks its pixels by name, which is not read, so where it sits along the fixture is not known`);
      matrix.groups.set(key, null);
    } else {
      try {
        const tests = (['x', 'y', 'z'] as const).map((a) => (group[a] || []).map(constraintTest));
        matrix.groups.set(key, byOrder(matrix, 'X', 'Y', 'Z').filter((p) => {
          const pos = position.get(p) as Position;
          return tests.every((axisTests, i) => axisTests.every((test) => test(pos[i])));
        }));
      } catch (err) {
        warnings.push(`Pixel group "${key}": ${messageOf(err)}, so where it sits along the fixture is not known`);
        matrix.groups.set(key, null);
      }
    }
  }

  byOrder(matrix, 'X', 'Y', 'Z').forEach((pixel, i) => matrix.rank.set(pixel, i));
  for (const [key, members] of matrix.groups) {
    if (position.has(key) || !members) continue;
    if (new Set(members).size === pixels.length) matrix.whole.add(key);
    let first = Infinity;
    for (const pixel of members) first = Math.min(first, matrix.rank.get(pixel) ?? Infinity);
    matrix.rank.set(key, first);
  }
  return matrix;
}

/** One of OFL's position constraints ("=3", ">=7", "<=6", "2n+1", "even", "odd") as a test. */
function constraintTest(constraint: string): (position: number) => boolean {
  let m = /^(=|>=|<=)(\d+)$/.exec(constraint);
  if (m) {
    const n = Number(m[2]);
    return m[1] === '=' ? (p) => p === n : m[1] === '>=' ? (p) => p >= n : (p) => p <= n;
  }
  m = /^(\d+)n(?:\+(\d+))?$/.exec(constraint.replace(/^even$/, '2n').replace(/^odd$/, '2n+1'));
  if (m && Number(m[1]) > 0) {
    const divisor = Number(m[1]);
    const remainder = Number(m[2] || 0);
    return (p) => p % divisor === remainder;
  }
  throw new Error(`"${constraint}" is not a position constraint`);
}

/** The pixels ordered by the third axis, then the second, then the first (OFL's eachPixelXYZ and kin). */
function byOrder(matrix: Matrix, first: keyof typeof AXIS_INDEX, second: keyof typeof AXIS_INDEX, third: keyof typeof AXIS_INDEX): string[] {
  const [a, b, c] = [AXIS_INDEX[first], AXIS_INDEX[second], AXIS_INDEX[third]];
  return [...matrix.pixels].sort((p, q) => {
    const pp = matrix.position.get(p) as Position;
    const qp = matrix.position.get(q) as Position;
    return (pp[c] - qp[c]) || (pp[b] - qp[b]) || (pp[a] - qp[a]);
  });
}

/** The pixels or groups a matrix insert repeats its template channels for, in order. */
function repeatKeys(repeatFor: string | string[], matrix: Matrix): string[] {
  if (Array.isArray(repeatFor)) return repeatFor;
  if (repeatFor === 'eachPixelABC') return matrix.pixels;
  if (repeatFor === 'eachPixelGroup') return [...matrix.groups.keys()];
  const m = /^eachPixel([XYZ])([XYZ])([XYZ])$/.exec(repeatFor);
  if (m && new Set(m.slice(1)).size === 3) {
    return byOrder(matrix, m[1] as 'X', m[2] as 'X', m[3] as 'X');
  }
  throw new Error(`it repeats its channels for "${repeatFor}", which is not an OFL order`);
}

// ── Channels ────────────────────────────────────────────────────────────────

/**
 * A channel of the file, as a mode uses it. A template channel keeps the
 * template's own definition — what its ranges do is the same for every pixel —
 * and fills the pixel into the names it is looked up by (fillFor).
 */
interface Channel {
  key: string;
  def: OflChannel;
  /** The pixel or group it belongs to; null for the fixture as a whole. */
  pixel: string | null;
}

/** A key the file wrote, as it names this channel's pixel: "Speed $pixelKey" for pixel 3 is "Speed 3". */
const fillFor = (channel: Channel, text: string) => (channel.pixel === null ? text : fill(text, channel.pixel));

/** The name to show for a channel. */
const nameOf = (channel: Channel) => (channel.def.name ? fillFor(channel, channel.def.name) : channel.key);

/** A key a mode names, what it names, and the key as the file wrote it (a template's, before filling). */
interface Found {
  origin: KeyOrigin;
  channel: Channel;
  written: string;
}

/** What a key names: a channel, one of its fine bytes, or a switching alias of it. */
interface KeyOrigin {
  channel: string;
  role: 'coarse' | 'fine' | 'switching';
  fine: number;
}

const PIXEL_KEY = '$pixelKey';
const fill = (template: string, pixel: string) => template.split(PIXEL_KEY).join(pixel);

function originsOf(channels: Record<string, OflChannel>): Map<string, KeyOrigin> {
  const origins = new Map<string, KeyOrigin>();
  for (const [key, def] of Object.entries(channels)) {
    origins.set(key, { channel: key, role: 'coarse', fine: 0 });
    (def.fineChannelAliases || []).forEach((alias, i) => origins.set(alias, { channel: key, role: 'fine', fine: i + 1 }));
    // OFL lists a channel's switching aliases on every capability; the first says which there are.
    for (const alias of Object.keys(capsOf(def)[0]?.switchChannels || {})) {
      origins.set(alias, { channel: key, role: 'switching', fine: 0 });
    }
  }
  return origins;
}

/** The file's channels, looked up by the keys its modes use. */
function channelIndex(file: OflFile, matrix: Matrix | null) {
  const available = file.availableChannels || {};
  const templates = file.templateChannels || {};
  const availableOrigins = originsOf(available);
  const templateOrigins = originsOf(templates);
  const scopes = [...new Set([...(matrix?.pixels || []), ...(matrix?.groups.keys() || [])])];

  // Every template key as a mode may name it ("Red Master", "Red 7"), and what it is.
  if (templateOrigins.size * scopes.length > MAX_TEMPLATE_KEYS) {
    throw new HttpError(400, `OFL file: ${templateOrigins.size} template channels for ${scopes.length} pixels and groups is more than a fixture has`);
  }
  const templateKeys = new Map<string, { template: string; pixel: string }>();
  for (const template of templateOrigins.keys()) {
    if (!template.includes(PIXEL_KEY)) continue;
    for (const pixel of scopes) {
      const key = fill(template, pixel);
      if (!templateKeys.has(key)) templateKeys.set(key, { template, pixel });
    }
  }

  const fromTemplate = (template: string, pixel: string): Found | null => {
    const origin = templateOrigins.get(template);
    if (!origin) return null;
    const key = fill(origin.channel, pixel);
    return { origin: { ...origin, channel: key }, channel: { key, def: templates[origin.channel], pixel }, written: template };
  };

  /** A key as a mode lists it: a channel of the fixture, or a template's for one pixel or group. */
  function byKey(key: string): Found | null {
    const origin = availableOrigins.get(key);
    if (origin) return { origin, channel: { key: origin.channel, def: available[origin.channel], pixel: null }, written: key };
    const templated = templateKeys.get(key);
    return templated ? fromTemplate(templated.template, templated.pixel) : null;
  }

  /** A template key of a matrix insert, for one pixel or group. */
  const byTemplate = (template: string, pixel: string): Found | null => fromTemplate(template, pixel);

  return { byKey, byTemplate };
}

// ── What a channel does ─────────────────────────────────────────────────────

function capsOf(def: OflChannel): OflCapability[] {
  if (def.capabilities) return def.capabilities;
  return def.capability ? [def.capability] : [];
}

const RESOLUTIONS: Record<string, number> = { '8bit': 1, '16bit': 2, '24bit': 3, '32bit': 4 };

/** Bytes in the channel's DMX values (its fine aliases make it wider). */
const widthOf = (def: OflChannel) => 1 + (def.fineChannelAliases?.length || 0);

/** Bytes its capability ranges and default value are written in. */
function resolutionOf(def: OflChannel): number {
  const named = RESOLUTIONS[def.dmxValueResolution || ''];
  return named && named <= widthOf(def) ? named : widthOf(def);
}

function rangeOf(cap: OflCapability, resolution: number): [number, number] {
  return cap.dmxRange || [0, 256 ** resolution - 1];
}

function capabilityAt(def: OflChannel, value: number): OflCapability | null {
  const resolution = resolutionOf(def);
  return capsOf(def).find((cap) => {
    const [lo, hi] = rangeOf(cap, resolution);
    return value >= lo && value <= hi;
  }) || null;
}

/** An OFL brightness ("0%", "off", "bright", "1200lm") as a number to compare, or null. */
function brightnessOf(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  if (raw === 'off') return 0;
  if (raw === 'dark') return 1;
  if (raw === 'bright') return 100;
  const m = /^(\d+(?:\.\d+)?)(%|lm)?$/.exec(raw);
  return m ? Number(m[1]) : null;
}

/** An Intensity capability's brightness at the bottom and top of its range. */
function brightnessEnds(cap: OflCapability): [number, number] {
  const start = brightnessOf(cap.brightnessStart ?? cap.brightness) ?? 0;
  const end = brightnessOf(cap.brightnessEnd ?? cap.brightness) ?? 100;
  return [start, end];
}

type Kind =
  | { kind: 'dimmer' }
  | { kind: 'colour'; colour: string }
  | { kind: 'shutter' }
  | { kind: 'other'; type: string };

// What a channel does is the same for every pixel of a template, so each is
// worked out once per definition.
const kinds = new WeakMap<OflChannel, Kind>();
const rests = new WeakMap<OflChannel, Rest>();

function kindOf(def: OflChannel): Kind {
  let kind = kinds.get(def);
  if (!kind) kinds.set(def, kind = classify(def));
  return kind;
}

/** What a channel is, by what its ranges do (ranges that do nothing aside). */
function classify(def: OflChannel): Kind {
  const caps = capsOf(def).filter((cap) => cap.type !== 'NoFunction');
  if (!caps.length) return { kind: 'other', type: 'NoFunction' };
  // A dimmer that is brightest at 0 would be driven backwards; it is left alone.
  if (caps.every((cap) => cap.type === 'Intensity' && brightnessEnds(cap)[1] >= brightnessEnds(cap)[0])) return { kind: 'dimmer' };
  const colour = caps[0].color;
  if (colour && caps.every((cap) => cap.type === 'ColorIntensity' && cap.color === colour)) return { kind: 'colour', colour };
  if (caps.some((cap) => cap.type === 'ShutterStrobe' && FLASH_EFFECTS.has(cap.shutterEffect || ''))) return { kind: 'shutter' };
  // Anything else is named for what most of its range does.
  const resolution = resolutionOf(def);
  const width = new Map<string, number>();
  for (const cap of caps) {
    const [lo, hi] = rangeOf(cap, resolution);
    const type = cap.type || 'Generic';
    width.set(type, (width.get(type) || 0) + hi - lo + 1);
  }
  return { kind: 'other', type: [...width].sort((a, b) => b[1] - a[1])[0][0] };
}

/** Shutter effects that flash: a channel with one of them is a strobe, not just a shutter. */
const FLASH_EFFECTS = new Set(['Strobe', 'Pulse', 'RampUp', 'RampDown', 'RampUpDown', 'Lightning', 'Spikes', 'Burst']);

const COLOURS: Record<string, string> = { Red: 'red', Green: 'green', Blue: 'blue', White: 'white', Amber: 'amber', UV: 'uv' };

/** "ColorPreset" → "colorPreset", "Warm White" → "warmWhite": an attribute for what the show does not drive. */
const camel = (words: string) => words.charAt(0).toLowerCase() + words.slice(1).replace(/\s+(\w)/g, (_, c: string) => c.toUpperCase());

/** The file's default value, in the channel's own resolution. */
function defaultOf(def: OflChannel): number {
  const top = 256 ** resolutionOf(def) - 1;
  const raw = def.defaultValue;
  if (typeof raw === 'number') return Math.min(top, Math.floor(raw));
  const pct = typeof raw === 'string' ? /^(\d+(?:\.\d+)?)%$/.exec(raw) : null;
  return pct ? Math.floor(Math.min(100, Number(pct[1])) / 100 * top) : 0;
}

interface Rest {
  value: number;
  /** Why it is not the file's default: held open, held at full, or closed with no open value. */
  why: 'open' | 'full' | 'closed' | null;
}

function restOf(def: OflChannel): Rest {
  let rest = rests.get(def);
  if (!rest) rests.set(def, rest = findRest(def));
  return rest;
}

/**
 * Where a channel the show does not drive sits: its default, unless that
 * leaves the light dark — then the first open value of a shutter, or the
 * brightest value of a dimmer.
 */
function findRest(def: OflChannel): Rest {
  const value = defaultOf(def);
  const resolution = resolutionOf(def);
  const caps = capsOf(def);
  const at = capabilityAt(def, value);
  if (at?.type === 'ShutterStrobe' && at.shutterEffect === 'Closed') {
    const open = caps.find((cap) => cap.type === 'ShutterStrobe' && cap.shutterEffect === 'Open')
      || caps.find((cap) => cap.type === 'NoFunction');
    return open ? { value: rangeOf(open, resolution)[0], why: 'open' } : { value, why: 'closed' };
  }
  if (at?.type === 'Intensity') {
    let best = { value, brightness: -1 };
    for (const cap of caps) {
      if (cap.type !== 'Intensity') continue;
      const [lo, hi] = rangeOf(cap, resolution);
      const [start, end] = brightnessEnds(cap);
      if (start > best.brightness) best = { value: lo, brightness: start };
      if (end >= best.brightness) best = { value: hi, brightness: end };
    }
    if (best.value !== value) return { value: best.value, why: 'full' };
  }
  return { value, why: null };
}

const STANDARD_STROBE = STROBE_FUNCTIONS.find((f) => f.id === 'standard') || STROBE_FUNCTIONS[0];
const FLASHING = new Set(['Strobe', 'Pulse']);

/**
 * Can the show run this channel as its strobe? It writes nothing to it at rest
 * but the rest value, so that must leave the light open, and it writes the
 * standard strobe's range when flashing, so all of that must flash.
 */
function strobesLikeTheShow(def: OflChannel, rest: number): boolean {
  const at = capabilityAt(def, rest);
  if (!at || !(at.type === 'NoFunction' || (at.type === 'ShutterStrobe' && at.shutterEffect === 'Open'))) return false;
  const step = 256 ** (resolutionOf(def) - 1);
  for (let v = STANDARD_STROBE.lo; v <= STANDARD_STROBE.hi; v++) {
    const cap = capabilityAt(def, v * step);
    if (!cap || cap.type !== 'ShutterStrobe' || !FLASHING.has(cap.shutterEffect || '')) return false;
  }
  return true;
}

/** Byte `index` (0 the coarse one) of a value in the channel's resolution, on a channel `width` bytes wide. */
function byteOf(value: number, resolution: number, width: number, index: number): number {
  const wide = value * 256 ** (width - resolution);
  return Math.floor(wide / 256 ** (width - 1 - index)) % 256;
}

// ── Modes ───────────────────────────────────────────────────────────────────

/** One DMX channel of a mode: the byte of which channel it is, or unused. */
interface Slot {
  offset: number;
  name: string;
  channel: Channel | null;
  /** 0 for a channel's coarse byte, 1… for its fine bytes. */
  fine: number;
}

type Index = ReturnType<typeof channelIndex>;

/** A mode's channel list with its matrix inserts spelled out, one entry per DMX channel. */
function expand(mode: OflMode, matrix: Matrix | null): ({ key: string | null } | { template: string | null; pixel: string })[] {
  const out: ({ key: string | null } | { template: string | null; pixel: string })[] = [];
  for (const item of mode.channels) {
    if (item === null || typeof item === 'string') {
      out.push({ key: item });
      continue;
    }
    if (!matrix) throw new Error('it repeats channels per pixel, but the file has no matrix');
    const pixels = repeatKeys(item.repeatFor, matrix);
    if (item.channelOrder === 'perPixel') {
      for (const pixel of pixels) for (const template of item.templateChannels) out.push({ template, pixel });
    } else {
      for (const template of item.templateChannels) for (const pixel of pixels) out.push({ template, pixel });
    }
    if (out.length > MAX_MODE_CHANNELS) throw new Error(`it has more than ${MAX_MODE_CHANNELS} channels, more than a universe holds`);
  }
  return out;
}

/** Every DMX channel of a mode, as the channel it is a byte of, switching channels resolved. */
function slotsOf(mode: OflMode, matrix: Matrix | null, index: Index, warnings: string[]): Slot[] {
  return expand(mode, matrix).map((entry, offset) => {
    const named = 'key' in entry ? entry.key : entry.template && fill(entry.template, entry.pixel);
    if (named === null) return { offset, name: 'Unused', channel: null, fine: 0 };
    let found = 'key' in entry ? index.byKey(named) : index.byTemplate(entry.template as string, entry.pixel);
    if (!found) {
      warnings.push(`"${named}" is not a channel of the file; it is left at 0`);
      return { offset, name: named, channel: null, fine: 0 };
    }
    if (found.origin.role === 'switching') {
      // What the alias is depends on another channel's value; this import holds
      // that channel still, so the alias is what it is at that value.
      const trigger = found.channel;
      const held = restOf(trigger.def).value;
      // A template's switches are written for "$pixelKey"; this is the trigger's pixel's.
      const written = capabilityAt(trigger.def, held)?.switchChannels?.[found.written] ?? null;
      const target = written === null ? null : fillFor(trigger, written);
      const triggerName = nameOf(trigger);
      if (target === null) {
        warnings.push(`"${named}" does nothing while "${triggerName}" sits at ${held}`);
        return { offset, name: named, channel: null, fine: 0 };
      }
      const resolved = index.byKey(target);
      if (!resolved || resolved.origin.role === 'switching') {
        warnings.push(`"${named}" switches to "${target}", which is not a channel of the file; it is left at 0`);
        return { offset, name: named, channel: null, fine: 0 };
      }
      warnings.push(`"${named}" is read as "${target}": it changes with "${triggerName}", which sits at ${held}`);
      found = resolved;
    }
    const name = found.origin.role === 'coarse' && found.origin.channel === named ? nameOf(found.channel) : named;
    return { offset, name: name.slice(0, 128), channel: found.channel, fine: found.origin.fine };
  });
}

/** One channel of the mode with every byte of it the mode has. */
interface ModeChannel {
  channel: Channel;
  kind: Kind;
  bytes: Map<number, number>; // byte index → offset
  first: number;
}

/** One mode of the file as a profile. */
function readMode(mode: OflMode, matrix: Matrix | null, index: Index): ImportedMode {
  const warnings: string[] = [];
  const slots = slotsOf(mode, matrix, index, warnings);
  if (!slots.length) throw new Error('it has no channels');

  const channels = new Map<string, ModeChannel>();
  for (const slot of slots) {
    if (!slot.channel) continue;
    const existing = channels.get(slot.channel.key);
    if (existing && !existing.bytes.has(slot.fine)) existing.bytes.set(slot.fine, slot.offset);
    else if (!existing) {
      channels.set(slot.channel.key, {
        channel: slot.channel, kind: kindOf(slot.channel.def), bytes: new Map([[slot.fine, slot.offset]]), first: slot.offset,
      });
    }
  }
  const inOrder = [...channels.values()].sort((a, b) => a.first - b.first);

  // A lamp with both a warm and a cold white die gets both; with one, it is the lamp's white.
  const colours = new Set(inOrder.map((c) => (c.kind.kind === 'colour' ? c.kind.colour : '')));
  const splitWhites = colours.has('Warm White') && colours.has('Cold White');
  const attributeOf = (kind: Kind): { attribute: string; driven: boolean } => {
    if (kind.kind === 'dimmer') return { attribute: 'dimmer', driven: true };
    if (kind.kind === 'shutter') return { attribute: 'strobe', driven: true };
    if (kind.kind === 'other') return { attribute: camel(kind.type), driven: false };
    if (kind.colour === 'Warm White' || kind.colour === 'Cold White') {
      return splitWhites
        ? { attribute: kind.colour === 'Warm White' ? 'warmWhite' : 'coolWhite', driven: true }
        : { attribute: 'white', driven: true };
    }
    return COLOURS[kind.colour] ? { attribute: COLOURS[kind.colour], driven: true } : { attribute: camel(kind.colour), driven: false };
  };

  // Cells: the pixels with colours of their own, or failing that the groups
  // that have them — a group of every pixel is the fixture, not a cell.
  const spansAll = (scope: string) => !!matrix?.whole.has(scope);
  const isPixel = (scope: string) => !!matrix?.position.has(scope);
  const lit = new Set<string>();
  for (const c of inOrder) {
    const { attribute, driven } = attributeOf(c.kind);
    if (c.channel.pixel !== null && driven && EMITTERS.includes(attribute) && !spansAll(c.channel.pixel)) lit.add(c.channel.pixel);
  }
  const litPixels = [...lit].filter(isPixel);
  let cellScopes = litPixels.length >= 2 ? litPixels : [...lit].filter((s) => !isPixel(s));
  if (cellScopes.length < 2) cellScopes = [];

  // Along the fixture: by position, rows one after another, a group where its first pixel is.
  const rankOf = (scope: string) => matrix?.rank.get(scope) ?? Infinity;
  cellScopes.sort((a, b) => rankOf(a) - rankOf(b));
  if (cellScopes.length > MAX_CELLS_PER_FIXTURE) {
    warnings.push(`${cellScopes.length} cells is more than the ${MAX_CELLS_PER_FIXTURE} a fixture may have; only the first are used`);
    cellScopes = cellScopes.slice(0, MAX_CELLS_PER_FIXTURE);
  }
  const cellOf = new Map(cellScopes.map((scope, i) => [scope, i]));
  if (cellScopes.length && isPixel(cellScopes[0]) && matrix && matrix.axes.length > 1) {
    warnings.push(`The pixels are a ${matrix.size.filter((n) => n > 1).join(' × ')} grid; they are laid along one line, row by row`);
  }

  // Which map drives each channel: the fixture's, a cell's, or none.
  const channelMap: ChannelMap = {};
  const cellMaps: ChannelMap[] = cellScopes.map(() => ({}));
  const undrivenGroups = new Set<string>();
  const undrivenColours = new Set<string>();
  const drivenBy = new Map<ModeChannel, string>();
  let strobeTried = false;
  for (const c of inOrder) {
    const { attribute, driven } = attributeOf(c.kind);
    if (!driven) {
      if (c.kind.kind === 'colour') undrivenColours.add(c.kind.colour);
      continue;
    }
    const scope = c.channel.pixel;
    const cell = scope === null ? undefined : cellOf.get(scope);
    const fixtureLevel = scope === null || spansAll(scope) || (!cellScopes.length && cell === undefined);
    const map = cell !== undefined ? cellMaps[cell] : fixtureLevel ? channelMap : null;
    if (!map) {
      if (scope !== null && !isPixel(scope) && EMITTERS.includes(attribute)) undrivenGroups.add(scope);
      continue;
    }
    if (attribute === 'strobe') {
      // Only the fixture's own strobe, and only one the show can run as it runs a strobe.
      // The first strobe channel of the fixture is its strobe; any after it are left alone.
      if (map !== channelMap || strobeTried) continue;
      strobeTried = true;
      if (!strobesLikeTheShow(c.channel.def, restOf(c.channel.def).value)) {
        warnings.push(`"${nameOf(c.channel)}" does not strobe as the show expects (open at rest, flashing from ${STANDARD_STROBE.lo} to ${STANDARD_STROBE.hi}), so the show flashes this fixture itself`);
        continue;
      }
    }
    if (attribute in map) continue;
    const coarse = c.bytes.get(0);
    if (coarse === undefined) continue;
    map[attribute] = coarse;
    drivenBy.set(c, attribute);
    const fine = c.bytes.get(1);
    if (attribute === 'dimmer' && fine !== undefined && !('dimmerFine' in map)) map.dimmerFine = fine;
  }
  if (undrivenColours.size) {
    warnings.push(`${[...undrivenColours].join(' and ')} ${undrivenColours.size > 1 ? 'are' : 'is'} not driven: the show mixes from red, green, blue, white, amber and UV`);
  }
  if (undrivenGroups.size) {
    warnings.push(`The channels of pixel groups (${[...undrivenGroups].join(', ')}) are not driven: the show drives each pixel`);
  }

  // Every channel the show does not drive sits where restOf says; the strobe
  // it does drive sits at its open value between flashes.
  const defaults: ChannelDefault[] = [];
  for (const c of inOrder) {
    const attribute = drivenBy.get(c);
    const dimmerFine = attribute === 'dimmer' ? c.bytes.get(1) : undefined;
    if (attribute && attribute !== 'strobe') {
      // A byte past the ones the show writes (a 24-bit dimmer's last) still gets its default.
      for (const [byte, offset] of c.bytes) {
        if (byte > 1 || (byte === 1 && dimmerFine === undefined)) pushDefault(defaults, offset, byteOf(defaultOf(c.channel.def), resolutionOf(c.channel.def), widthOf(c.channel.def), byte));
      }
      continue;
    }
    const rest = restOf(c.channel.def);
    const name = nameOf(c.channel);
    for (const [byte, offset] of c.bytes) {
      pushDefault(defaults, offset, byteOf(rest.value, resolutionOf(c.channel.def), widthOf(c.channel.def), byte));
    }
    if (rest.why === 'open') warnings.push(`"${name}" is held at ${rest.value}, open, so the light is not shut`);
    else if (rest.why === 'full') warnings.push(`"${name}" is held at ${rest.value}, full: the show does not drive it`);
    else if (rest.why === 'closed') warnings.push(`"${name}" shuts the light at rest and has no open value; the fixture stays dark in this mode`);
  }
  defaults.sort((a, b) => a.offset - b.offset);

  const cellOfChannel = (channel: Channel | null) => (channel?.pixel == null ? undefined : cellOf.get(channel.pixel));
  const channelList: ChannelListEntry[] = slots.map((slot) => {
    const c = slot.channel ? channels.get(slot.channel.key) : undefined;
    const base = c ? (drivenBy.get(c) || attributeOf(c.kind).attribute) : slot.channel === null && slot.name !== 'Unused' ? 'unknown' : 'noFunction';
    const attribute = slot.fine === 0 ? base : `${base}Fine`;
    const cell = cellOfChannel(slot.channel);
    return { offset: slot.offset, name: slot.name, attribute, ...(cell !== undefined ? { cell } : {}) };
  });

  if (!drivenBy.size) warnings.push('The show drives nothing in this mode: it has no dimmer or colour channels');

  const result: ImportedMode = { modeName: mode.name.slice(0, 128), channelCount: slots.length, channelMap, channelList };
  if (cellScopes.length) {
    result.cells = cellScopes.map((scope, i): ProfileCell => ({
      name: (isPixel(scope) ? `Pixel ${scope}` : `Group ${scope}`).slice(0, 64),
      channelMap: cellMaps[i],
    }));
  }
  if (defaults.length) result.defaults = defaults;
  const unique = [...new Set(warnings)];
  if (unique.length > MAX_WARNINGS) unique.splice(MAX_WARNINGS - 1, Infinity, `…and ${unique.length - MAX_WARNINGS + 1} more`);
  if (unique.length) result.warnings = unique;
  return result;
}

function pushDefault(defaults: ChannelDefault[], offset: number, value: number): void {
  if (value > 0) defaults.push({ offset, value });
}

/**
 * Read an OFL fixture file. `manufacturer` is the maker's name: the file does
 * not carry it (the library files it under the maker's folder). Throws a 400
 * when the file is not an OFL fixture or none of its modes can be used.
 */
function parseOfl(json: unknown, { manufacturer }: { manufacturer?: string | null } = {}): ImportedFixture {
  const file = validate(oflSchema, json, 'OFL file');
  const fileWarnings: string[] = [];
  const matrix = file.matrix ? readMatrix(file.matrix, fileWarnings) : null;
  const index = channelIndex(file, matrix);
  const name = file.name.slice(0, 128);

  const modes: ImportedMode[] = [];
  const skipped: string[] = [];
  for (const mode of file.modes) {
    try {
      const read = readMode(mode, matrix, index);
      // Checked as the profile it becomes, so the page never offers a mode
      // that adding would then refuse.
      validate(profileSchema, { id: 'ofl-import', name, ...read }, 'profile');
      if (fileWarnings.length) read.warnings = [...fileWarnings, ...(read.warnings || [])];
      modes.push(read);
    } catch (err) {
      skipped.push(`${mode.name} is left out: ${messageOf(err)}`);
    }
  }
  if (!modes.length) throw new HttpError(400, `OFL file: no mode of ${name} can be used (${skipped.join('; ')})`);

  const result: ImportedFixture = { name, manufacturer: (manufacturer || 'Unknown').slice(0, 128), modes };
  if (skipped.length) result.warnings = skipped;
  return result;
}

export {
  parseOfl,
  oflSchema,
};
