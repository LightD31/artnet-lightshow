'use strict';

const { state, universeOf } = require('./state');
const { getProfile } = require('./profiles');
const universes = require('./universes');
const { sendArtDmx } = require('./artnet');
const { sendSacn, MIN_UNIVERSE, MAX_UNIVERSE } = require('./sacn');
const hue = require('./hue');

/**
 * Where a rendered universe goes.
 *
 * The engine builds frames; this decides which wire protocols carry them.
 * Art-Net and sACN are independent — a rig can run either, or both at once
 * while a venue is being migrated from one to the other.
 *
 * Philips Hue sits alongside them but is fed differently, and deliberately so.
 * The other two carry universes; a Hue bridge has no concept of one. Each Hue
 * channel is instead bound to a rig fixture and takes that fixture's colour, so
 * a Hue lamp is driven by exactly the same patterns, palettes and auto-show
 * cues as the pars — see hueChannelColors().
 *
 * The sACN settings are cached rather than read from the store per frame:
 * `settings.group()` deep-clones, and this runs 40 times a second per universe.
 * The applier calls configureSacn() at boot and again whenever they change.
 */

let sacn = {
  enabled: false,
  host: '',
  priority: 100,
  sourceName: 'ArtNet Lightshow',
  universeOffset: 1,
  cid: '',
};

function configureSacn(config) {
  sacn = { ...sacn, ...config };
  return sacn;
}

function getSacnConfig() { return { ...sacn }; }

// Hue channel bindings, cached here for the same reason as the sACN settings:
// this is read once per rendered frame and settings.group() deep-clones.
let hueChannels = [];

function configureHue(config) {
  const { channels, ...rest } = config || {};
  if (Array.isArray(channels)) {
    hueChannels = channels
      .filter((c) => c && Number.isInteger(c.channel) && Number.isInteger(c.fixture))
      .map((c) => ({ channel: c.channel, fixture: c.fixture }));
  }
  hue.configure(rest);
  return getHueConfig();
}

function getHueConfig() { return { ...hue.getConfig(), channels: hueChannels.map((c) => ({ ...c })) }; }

/** Let the applier persist an application id the module had to resolve itself. */
function onHueApplicationId(fn) { hue.setApplicationIdSink(fn); }

/**
 * The sACN universe a rig universe maps to.
 *
 * Art-Net counts universes from 0 and sACN from 1, so the default offset of 1
 * lines them up the way every other tool does. Returns null when the result
 * falls outside what E1.31 allows, which the caller reports rather than
 * silently sending nowhere.
 */
function sacnUniverseFor(universe, offset = sacn.universeOffset) {
  const mapped = universe + offset;
  if (!Number.isInteger(mapped) || mapped < MIN_UNIVERSE || mapped > MAX_UNIVERSE) return null;
  return mapped;
}

// ── Hue ─────────────────────────────────────────────────────────────────────

// A white emitter is neutral, so it lifts all three primaries equally. Amber is
// not: it sits around (255, 191, 0), and folding it in as if it were white
// would turn a warm wash cold on the Hue lamps while the pars stayed amber.
const AMBER_GREEN = 0.75;

// A Hue bulb is RGBWW — red, green and blue dies plus a warm white and a cool
// white one. The Entertainment stream has no white channel to carry those, so
// they fold into the RGB that goes out and the lamp's firmware decides which
// dies to light. Folding them at their real colour temperature rather than as
// plain white is what keeps a warm wash warm.
//
// Warm white is roughly 2700K, which is (255, 169, 87) in sRGB. Note it is far
// less saturated than the amber emitter above: a tungsten white still has real
// blue in it, and dropping that would make every warm look on a Hue lamp read
// as orange.
const WARM_WHITE_GREEN = 0.66;
const WARM_WHITE_BLUE = 0.34;

// Cool white is roughly 6500K — near enough neutral, with the faint blue lean
// that tells daylight apart from flat white.
const COOL_WHITE_GREEN = 0.98;
const COOL_WHITE_BLUE = 0.99;

// Hue lamps cannot emit UV, so a UV look has nothing to reproduce. Dropping it
// would leave them black through an entire UV wash while the pars glowed, which
// reads as a broken lamp rather than an effect. A deep violet is the closest
// visible stand-in and keeps the rig looking like one rig.
const UV_RED = 0.45;
const UV_BLUE = 0.85;

/**
 * Bring a summed emitter mix back inside what one lamp can show.
 *
 * A par mixes light physically: red, green, blue, white and amber emitters all
 * lit together are genuinely brighter than any one of them. A Hue lamp has a
 * fixed maximum, so that sum has to come back down — and *how* it comes down
 * decides whether the colour survives.
 *
 * Clamping each primary on its own does not work. "Amber" sums to (455, 318,
 * 87); clamped independently that is (255, 255, 87), which is yellow — green
 * was pushed to full while blue stayed put, so the hue moved. Scaling all three
 * by the same factor keeps the ratios and so keeps the colour: (255, 178, 49),
 * which is still amber.
 *
 * The cost is brightness: a mix that overflows comes back at less than full.
 * That is the right way round for a light show. A warm white that is actually
 * warm beats a brighter one that has gone neutral, and brightness is what the
 * dimmer is for — whereas nothing downstream can put a lost hue back.
 */
function normalizeMix(r, g, b) {
  const peak = Math.max(r, g, b);
  const scale = peak > 255 ? 255 / peak : 1;
  return {
    r: clamp255(r * scale),
    g: clamp255(g * scale),
    b: clamp255(b * scale),
  };
}

function clamp255(value) {
  return value > 255 ? 255 : (value < 0 ? 0 : Math.round(value));
}

/**
 * The colour a Hue channel should show, read back out of the rendered frame.
 *
 * Reading the DMX buffer rather than asking the engine for its intermediate
 * values is the whole point: by this stage the fixture's colour has already had
 * the dimmer, the per-fixture trim, the grand master, any override and master
 * blackout applied to it. Whatever a Hue channel shows is therefore exactly
 * what its bound fixture is doing, including going dark when the rig does.
 *
 * A fixture with no colour channels at all (a dimmer-only profile) falls back
 * to its dimmer as neutral white, so binding one to a Hue lamp still does the
 * obvious thing instead of nothing.
 */
function hueChannelColors() {
  const out = [];
  if (!hueChannels.length) return out;

  for (const binding of hueChannels) {
    const fix = state.fixtures.find((f) => f.id === binding.fixture);
    if (!fix) continue;

    const dmx = universes.getBuffer(universeOf(fix));
    const ch = getProfile(fix).channelMap;
    const base = fix.address - 1;
    const at = (offset) => (offset === undefined ? 0 : (dmx[base + offset] || 0));

    // A fixture with nothing that makes coloured light — a plain dimmer-only
    // lamp — is read as neutral white at its level. Tested against every
    // emitter rather than the primaries alone: a tunable-white lamp has warm
    // and cool dies but no primaries, and falling back for it would add the
    // dimmer on top of the whites and double the brightness.
    const hasEmitter = ['red', 'green', 'blue', 'white', 'warmWhite', 'coolWhite', 'amber', 'uv']
      .some((name) => ch[name] !== undefined);
    if (!hasEmitter) {
      const level = at(ch.dimmer);
      out.push({ id: binding.channel, r: level, g: level, b: level });
      continue;
    }

    const r = at(ch.red);
    const g = at(ch.green);
    const b = at(ch.blue);
    const w = at(ch.white);
    const a = at(ch.amber);
    const uv = at(ch.uv);
    const ww = at(ch.warmWhite);
    const cw = at(ch.coolWhite);

    out.push({
      id: binding.channel,
      ...normalizeMix(
        r + w + a + ww + cw + uv * UV_RED,
        g + w + a * AMBER_GREEN + ww * WARM_WHITE_GREEN + cw * COOL_WHITE_GREEN,
        b + w + ww * WARM_WHITE_BLUE + cw * COOL_WHITE_BLUE + uv * UV_BLUE,
      ),
    });
  }
  return out;
}

/**
 * Push the current frame to the Hue bridge.
 *
 * Separate from sendUniverse() because it is not per-universe: one message
 * carries every channel in the entertainment area, whatever universes their
 * fixtures happen to live on. Called once per rendered frame.
 */
function sendHue() {
  return hue.sendFrame(hueChannelColors());
}

/**
 * Put one universe on every enabled wire.
 *
 * Returns the protocols it actually reached, which the preflight check uses to
 * tell "nothing is configured" apart from "it went out and nobody answered".
 */
function sendUniverse(universe, frame) {
  const sent = [];

  if (state.artnet.enabled !== false) {
    sendArtDmx({ host: state.artnet.host, port: state.artnet.port, universe }, frame);
    sent.push('artnet');
  }

  if (sacn.enabled) {
    const mapped = sacnUniverseFor(universe);
    if (mapped !== null && sendSacn({
      universe: mapped,
      cid: sacn.cid,
      sourceName: sacn.sourceName,
      priority: sacn.priority,
      host: sacn.host,
    }, frame)) {
      sent.push('sacn');
    }
  }

  return sent;
}

module.exports = {
  configureSacn,
  getSacnConfig,
  sacnUniverseFor,
  sendUniverse,
  configureHue,
  getHueConfig,
  onHueApplicationId,
  getHueStatus: () => hue.getStatus(),
  hueChannelColors,
  sendHue,
  stopHue: () => hue.stop(),
};
