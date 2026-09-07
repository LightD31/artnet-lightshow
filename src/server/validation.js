'use strict';

const { z } = require('zod');
const net = require('net');
const {
  COLOR_PRESETS,
  AUTO_SOURCES,
} = require('./presets');

const u8 = z.number().int().min(0).max(255);
const colorIdx = z.number().int().min(0).max(COLOR_PRESETS.length - 1);

// Hostname per RFC 1123, or an IPv4 literal. Rejecting junk here means a typo
// in the ArtNet panel surfaces as a validation error instead of a stream of
// failed sends.
const HOSTNAME_RE = /^(?=.{1,253}$)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

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
}).strict();

// Pattern / strobeFunction / energyOverride accept any string — the engine
// silently no-ops on unknown ids, matching the previous lenient behaviour
// and giving auto-show.js room for new pattern pools without a schema bump.
const patchSchema = z.object({
  bpm: z.number().int().min(20).max(300).optional(),
  beatDivision: z.number().int().min(1).max(16).optional(),
  running: z.boolean().optional(),
  pattern: z.string().min(1).max(64).optional(),
  colorA: colorIdx.optional(),
  colorB: colorIdx.optional(),
  colorC: colorIdx.optional(),
  colorD: colorIdx.optional(),
  masterDimmer: u8.optional(),
  masterBlackout: z.boolean().optional(),
  strobeSpeed: u8.optional(),
  strobeFunction: z.string().min(1).max(64).optional(),
  energyOverride: z.union([z.string().min(1).max(64), z.null()]).optional(),
  artnet: artnetSchema.optional(),
  prolinkEnabled: z.boolean().optional(),
  autoSource: z.enum(AUTO_SOURCES).optional(),
  autoPaletteSize: z.union([z.literal(2), z.literal(3), z.literal(4)]).optional(),
  autoIntensity: z.number().min(0).max(100).optional(),
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
  id: z.number().int().nonnegative(),
  override: z.union([overrideSchema, z.null()]),
});

const dmxUniverse = z.number().int().min(0).max(32767);

const fixtureMessageSchema = z.object({
  id: z.number().int().nonnegative(),
  address: z.number().int().min(1).max(512).optional(),
  universe: dmxUniverse.optional(),
  label: z.string().max(64).optional(),
  profileId: z.string().min(1).max(128).optional(),
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
    label: z.string().max(64),
    address: z.number().int().min(1).max(512),
    universe: dmxUniverse.optional(),
    profileId: z.string().min(1).max(128),
    override: z.union([overrideSchema, z.null()]).optional(),
  }).strict(),
}).strict();

// Profile ids reach an object key, so reject the ones that would collide with
// object machinery before they get anywhere near the registry.
const RESERVED_PROFILE_IDS = ['__proto__', 'constructor', 'prototype'];

const profileSchema = z.object({
  id: z.string().min(1).max(128)
    .refine((v) => !RESERVED_PROFILE_IDS.includes(v), { message: 'is a reserved id' }),
  name: z.string().min(1).max(128),
  manufacturer: z.string().max(128).optional(),
  modeName: z.string().max(128).optional(),
  channelCount: z.number().int().min(1).max(512),
  channelMap: z.record(z.number().int().min(0).max(511)),
  channelList: z.array(z.object({
    offset: z.number().int().min(0).max(511),
    name: z.string().min(1),
    attribute: z.string().min(1),
  })).optional(),
}).passthrough()
  // channelCount is the fixture's DMX footprint: it decides where the *next*
  // fixture can be patched and what the universe-bounds check reserves. An
  // offset at or past it would be written outside the footprint the profile
  // claims — straight into whatever fixture is patched next. The GDTF importer
  // already derives channelCount from the highest offset; this holds the
  // hand-written and API-posted paths to the same rule.
  .superRefine((profile, ctx) => {
    const over = [];
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
  });

const showSchema = z.object({
  artnet: artnetSchema.optional(),
  profiles: z.array(profileSchema).optional(),
  fixtures: z.array(z.object({
    label: z.string().max(64).optional(),
    address: z.number().int().min(1).max(512).optional(),
    // Absent in shows saved before multi-universe: those load onto the rig's
    // default universe, which is exactly where they used to live.
    universe: dmxUniverse.optional(),
    profileId: z.string().optional(),
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

function validate(schema, value, label) {
  const result = schema.safeParse(value);
  if (!result.success) {
    const err = new Error(`${label}: ${result.error.issues.map((i) => `${i.path.join('.') || '<root>'} ${i.message}`).join('; ')}`);
    err.status = 400;
    err.issues = result.error.issues;
    throw err;
  }
  return result.data;
}

module.exports = {
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
  validate,
};
