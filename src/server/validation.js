'use strict';

const { z } = require('zod');
const {
  COLOR_PRESETS,
  AUTO_SOURCES,
} = require('./presets');

const u8 = z.number().int().min(0).max(255);
const colorIdx = z.number().int().min(0).max(COLOR_PRESETS.length - 1);

const artnetSchema = z.object({
  host: z.string().min(1).optional(),
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

const fixtureMessageSchema = z.object({
  id: z.number().int().nonnegative(),
  address: z.number().int().min(1).max(512).optional(),
  label: z.string().max(64).optional(),
  profileId: z.string().min(1).max(128).optional(),
}).strict();

const profileSchema = z.object({
  id: z.string().min(1).max(128),
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
}).passthrough();

const showSchema = z.object({
  artnet: artnetSchema.optional(),
  profiles: z.array(profileSchema).optional(),
  fixtures: z.array(z.object({
    label: z.string().max(64).optional(),
    address: z.number().int().min(1).max(512).optional(),
    profileId: z.string().optional(),
  })).optional(),
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
  patchSchema,
  overrideSchema,
  overrideMessageSchema,
  fixtureMessageSchema,
  profileSchema,
  showSchema,
  midiConnectSchema,
  validate,
};
