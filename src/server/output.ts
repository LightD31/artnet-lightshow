import { state, universeOf } from './state.ts';
import { getProfile } from './profiles.ts';
import { EMITTERS } from '../shared/rig.ts';
import { channelReader } from '../shared/placement.ts';
import * as universes from './universes.ts';
import { createTransmitter, sacnUniverseFor as mapSacnUniverse } from './transmit.ts';
import { createDiscovery, interfaces, isBroadcastTarget } from './artnet-nodes.ts';
import { isLoopback } from './loopback.ts';
import * as hue from './hue.ts';
import { isArmed, setArmedFlag } from './armed.ts';
import { defaultHueBridgeId } from './settings.ts';
import type { HueChannelColour } from './hue.ts';
import { ddpRoutes } from './ddp-routes.ts';
import { openrgbRoutes } from './openrgb-routes.ts';
import type { SacnOutput, SendOptions, TransmitConfig, Wire } from './transmit.ts';
import type { Settings } from './settings.ts';
import type { ChannelMap } from '../types/rig.ts';

type ChannelReader = (offset: number | undefined) => number;

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

let hueLatencyMs = 0;

function configureHue(config: Partial<Settings['hue']> | null | undefined): HueOutputConfig {
  const { latencyMs, bridges } = config || {};
  if (typeof latencyMs === 'number' && Number.isFinite(latencyMs)) hueLatencyMs = Math.max(0, Math.min(500, Math.round(latencyMs)));
  if (bridges) hue.configureBridges(bridges);
  return getHueConfig();
}

export type HueOutputConfig = Pick<Settings['hue'], 'bridges' | 'latencyMs'>;

function getHueConfig(): HueOutputConfig {
  return { bridges: hue.getConfigs(), latencyMs: hueLatencyMs };
}

const transmitter = createTransmitter();

function artnetDiscoveryWanted(): boolean {
  const a = state.artnet;
  return a.enabled !== false && a.discovery !== false && isBroadcastTarget(a.host) && !isLoopback(a.host);
}

const artnetDiscovery = createDiscovery({
  shouldPoll: artnetDiscoveryWanted,
  targets: () => [...interfaces().map((i) => i.broadcast), state.artnet.host],
});

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
    delayMs: hueLatencyMs > 0 && hue.anyEnabled() ? hueLatencyMs : 0,
    ddp: ddpRoutes(state.fixtures, getProfile, universeOf),
    openrgb: openrgbRoutes(state.fixtures, getProfile, universeOf),
    armed: isArmed(),
  };
}

function setArmed(on: boolean): boolean {
  if (!setArmedFlag(on)) return false;
  if (!on) hue.closeAll().catch(() => { /* best effort, as every teardown is */ });
  return true;
}

function onHueApplicationId(fn: (bridgeId: string, applicationId: string) => void): void { hue.setApplicationIdSink(fn); }

function sacnUniverseFor(universe: number, offset = sacn.universeOffset): number | null {
  return mapSacnUniverse(universe, offset);
}

const WARM_WHITE_GREEN = 0.66;
const WARM_WHITE_BLUE = 0.34;

const COOL_WHITE_GREEN = 0.98;
const COOL_WHITE_BLUE = 0.99;

// Map UV to visible violet so Hue lamps stay lit during UV washes.
const UV_RED = 0.45;
const UV_BLUE = 0.85;

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

// Read final DMX so Hue output includes masters, trim, overrides and blackout.
function hueChannelColors(): Map<string, HueChannelColour[]> {
  const out = new Map<string, HueChannelColour[]>();
  const fallback = defaultHueBridgeId(hue.getConfigs());

  for (const fix of state.fixtures) {
    const lamp = fix.output;
    if (!lamp || lamp.protocol !== 'hue') continue;
    const bridge = lamp.bridge || fallback;
    let channels = out.get(bridge);
    if (!channels) {
      channels = [];
      out.set(bridge, channels);
    }
    if (channels.some((c) => c.id === lamp.channel)) continue;

    const profile = getProfile(fix);
    const ch = profile.channelMap;
    const at: ChannelReader = channelReader(universeOf(fix), fix.address, profile, (u) => universes.getBuffer(u));

    if (!EMITTERS.some((name) => ch[name] !== undefined)) {
      const level = at(ch.dimmer);
      channels.push({ id: lamp.channel, r: level, g: level, b: level });
      continue;
    }
    const [r, g, b] = emitterMix(ch, at);
    channels.push({ id: lamp.channel, ...normalizeMix(r, g, b) });
  }
  return out;
}

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

// Send Hue once per frame because an area can span several DMX universes.
function sendHue(): boolean {
  if (!isArmed()) return false;
  return hue.sendFrames(hueChannelColors());
}

function sendUniverse(universe: number, frame: Buffer, { immediate = false, terminate = false }: SendOptions = {}):
  Wire[] {
  return transmitter.send(universe, frame, transmitConfig(), { immediate, terminate });
}

function endFrame(): void {
  transmitter.endFrame(transmitConfig());
}

export const getHueStatus = () => hue.getStatusAll();
export const stopHue = () => hue.stopAll();

export {
  configureSacn,
  getSacnConfig,
  sacnUniverseFor,
  sendUniverse,
  endFrame,
  transmitConfig,
  setArmed,
  isArmed,
  artnetDiscovery,
  configureHue,
  getHueConfig,
  onHueApplicationId,
  hueChannelColors,
  sendHue,
};
