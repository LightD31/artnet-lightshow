import { z } from 'zod';
import net from 'node:net';
import { COLOR_PRESETS, AUTO_SOURCES, TEMPO_MODES, SYNC_OFFSET_LIMIT_MS } from './presets.ts';
import { PALETTE_IDS } from './palettes.ts';
import { FIXTURE_GROUPS } from '../shared/stage.ts';
import { EMITTERS, PIXEL_MAPS, MAX_CELLS_PER_FIXTURE, MAX_PROFILE_CHANNELS } from '../shared/rig.ts';
import { HUE_BRIDGE_ID_RE, stripIssue } from '../shared/placement.ts';
import { parseHex } from '../shared/effects/palette.ts';
import { HttpError } from '../errors.ts';

export class ValidationError extends HttpError {
  issues: z.ZodIssue[];

  constructor(message: string, issues: z.ZodIssue[]) {
    super(400, message);
    this.issues = issues;
  }
}

const u8 = z.number().int().min(0).max(255);
const gridSize = z.number().int().min(1).max(MAX_CELLS_PER_FIXTURE);
const gridIndex = z.number().int().min(0).max(MAX_CELLS_PER_FIXTURE - 1);
const fixtureId = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1);
const fixturePosition = z.object({
  x: z.number().finite().min(0).max(100),
  y: z.number().finite().min(0).max(100),
  height: z.number().min(0).max(100).optional(),
}).strict();
const fixtureGroup = z.enum(FIXTURE_GROUPS);
const fixtureGeometry = z.object({
  length: z.number().finite().min(1).max(100),
  angle: z.number().finite().min(-180).max(180),
}).strict();
const colorIdx = z.number().int().min(0).max(COLOR_PRESETS.length - 1);
const unitValue = z.number().min(0).max(1).optional();

const hexColour = z.string().max(16).refine((value) => {
  try { parseHex(value); return true; } catch { return false; }
}, { message: 'expected a hex colour (#RGB, #RRGGBB or #RRGGBBWW)' });

const paletteOverride = z.array(hexColour).min(1).max(8).nullable();

const HOSTNAME_RE = /^(?=.{1,253}$)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

const hueOutput = z.object({
  protocol: z.literal('hue'),
  bridge: z.string().regex(HUE_BRIDGE_ID_RE, 'is not a bridge id').optional(),
  channel: z.number().int().min(0).max(255),
}).strict();
const ddpOutput = z.object({
    protocol: z.literal('ddp'),
    host: z.string().regex(HOSTNAME_RE, 'is not a hostname or an IPv4 address'),
    port: z.number().int().min(1).max(65535).optional(),
    at: z.number().int().min(0).max(65535).optional(),
    rowStride: z.number().int().min(1).max(4096).optional(),
    leds: z.number().int().min(1).max(65535).optional(),
    columns: z.number().int().min(1).max(4096).optional(),
    areas: z.array(z.tuple([
      z.number().int().min(0).max(4095), z.number().int().min(0).max(4095),
      z.number().int().min(1).max(4096), z.number().int().min(1).max(4096),
    ])).max(MAX_CELLS_PER_FIXTURE).optional(),
  }).strict();
const openrgbOutput = z.object({
  protocol: z.literal('openrgb'),
  host: z.string().regex(HOSTNAME_RE, 'is not a hostname or an IPv4 address'),
  port: z.number().int().min(1).max(65535).optional(),
  device: z.number().int().min(0).max(4095),
  name: z.string().trim().min(1).max(128).optional(),
  leds: z.number().int().min(1).max(MAX_CELLS_PER_FIXTURE),
}).strict();
const deviceOutput = z.discriminatedUnion('protocol', [ddpOutput, openrgbOutput]);
const fixtureOutput = z.discriminatedUnion('protocol', [ddpOutput, openrgbOutput, hueOutput]);

// Apply IPv4 rules to dotted numeric input so malformed addresses cannot pass as hostnames.
const DOTTED_NUMERIC_RE = /^[0-9]+(\.[0-9]+)*$/;

const artnetHost = z.string().min(1).max(253)
  .refine((v) => (DOTTED_NUMERIC_RE.test(v) ? net.isIPv4(v) : HOSTNAME_RE.test(v)),
    { message: 'must be an IPv4 address or hostname' });

const artnetSchema = z.object({
  enabled: z.boolean().optional(),
  host: artnetHost.optional(),
  port: z.number().int().min(1).max(65535).optional(),
  universe: z.number().int().min(0).max(32767).optional(),
  discovery: z.boolean().optional(),
  sync: z.boolean().optional(),
}).strict();

const patchSchema = z.object({
  bpm: z.number().min(20).max(300).optional(),
  tempoMode: z.enum(TEMPO_MODES).optional(),
  anchorMs: z.number().finite().optional(),
  beatDivision: z.number().int().min(1).max(16).optional(),
  running: z.boolean().optional(),
  pattern: z.string().min(1).max(64).optional(),
  // Crossfade into this patch's pattern and colours rather than cutting.
  fadeMs: z.number().int().min(0).max(10000).optional(),
  split: z.number().int().min(0).max(1e9).nullable().optional(),
  pixelMap: z.enum(PIXEL_MAPS).optional(),
  pixelPattern: z.string().min(1).max(64).nullable().optional(),
  pixelSpan: z.number().min(0).max(4096).nullable().optional(),
  pixelFrom: z.number().min(0).max(1).nullable().optional(),
  panelPattern: z.string().min(1).max(64).nullable().optional(),
  colorA: colorIdx.optional(),
  colorB: colorIdx.optional(),
  colorC: colorIdx.optional(),
  colorD: colorIdx.optional(),
  showDynamics: z.object({
    level: unitValue, bass: unitValue, vocal: unitValue, air: unitValue,
    width: unitValue, motion: unitValue, decay: unitValue,
  }).strict().nullable().optional(),
  masterDimmer: u8.optional(),
  masterBlackout: z.boolean().optional(),
  strobeSpeed: u8.optional(),
  strobeFunction: z.string().min(1).max(64).optional(),
  energyOverride: z.union([z.string().min(1).max(64), z.null()]).optional(),
  paletteOverride: paletteOverride.optional(),
  // Explain unknown palette IDs explicitly so a failed selection is not a generic validation error.
  palette: z.union([z.enum(PALETTE_IDS as [string, ...string[]]), z.null()], {
    error: `is not a known palette (${PALETTE_IDS.join(', ')})`,
  }).optional(),
  paletteSize: z.union([z.literal(2), z.literal(3), z.literal(4)]).optional(),
  artnet: artnetSchema.optional(),
  prolinkEnabled: z.boolean().optional(),
  autoSource: z.enum(AUTO_SOURCES).optional(),
  autoPaletteSize: z.union([z.literal(2), z.literal(3), z.literal(4),
    z.literal('auto')]).optional(),
  autoIntensity: z.number().min(0).max(100).optional(),
  autoSyncOffsetMs: z.number().int()
    .min(-SYNC_OFFSET_LIMIT_MS).max(SYNC_OFFSET_LIMIT_MS).optional(),
  autoPrefetchDepth: z.number().int().min(1).max(5).optional(),
}).strict();

const overrideSchema = z.object({
  enabled: z.boolean(),
  r: u8.default(0),
  g: u8.default(0),
  b: u8.default(0),
  w: u8.default(0),
  a: u8.default(0),
  uv: u8.default(0),
  dim: u8.default(255),
  strobe: u8.default(0),
  blackout: z.boolean().default(false),
}).strict();

const overrideMessageSchema = z.object({
  id: fixtureId,
  override: z.union([overrideSchema, z.null()]),
});

const dmxUniverse = z.number().int().min(0).max(32767);

const fixtureAddSchema = z.object({
  universe: dmxUniverse.optional(),
  profileId: z.string().min(1).max(128).optional(),
  count: z.number().int().min(1).max(64).optional(),
  address: z.number().int().min(1).max(512).optional(),
  label: z.string().trim().min(1).max(56).optional(),
}).strict();

const fixtureMessageSchema = z.object({
  id: fixtureId,
  position: fixturePosition.nullable().optional(),
  group: fixtureGroup.nullable().optional(),
  address: z.number().int().min(1).max(512).optional(),
  universe: dmxUniverse.optional(),
  label: z.string().max(64).optional(),
  profileId: z.string().min(1).max(128).optional(),
  maxBrightness: u8.optional(),
  geometry: fixtureGeometry.nullable().optional(),
  output: deviceOutput.nullable().optional(),
}).strict();

const fixtureRestoreSchema = z.object({
  index: z.number().int().min(0).max(255),
  fixture: z.object({
    id: fixtureId.optional(),
    position: fixturePosition.nullable().optional(),
    group: fixtureGroup.nullable().optional(),
    geometry: fixtureGeometry.nullable().optional(),
    output: fixtureOutput.nullable().optional(),
    label: z.string().max(64),
    address: z.number().int().min(1).max(512).optional(),
    universe: dmxUniverse.optional(),
    profileId: z.string().min(1).max(128),
    maxBrightness: u8.optional(),
    override: z.union([overrideSchema, z.null()]).optional(),
  }).strict(),
}).strict();

const RESERVED_PROFILE_IDS = ['__proto__', 'constructor', 'prototype'];

interface CellCheck {
  channelCount: number;
  channelMap?: Record<string, number>;
  cells: { name?: string; channelMap: Record<string, number> }[];
}

const profileSchema = z.object({
  id: z.string().min(1).max(128)
    .refine((v) => !RESERVED_PROFILE_IDS.includes(v), { message: 'is a reserved id' }),
  name: z.string().min(1).max(128),
  manufacturer: z.string().max(128).optional(),
  modeName: z.string().max(128).optional(),
  channelCount: z.number().int().min(1).max(MAX_PROFILE_CHANNELS),
  channelMap: z.record(z.string(), z.number().int().min(0).max(MAX_PROFILE_CHANNELS - 1)),
  channelList: z.array(z.object({
    offset: z.number().int().min(0).max(MAX_PROFILE_CHANNELS - 1),
    name: z.string().min(1),
    attribute: z.string().min(1),
    cell: z.number().int().min(0).max(MAX_CELLS_PER_FIXTURE - 1).optional(),
  })).optional(),
  cells: z.array(z.object({
    name: z.string().max(64).optional(),
    channelMap: z.record(z.string(), z.number().int().min(0).max(MAX_PROFILE_CHANNELS - 1)),
    at: z.object({ x: gridIndex, y: gridIndex }).strict().optional(),
  }).strict()).min(2).max(MAX_CELLS_PER_FIXTURE).optional(),
  grid: z.object({ columns: gridSize, rows: gridSize }).strict().optional(),
  defaults: z.array(z.object({
    offset: z.number().int().min(0).max(MAX_PROFILE_CHANNELS - 1),
    value: u8,
  }).strict()).max(MAX_PROFILE_CHANNELS).optional(),
}).passthrough()
  // Validate offsets against the footprint so profiles cannot write into the next fixture.
  .superRefine((profile, ctx) => {
    const over: string[] = [];
    for (const [attr, offset] of Object.entries(profile.channelMap || {})) {
      if (offset >= profile.channelCount) over.push(`${attr}@${offset}`);
    }
    if (over.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['channelMap'],
        message: `maps channels outside the profile's ${profile.channelCount}-channel footprint: ${over.join(', ')}`,
      });
    }
    const outside = (profile.defaults || []).filter((d) => d.offset >= profile.channelCount);
    if (outside.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['defaults'],
        message: `holds channels outside the profile's ${profile.channelCount}-channel footprint: ${outside.map((d) => d.offset).join(', ')}`,
      });
    }
    if (profile.cells) checkCells({ ...profile, cells: profile.cells }, ctx);
    checkGrid(profile, ctx);
    const long = stripIssue(profile);
    if (long) ctx.addIssue({ code: 'custom', path: ['channelCount'], message: long });
  });

function checkGrid(profile: { grid?: { columns: number; rows: number }; cells?: { at?: { x: number; y: number } }[] }, ctx: z.RefinementCtx): void {
  const { grid, cells } = profile;
  if (!grid) {
    if (cells && cells.some((cell) => cell.at)) {
      ctx.addIssue({ code: 'custom', path: ['cells'], message: 'places cells in a grid but has no grid' });
    }
    return;
  }
  if (!cells) {
    ctx.addIssue({ code: 'custom', path: ['grid'], message: 'is a grid of cells, but the profile has none' });
    return;
  }
  const taken = new Map<string, number>();
  cells.forEach((cell, c) => {
    const at = cell.at || { x: c % grid.columns, y: Math.floor(c / grid.columns) };
    const where = `${at.x},${at.y}`;
    if (at.x >= grid.columns || at.y >= grid.rows) {
      ctx.addIssue({ code: 'custom', path: ['cells', c], message: `sits at column ${at.x + 1}, row ${at.y + 1}, outside the ${grid.columns} × ${grid.rows} grid` });
    } else if (taken.has(where)) {
      ctx.addIssue({ code: 'custom', path: ['cells', c], message: `sits where cell ${(taken.get(where) as number) + 1} does` });
    } else {
      taken.set(where, c);
    }
  });
}

// Reject shared cell channels so independent looks cannot fight over the same DMX byte.
function checkCells(profile: CellCheck, ctx: z.RefinementCtx): void {
  const fixtureLevel = new Set(Object.values(profile.channelMap || {}));
  const owner = new Map<number, string>();
  profile.cells.forEach((cell, index) => {
    const label = cell.name || `cell ${index + 1}`;
    const problems: string[] = [];
    for (const [attr, offset] of Object.entries(cell.channelMap)) {
      if (offset >= profile.channelCount) problems.push(`${attr}@${offset} is outside the footprint`);
      else if (fixtureLevel.has(offset)) problems.push(`${attr}@${offset} is a fixture-level channel`);
      else if (owner.has(offset)) problems.push(`${attr}@${offset} is also ${owner.get(offset)}'s`);
      else owner.set(offset, label);
    }
    if (!EMITTERS.some((attr) => cell.channelMap[attr] !== undefined)) problems.push('drives no light');
    if (problems.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['cells', index],
        message: `${label}: ${problems.join('; ')}`,
      });
    }
  });
}

const showSchema = z.object({
  nextFixtureId: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  artnet: artnetSchema.optional(),
  profiles: z.array(profileSchema).optional(),
  fixtures: z.array(z.object({
    id: fixtureId.optional(),
    position: fixturePosition.nullable().optional(),
    group: fixtureGroup.nullable().optional(),
    geometry: fixtureGeometry.nullable().optional(),
    output: fixtureOutput.nullable().optional(),
    label: z.string().max(64).optional(),
    address: z.number().int().min(1).max(512).optional(),
    universe: dmxUniverse.optional(),
    profileId: z.string().optional(),
    maxBrightness: u8.optional(),
  })).optional(),
}).passthrough();

const deezerTrackSchema = z.object({
  name: z.string().max(512).optional(),
  title: z.string().max(512).optional(),
  artist: z.string().max(512).optional(),
  album: z.string().max(512).optional(),
  albumArt: z.string().max(2048).nullable().optional(),
  isrc: z.string().max(32).nullable().optional(),
  trackId: z.union([z.string().max(128), z.number()]).nullable().optional(),
  durationMs: z.number().nonnegative().max(24 * 60 * 60 * 1000).optional(),
  progressMs: z.number().nonnegative().max(24 * 60 * 60 * 1000).optional(),
  isPlaying: z.boolean().optional(),
}).passthrough();

const deezerStateSchema = z.object({
  current: deezerTrackSchema.nullable().optional(),
  upcoming: z.array(deezerTrackSchema).max(50).optional(),
}).passthrough();

const midiConnectSchema = z.object({
  input: z.string().nullable().optional(),
  output: z.string().nullable().optional(),
}).strict();

const wledAddSchema = z.object({
  host: z.string().regex(HOSTNAME_RE, 'is not a hostname or an IPv4 address'),
  label: z.string().trim().min(1).max(64).optional(),
  // One fixture for each of its segments, rather than one for all its LEDs.
  segments: z.boolean().optional(),
  mode: z.enum(['wash', 'zones', 'pixels', 'strobe']).optional(),
  zones: z.number().int().min(2).max(64).optional(),
}).strict();

const openrgbHostSchema = z.object({
  host: z.string().regex(HOSTNAME_RE, 'is not a hostname or an IPv4 address'),
  port: z.coerce.number().int().min(1).max(65535).optional(),
}).strict();
const openrgbAddSchema = openrgbHostSchema.extend({
  devices: z.array(z.number().int().min(0).max(4095)).min(1).max(64).optional(),
  label: z.string().trim().min(1).max(64).optional(),
}).strict();

const huePairSchema = z.object({
  host: z.string().min(1).max(253),
  label: z.string().trim().max(64).optional(),
}).strict();

const hueAddSchema = z.object({
  channels: z.array(z.number().int().min(0).max(255)).min(1).max(20).optional(),
}).strict();

const hueDisconnectSchema = z.object({
  removeFixtures: z.boolean().optional(),
}).strict();

const trackMs = z.number().finite().min(0).max(24 * 3600 * 1000);
const overlaySchema = z.object({
  palette: z.string().regex(/^[A-Za-z0-9-]{1,64}$/).nullable().optional(),
  sections: z.array(z.object({
    atMs: trackMs,
    pattern: z.string().min(1).max(64).optional(),
    pixelPattern: z.string().min(1).max(64).nullable().optional(),
    panelPattern: z.string().min(1).max(64).nullable().optional(),
  }).strict()).max(256).optional(),
  accents: z.object({
    add: z.array(z.object({
      atMs: trackMs,
      burst: z.enum(['blinder', 'white-strobe', 'color-strobe', 'uv-wash', 'kill', 'glow']),
      durationMs: z.number().int().min(120).max(2000).optional(),
    }).strict()).max(512).optional(),
    remove: z.array(trackMs).max(512).optional(),
  }).strict().optional(),
}).strict();

function validate<S extends z.ZodTypeAny>(schema: S, value: unknown, label: string): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ValidationError(
      `${label}: ${result.error.issues.map((i) => `${i.path.join('.') || '<root>'} ${i.message}`).join('; ')}`,
      result.error.issues,
    );
  }
  return result.data;
}

export type Patch = z.output<typeof patchSchema>;
export type OverrideInput = z.output<typeof overrideSchema>;
export type FixtureEdit = z.output<typeof fixtureMessageSchema>;
export type FixtureRestore = z.output<typeof fixtureRestoreSchema>;
export type ProfileInput = z.output<typeof profileSchema>;
export type ShowFile = z.output<typeof showSchema>;
export type DeezerState = z.output<typeof deezerStateSchema>;

export {
  fixtureId,
  dmxUniverse,
  hexColour,
  paletteOverride,
  patchSchema,
  deezerStateSchema,
  overrideSchema,
  overrideMessageSchema,
  fixtureMessageSchema,
  fixtureRestoreSchema,
  profileSchema,
  showSchema,
  midiConnectSchema,
  openrgbHostSchema,
  openrgbAddSchema,
  huePairSchema,
  hueAddSchema,
  hueDisconnectSchema,
  wledAddSchema,
  fixtureAddSchema,
  overlaySchema,
  validate,
};
