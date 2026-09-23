import { z } from 'zod';
import net from 'node:net';
import { COLOR_PRESETS, AUTO_SOURCES, SYNC_OFFSET_LIMIT_MS } from './presets.ts';
import { PALETTE_IDS } from './palettes.ts';
import { FIXTURE_GROUPS } from '../shared/stage.ts';
import { EMITTERS, PIXEL_MAPS, MAX_CELLS_PER_FIXTURE, MAX_PROFILE_CHANNELS } from '../shared/rig.ts';
import { stripIssue } from '../shared/placement.ts';
import { HttpError } from '../errors.ts';

/** Input that failed its schema: a 400, with zod's issues for the client. */
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
}).strict();
const fixtureGroup = z.enum(FIXTURE_GROUPS);
// A bar's line on the stage plot, centred on its position: how long it is in
// percent of the stage's width, and which way it points (degrees clockwise on
// the plot, 0 with its first cell at stage left).
const fixtureGeometry = z.object({
  length: z.number().finite().min(1).max(100),
  angle: z.number().finite().min(-180).max(180),
}).strict();
const colorIdx = z.number().int().min(0).max(COLOR_PRESETS.length - 1);
const unitValue = z.number().min(0).max(1).optional();

// Hostname per RFC 1123, or an IPv4 literal. Rejecting junk here means a typo
// in the ArtNet panel surfaces as a validation error instead of a stream of
// failed sends.
const HOSTNAME_RE = /^(?=.{1,253}$)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

// A fixture sent to a device of its own: a WLED over DDP, by its hostname or
// address. Its universes then go there and nowhere else (ddp-routes.ts).
const fixtureOutput = z.object({
  protocol: z.literal('ddp'),
  host: z.string().regex(HOSTNAME_RE, 'is not a hostname or an IPv4 address'),
  port: z.number().int().min(1).max(65535).optional(),
}).strict();

// A string of dotted numeric labels is someone typing an IP, so hold it to
// IPv4 rules rather than letting "2.255.255.256" through as a hostname (which
// RFC 1123 would technically permit) and failing later at DNS.
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

// Pattern / strobeFunction / energyOverride accept any string — the engine
// silently no-ops on unknown ids, matching the previous lenient behaviour
// and giving auto-show.js room for new pattern pools without a schema bump.
const patchSchema = z.object({
  // Not rounded: a track at 123.7 BPM run at 124 drifts a beat off the music
  // in under a minute.
  bpm: z.number().min(20).max(300).optional(),
  // The timeline time a scene was scheduled for, so its pattern counts from
  // that beat however late the frame that fired it was. Set by the auto show.
  anchorMs: z.number().finite().optional(),
  beatDivision: z.number().int().min(1).max(16).optional(),
  running: z.boolean().optional(),
  pattern: z.string().min(1).max(64).optional(),
  // Crossfade into this patch's pattern and colours rather than cutting.
  fadeMs: z.number().int().min(0).max(10000).optional(),
  // Split the look: one fixture group holds a wash in colour B while the rest
  // run the pattern. The number picks which group; null runs the whole rig.
  split: z.number().int().min(0).max(1e9).nullable().optional(),
  // How a pixel effect is laid over the cells of LED bars. See shared/rig.js.
  pixelMap: z.enum(PIXEL_MAPS).optional(),
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
  // A named look from server/palettes.js. Writes all four colour slots at once;
  // null just clears the label. Unknown ids are rejected rather than ignored —
  // unlike a pattern id, a palette that silently does nothing looks like the
  // colour buttons broke.
  // The custom message because the default union error is a bare "Invalid
  // input", which reaches the operator as a toast that says nothing.
  palette: z.union([z.enum(PALETTE_IDS as [string, ...string[]]), z.null()], {
    errorMap: () => ({ message: `is not a known palette (${PALETTE_IDS.join(', ')})` }),
  }).optional(),
  // Which bank the palette resolves against. Only meaningful alongside
  // `palette`; a smaller palette wraps to fill all four slots.
  paletteSize: z.union([z.literal(2), z.literal(3), z.literal(4)]).optional(),
  artnet: artnetSchema.optional(),
  prolinkEnabled: z.boolean().optional(),
  autoSource: z.enum(AUTO_SOURCES).optional(),
  // `'auto'` hands the choice to the director, which sizes the palette from the
  // track. The manual `paletteSize` above stays 2 | 3 | 4: that one is the
  // colour panel's own setting and there is no music behind it to ask.
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

const fixtureMessageSchema = z.object({
  id: fixtureId,
  position: fixturePosition.nullable().optional(),
  group: fixtureGroup.nullable().optional(),
  address: z.number().int().min(1).max(512).optional(),
  universe: dmxUniverse.optional(),
  label: z.string().max(64).optional(),
  profileId: z.string().min(1).max(128).optional(),
  // The fixture's brightness trim: scales its output, whatever is driving it.
  // Not part of the override — it applies to an energy override too.
  maxBrightness: u8.optional(),
  geometry: fixtureGeometry.nullable().optional(),
  output: fixtureOutput.nullable().optional(),
}).strict();

/**
 * POST /api/fixtures/restore: an undo for a just-deleted fixture.
 *
 * Carries the override too — a fixture deleted while overridden should come
 * back the way it left, not reset to the pattern engine.
 */
const fixtureRestoreSchema = z.object({
  index: z.number().int().min(0).max(255),
  fixture: z.object({
    id: fixtureId.optional(),
    position: fixturePosition.nullable().optional(),
    group: fixtureGroup.nullable().optional(),
    geometry: fixtureGeometry.nullable().optional(),
    output: fixtureOutput.nullable().optional(),
    label: z.string().max(64),
    address: z.number().int().min(1).max(512),
    universe: dmxUniverse.optional(),
    profileId: z.string().min(1).max(128),
    maxBrightness: u8.optional(),
    override: z.union([overrideSchema, z.null()]).optional(),
  }).strict(),
}).strict();

// Profile ids reach an object key, so reject the ones that would collide with
// object machinery before they get anywhere near the registry.
const RESERVED_PROFILE_IDS = ['__proto__', 'constructor', 'prototype'];

/** A profile's channel maps, as checkCells reads them. */
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
  // Up to a universe for any fixture; a strip may run on over several.
  channelCount: z.number().int().min(1).max(MAX_PROFILE_CHANNELS),
  channelMap: z.record(z.number().int().min(0).max(MAX_PROFILE_CHANNELS - 1)),
  channelList: z.array(z.object({
    offset: z.number().int().min(0).max(MAX_PROFILE_CHANNELS - 1),
    name: z.string().min(1),
    attribute: z.string().min(1),
    // Which cell the channel drives, for labelling the monitor.
    cell: z.number().int().min(0).max(MAX_CELLS_PER_FIXTURE - 1).optional(),
  })).optional(),
  // The cells of a fixture that is more than one light — an LED bar — in the
  // order they sit along it. Each has its own channels, at offsets inside the
  // fixture's footprint; the fixture-level channelMap keeps what they share.
  cells: z.array(z.object({
    name: z.string().max(64).optional(),
    channelMap: z.record(z.number().int().min(0).max(MAX_PROFILE_CHANNELS - 1)),
    // Where the cell is in the grid below, column and row from 0.
    at: z.object({ x: gridIndex, y: gridIndex }).strict().optional(),
  }).strict()).min(2).max(MAX_CELLS_PER_FIXTURE).optional(),
  // A panel — an LED matrix — has its cells in rows and columns rather than
  // along a line. Cells without `at` fill it row by row in the order listed.
  grid: z.object({ columns: gridSize, rows: gridSize }).strict().optional(),
  // Channels the show does not drive and the value each sits at instead of 0:
  // a shutter whose 0 is closed, a dimmer the show leaves at full. Written
  // under every frame, so a channel the show does drive still wins.
  defaults: z.array(z.object({
    offset: z.number().int().min(0).max(MAX_PROFILE_CHANNELS - 1),
    value: u8,
  }).strict()).max(MAX_PROFILE_CHANNELS).optional(),
}).passthrough()
  // channelCount is the fixture's DMX footprint: it decides where the *next*
  // fixture can be patched and what the universe-bounds check reserves. An
  // offset at or past it would be written outside the footprint the profile
  // claims — straight into whatever fixture is patched next. The GDTF importer
  // already derives channelCount from the highest offset; this holds the
  // hand-written and API-posted paths to the same rule.
  .superRefine((profile, ctx) => {
    const over: string[] = [];
    for (const [attr, offset] of Object.entries(profile.channelMap || {})) {
      if (offset >= profile.channelCount) over.push(`${attr}@${offset}`);
    }
    if (over.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['channelMap'],
        message: `maps channels outside the profile's ${profile.channelCount}-channel footprint: ${over.join(', ')}`,
      });
    }
    const outside = (profile.defaults || []).filter((d) => d.offset >= profile.channelCount);
    if (outside.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['defaults'],
        message: `holds channels outside the profile's ${profile.channelCount}-channel footprint: ${outside.map((d) => d.offset).join(', ')}`,
      });
    }
    if (profile.cells) checkCells({ ...profile, cells: profile.cells }, ctx);
    checkGrid(profile, ctx);
    // Longer than a universe: only a strip can run on into the next one.
    const long = stripIssue(profile);
    if (long) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['channelCount'], message: long });
  });

/** A panel's grid holds every cell, each in a place of its own. */
function checkGrid(profile: { grid?: { columns: number; rows: number }; cells?: { at?: { x: number; y: number } }[] }, ctx: z.RefinementCtx): void {
  const { grid, cells } = profile;
  if (!grid) {
    if (cells && cells.some((cell) => cell.at)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['cells'], message: 'places cells in a grid but has no grid' });
    }
    return;
  }
  if (!cells) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['grid'], message: 'is a grid of cells, but the profile has none' });
    return;
  }
  const taken = new Map<string, number>();
  cells.forEach((cell, c) => {
    const at = cell.at || { x: c % grid.columns, y: Math.floor(c / grid.columns) };
    const where = `${at.x},${at.y}`;
    if (at.x >= grid.columns || at.y >= grid.rows) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['cells', c], message: `sits at column ${at.x + 1}, row ${at.y + 1}, outside the ${grid.columns} × ${grid.rows} grid` });
    } else if (taken.has(where)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['cells', c], message: `sits where cell ${(taken.get(where) as number) + 1} does` });
    } else {
      taken.set(where, c);
    }
  });
}

/**
 * A cell drives channels of its own. Two cells on one channel, or a cell on a
 * channel the whole fixture uses, would have two looks fighting over one
 * byte; a cell with no light in it is not a cell.
 */
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
        code: z.ZodIssueCode.custom,
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
    // Absent in shows saved before multi-universe: those load onto the rig's
    // default universe, which is exactly where they used to live.
    universe: dmxUniverse.optional(),
    profileId: z.string().optional(),
    // Absent in shows saved before the brightness trim existed: those load at
    // 255 — no scaling — which is what they were rendering at.
    maxBrightness: u8.optional(),
  })).optional(),
}).passthrough();

// The browser extension POSTs the Deezer web player's state. DeezerSource
// coerces the field types defensively, but nothing bounded the *sizes*: track
// names and a queue of any length flowed straight into state that is broadcast
// to every connected client (and into yt-dlp search queries and cache keys).
// A text field is a text field — cap it at something no real track exceeds.
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
  // Only the first `autoPrefetchDepth` (max 5) entries are ever read; 50 is
  // generous headroom without letting a client park an unbounded array here.
  upcoming: z.array(deezerTrackSchema).max(50).optional(),
}).passthrough();

const midiConnectSchema = z.object({
  input: z.string().nullable().optional(),
  output: z.string().nullable().optional(),
}).strict();

// Pairing is the one Hue call that names a bridge the settings do not hold yet:
// the operator has just picked it off the discovery list, or typed it in.
const huePairSchema = z.object({
  host: z.string().min(1).max(253),
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

/** A look change, as applyPatch takes it. */
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
  patchSchema,
  deezerStateSchema,
  overrideSchema,
  overrideMessageSchema,
  fixtureMessageSchema,
  fixtureRestoreSchema,
  profileSchema,
  showSchema,
  midiConnectSchema,
  huePairSchema,
  validate,
};
