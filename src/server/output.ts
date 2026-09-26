import { state, universeOf } from './state.ts';
import { getProfile } from './profiles.ts';
import { EMITTERS } from '../shared/rig.ts';
import { channelReader } from '../shared/placement.ts';
import * as universes from './universes.ts';
import { createTransmitter, sacnUniverseFor as mapSacnUniverse } from './transmit.ts';
import { createDiscovery, interfaces, isBroadcastTarget } from './artnet-nodes.ts';
import { isLoopback } from './loopback.ts';
import * as hue from './hue.ts';
import type { HueChannelColour } from './hue.ts';
import { ddpRoutes } from './ddp-routes.ts';
import type { SacnOutput, SendOptions, TransmitConfig, Wire } from './transmit.ts';
import type { Settings } from './settings.ts';
import type { ChannelMap } from '../types/rig.ts';

/** Reads one channel of a fixture's DMX; 0 for a channel it does not have. */
type ChannelReader = (offset: number | undefined) => number;

/**
 * Where a rendered universe goes.
 *
 * The engine builds frames; this decides which wire protocols carry them.
 * Art-Net and sACN are independent — a rig can run either, or both at once
 * while a venue is being migrated from one to the other.
 *
 * Philips Hue sits alongside them but is fed differently, and deliberately so.
 * The other two carry universes; a Hue bridge has no concept of one. Each Hue
 * lamp is a fixture of its own with no DMX address, rendered like any other,
 * and its entertainment channel is sent the colour that came out — so it is
 * driven by exactly the same patterns, palettes and auto-show cues as the
 * pars. See hueChannelColors().
 *
 * The sACN settings are cached rather than read from the store per frame:
 * `settings.group()` deep-clones, and this runs 44 times a second per universe.
 * The applier calls configureSacn() at boot and again whenever they change.
 */

let sacn: SacnOutput = {
  enabled: false,
  host: '',
  priority: 100,
  sourceName: 'ArtNet Lightshow',
  universeOffset: 1,
  cid: '',
  interface: '',
};

function configureSacn(config: Partial<SacnOutput> | null | undefined): SacnOutput {
  sacn = { ...sacn, ...config };
  return sacn;
}

function getSacnConfig(): SacnOutput { return { ...sacn }; }

// The Hue delay, cached here for the same reason as the sACN settings: it is
// read once per rendered frame and settings.group() deep-clones.
let hueLatencyMs = 0;

function configureHue(config: Partial<Settings['hue']> | null | undefined): Settings['hue'] {
  const { latencyMs, ...rest }: Partial<Settings['hue']> = config || {};
  if (typeof latencyMs === 'number' && Number.isFinite(latencyMs)) hueLatencyMs = Math.max(0, Math.min(500, Math.round(latencyMs)));
  hue.configure(rest);
  return getHueConfig();
}

function getHueConfig(): Settings['hue'] {
  return { ...hue.getConfig(), latencyMs: hueLatencyMs };
}

// The wires, for frames rendered on this thread: the engine when it runs here,
// and the blackout at shutdown. See transmit.js for the Hue delay line.
const transmitter = createTransmitter();

/**
 * Whether to ask the network which nodes are there: Art-Net on, discovery on,
 * and a target that is a broadcast rather than a node or this machine (see
 * artnet-nodes.js).
 */
function artnetDiscoveryWanted(): boolean {
  const a = state.artnet;
  return a.enabled !== false && a.discovery !== false && isBroadcastTarget(a.host) && !isLoopback(a.host);
}

const artnetDiscovery = createDiscovery({
  shouldPoll: artnetDiscoveryWanted,
  // Every interface's own broadcast, and the target itself (2.255.255.255 on a
  // machine with no address on that network still reaches a node routed there).
  targets: () => [...interfaces().map((i) => i.broadcast), state.artnet.host],
});

/**
 * Everything the transmitter needs to know about the outputs, read once: the
 * Art-Net target, the sACN settings, and how long to hold both back for Hue.
 * The engine's worker thread gets this with every frame it is sent.
 */
function transmitConfig(): TransmitConfig {
  return {
    artnet: {
      enabled: state.artnet.enabled,
      host: state.artnet.host,
      port: state.artnet.port,
      sync: !!state.artnet.sync,
      routes: artnetDiscovery.routes(),
    },
    sacn: { ...sacn },
    delayMs: hueLatencyMs > 0 && hue.getConfig().enabled ? hueLatencyMs : 0,
    ddp: ddpRoutes(state.fixtures, getProfile, universeOf),
  };
}

/** Let the applier persist an application id the module had to resolve itself. */
function onHueApplicationId(fn: (id: string) => void): void { hue.setApplicationIdSink(fn); }

/**
 * The sACN universe a rig universe maps to, or null outside what E1.31 allows
 * (see transmit.js). The offset defaults to the configured one.
 */
function sacnUniverseFor(universe: number, offset = sacn.universeOffset): number | null {
  return mapSacnUniverse(universe, offset);
}

// ── Hue ─────────────────────────────────────────────────────────────────────

// A Hue bulb is RGBWW — red, green and blue dies plus a warm white and a cool
// white one. The Entertainment stream has no white channel to carry those, so
// they fold into the RGB that goes out and the lamp's firmware decides which
// dies to light. Folding them at their real colour temperature rather than as
// plain white is what keeps a warm wash warm.
//
// Warm white is roughly 2700K, which is (255, 169, 87) in sRGB: a tungsten
// white still has real blue in it, and dropping that would make every warm
// look on a Hue lamp read as orange.
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
 * The show renders a Hue lamp's colour dies and its two whites separately, and
 * a look can light them all at once — full red with the warm white on sums to
 * (510, 168, 87). The lamp has a fixed maximum, so that sum has to come back
 * down, and *how* it comes down decides whether the colour survives.
 *
 * Clamping each primary on its own does not work: it pushes the weaker
 * primaries up towards the strongest, so the hue moves. Scaling all three by
 * the same factor keeps the ratios and so keeps the colour — (255, 84, 43),
 * still a warm red.
 *
 * The cost is brightness: a mix that overflows comes back at less than full.
 * That is the right way round for a light show. A warm white that is actually
 * warm beats a brighter one that has gone neutral, and brightness is what the
 * dimmer is for — whereas nothing downstream can put a lost hue back.
 */
function normalizeMix(r: number, g: number, b: number): { r: number; g: number; b: number } {
  const peak = Math.max(r, g, b);
  const scale = peak > 255 ? 255 / peak : 1;
  return {
    r: clamp255(r * scale),
    g: clamp255(g * scale),
    b: clamp255(b * scale),
  };
}

function clamp255(value: number): number {
  return value > 255 ? 255 : (value < 0 ? 0 : Math.round(value));
}

/**
 * The colour each Hue lamp in the patch should show, read back out of the
 * rendered frame.
 *
 * Reading the rendered universe rather than asking the engine for its
 * intermediate values is the whole point: by this stage the lamp's colour has
 * already had the dimmer, the per-fixture trim, the grand master, any override
 * and master blackout applied to it. Whatever a lamp shows is therefore
 * exactly what the show rendered for it, including going dark when the rig
 * does.
 *
 * A lamp with no colour channels at all (a plain white one) is read as
 * neutral white at its dimmer level. Two lamps on one channel cannot both be
 * shown; the first in the patch is.
 */
function hueChannelColors(): HueChannelColour[] {
  const out: HueChannelColour[] = [];
  const sent = new Set<number>();

  for (const fix of state.fixtures) {
    const lamp = fix.output;
    if (!lamp || lamp.protocol !== 'hue' || sent.has(lamp.channel)) continue;
    sent.add(lamp.channel);

    const profile = getProfile(fix);
    const ch = profile.channelMap;
    const at: ChannelReader = channelReader(universeOf(fix), fix.address, profile, (u) => universes.getBuffer(u));

    // A lamp with nothing that makes coloured light — a plain white one — is
    // read as neutral white at its level. Tested against every emitter rather
    // than the primaries alone: a tunable-white lamp has warm and cool dies
    // but no primaries, and falling back for it would add the dimmer on top of
    // the whites and double the brightness.
    if (!EMITTERS.some((name) => ch[name] !== undefined)) {
      const level = at(ch.dimmer);
      out.push({ id: lamp.channel, r: level, g: level, b: level });
      continue;
    }
    const [r, g, b] = emitterMix(ch, at);
    out.push({ id: lamp.channel, ...normalizeMix(r, g, b) });
  }
  return out;
}

/** A lamp's emitters folded into red, green and blue, before normalising. */
function emitterMix(ch: ChannelMap, at: ChannelReader): [number, number, number] {
  const r = at(ch.red);
  const g = at(ch.green);
  const b = at(ch.blue);
  const uv = at(ch.uv);
  const ww = at(ch.warmWhite);
  const cw = at(ch.coolWhite);
  return [
    r + ww + cw + uv * UV_RED,
    g + ww * WARM_WHITE_GREEN + cw * COOL_WHITE_GREEN,
    b + ww * WARM_WHITE_BLUE + cw * COOL_WHITE_BLUE + uv * UV_BLUE,
  ];
}

/**
 * Push the current frame to the Hue bridge.
 *
 * Separate from sendUniverse() because it is not per-universe: one message
 * carries every channel in the entertainment area, whatever universes their
 * fixtures happen to live on. Called once per rendered frame.
 */
function sendHue(): boolean {
  return hue.sendFrame(hueChannelColors());
}

/**
 * Put one universe on every enabled wire, from this thread. Returns the
 * protocols the frame was handed to; `immediate` skips the Hue delay line and
 * `terminate` ends the universe's sACN stream (see transmit.js).
 */
function sendUniverse(universe: number, frame: Buffer, { immediate = false, terminate = false }: SendOptions = {}):
  Wire[] {
  return transmitter.send(universe, frame, transmitConfig(), { immediate, terminate });
}

/** After the last universe of a frame: the ArtSync, when it is on. */
function endFrame(): void {
  transmitter.endFrame(transmitConfig());
}

export const getHueStatus = () => hue.getStatus();
export const stopHue = () => hue.stop();

export {
  configureSacn,
  getSacnConfig,
  sacnUniverseFor,
  sendUniverse,
  endFrame,
  transmitConfig,
  artnetDiscovery,
  configureHue,
  getHueConfig,
  onHueApplicationId,
  hueChannelColors,
  sendHue,
};
