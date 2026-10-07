import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { state, universeOf, wireUniverses, countUniverses } from './state.ts';
import { getProfile } from './profiles.ts';
import { fitIssue, footprintOf, overlaps, hasNoAddress } from '../shared/placement.ts';
import { MAX_UNIVERSES } from './universes.ts';
import { settings } from './settings.ts';
import type { Settings } from './settings.ts';
import { discoverNodes, probeSend } from './artnet.ts';
import { interfaces } from './artnet-nodes.ts';
import * as output from './output.ts';
import { isArmed } from './armed.ts';
import { engineStatus } from './engine.ts';
import { MIN_UNIVERSE, MAX_UNIVERSE } from './sacn.ts';
import { listEntertainmentConfigs } from './hue.ts';
import { wledClient } from './wled.ts';
import { runsOf, pixelWidth } from './ddp-routes.ts';
import { OPENRGB_PORT, openrgbClient } from './openrgb.ts';
import { openrgbOutputOf } from './openrgb-routes.ts';
import { unitCount } from '../shared/rig.ts';
import type { WledClient } from './wled.ts';
import type { OpenRgbClient } from './openrgb.ts';
import type { DdpOutput, Fixture } from '../types/rig.ts';
import { cues } from './cues.ts';
import { midiMap } from './midi-map.ts';
import * as pythonEnv from '../python-env.ts';
import * as ytdlp from '../ytdlp.ts';
import * as tools from '../tools.ts';
import { codeOf, messageOf } from '../errors.ts';
import { listLiveDevices } from '../live-input.ts';
import { modelManager } from './model-manager.ts';
import type { ModelManager, ModelRow } from './model-manager.ts';
import type { LiveDevices } from '../live-input.ts';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { EngineStatus } from './engine.ts';
import { isLoopback } from './loopback.ts';
import { osNowPlayingKind } from '../os-now-playing.ts';

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'info';

/** One row of the pre-show report. */
export interface Check {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  fix?: string | null;
  /** The Art-Net check lists the nodes that answered. */
  nodes?: unknown[];
}

/** What running a command said. */
export interface ProbeResult {
  ok: boolean;
  version?: string;
  error: string | null;
}

export interface PreflightReport {
  ok: boolean;
  counts: Record<CheckStatus, number>;
  checks: Check[];
  at: string;
}

/** The live subsystems the checks read, when there are any (none from the CLI). */
export interface PreflightSubjects {
  midi?: { enabled: boolean; listPorts(): { inputs: string[] } } | null;
  spotify?: { authenticated?: boolean; configured?: boolean } | null;
  prolink?: { connected?: boolean } | null;
  analysisCache?: { dir?: string; count(): number } | null;
  downloadModels?: boolean;
  standalone?: boolean;
}


/**
 * The check you run before doors open.
 *
 * Every piece of this stack degrades quietly by design: Art-Net send failures
 * are logged and the render loop carries on, a missing MuQ-MuLan checkpoint drops
 * genre classification and falls back to a mood palette, an absent ffmpeg only
 * surfaces when the first track downloads. Individually that is the right
 * behaviour — none of it should take the show down mid-set. Collectively it
 * means the first sign of a broken rig is the rig not working, in front of an
 * audience.
 *
 * So: one command that asks every one of those questions up front, while there
 * is still time to fix the answer.
 *
 * Statuses:
 *   ok    working
 *   warn  works, but degraded — or we could not prove it either way
 *   fail  will not work; fix before the show
 *   info  nothing to verify, just worth seeing
 */

const OK: CheckStatus = 'ok';
const WARN: CheckStatus = 'warn';
const FAIL: CheckStatus = 'fail';
const INFO: CheckStatus = 'info';

/** Run a command and capture its first line of output. */
function probeCommand(command: string, args: string[], timeoutMs = 5000): Promise<ProbeResult> {
  return new Promise((resolve) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(command, args, { windowsHide: true });
    } catch (err) {
      resolve({ ok: false, error: messageOf(err) });
      return;
    }

    let out = '';
    let settled = false;
    const finish = (result: ProbeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill(); } catch (_) { /* already gone */ }
      resolve(result);
    };

    const timer = setTimeout(() => finish({ ok: false, error: `timed out after ${timeoutMs}ms` }), timeoutMs);
    timer.unref();

    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('error', (err) => finish({
      ok: false,
      error: codeOf(err) === 'ENOENT' ? 'not found on PATH' : err.message,
    }));
    child.on('close', (code) => finish({
      ok: code === 0,
      version: String(out).trim().split(/\r?\n/)[0] || '',
      error: code === 0 ? null : `exited ${code}`,
    }));
  });
}

// ── Individual checks ───────────────────────────────────────────────────────

async function checkArtnet(): Promise<Check> {
  if (state.artnet.enabled === false) {
    return {
      id: 'artnet', label: 'Art-Net output', status: INFO,
      detail: 'Disabled. Frames go out over sACN only.',
    };
  }

  const target = { host: state.artnet.host, port: state.artnet.port, universe: state.artnet.universe };
  const send = await probeSend(target);
  if (!send.ok) {
    return {
      id: 'artnet', label: 'Art-Net output', status: FAIL,
      detail: `Cannot send to ${target.host}:${target.port} — ${send.error}`,
      fix: 'Check the node IP in Settings → ArtNet Output, and that this machine is on the lighting network.',
    };
  }

  // While the server keeps the node list itself, it holds the Art-Net port:
  // ask it for a fresh poll rather than binding the port a second time.
  let nodes;
  let error;
  if (output.artnetDiscovery.active) {
    output.artnetDiscovery.pollNow();
    await new Promise((r) => setTimeout(r, 1500));
    ({ nodes, error } = output.artnetDiscovery.status());
  } else {
    ({ nodes, error } = await discoverNodes({ host: target.host, port: target.port }));
  }
  if (error) {
    return {
      id: 'artnet', label: 'Art-Net output', status: WARN,
      detail: `Sending to ${target.host}:${target.port} works, but could not listen for replies — ${error}`,
      fix: 'Usually another lighting tool already holds UDP 6454. Frames still go out; discovery is the only thing affected.',
    };
  }
  if (!nodes.length) {
    // Plenty of nodes never implement ArtPoll, and a broadcast rig works fine
    // without ever answering one. Silence is not proof of a problem.
    return {
      id: 'artnet', label: 'Art-Net output', status: WARN,
      detail: `Sending to ${target.host}:${target.port}, but no node answered a poll.`,
      fix: 'Many nodes never reply to ArtPoll, so this can be normal. If the rig is dark, check the node IP and the subnet.',
    };
  }
  return {
    id: 'artnet', label: 'Art-Net output', status: OK,
    detail: `${nodes.length} node${nodes.length === 1 ? '' : 's'} answered: `
      + nodes.map((n) => `${n.shortName || n.longName || 'unnamed'} at ${n.from} (${
        n.outputs && n.outputs.length > 1 ? `universes ${n.outputs.join(', ')}` : `universe ${n.universe}`})`).join(', ')
      + (output.artnetDiscovery.active ? ' — each is sent its universes directly.' : ''),
    nodes,
  };
}

/**
 * The engine: is it rendering, where, and have its frames been going out on
 * time? A frame half a period late is visibly off the beat grid, and on the
 * main thread that is what a busy server does to the rig — which is why the
 * engine has a thread of its own, and why this says so when it has not.
 */
function checkEngine(status: EngineStatus = engineStatus(), { standalone = false } = {}): Check {
  const label = 'Engine';
  if (!status.thread) {
    // `npm run preflight` runs on its own, before the server is started: there
    // is no engine in that process to report on.
    if (standalone) {
      return { id: 'engine', label, status: INFO, detail: 'Checked on its own — start the server to see how its frames are going.' };
    }
    return { id: 'engine', label, status: FAIL, detail: 'Not rendering.', fix: 'Restart the server.' };
  }
  const where = status.thread === 'worker' ? 'on its own thread' : 'on the main thread';
  const timing = status.frames && status.renderMs && status.lateMs
    ? ` ${status.rate} frames a second; ${status.renderMs.p95} ms to render a frame (p95), `
      + `${status.lateMs.p95} ms late at most on 19 frames of 20.`
    : '';
  const late = (status.lateFrames || 0) + (status.skippedFrames || 0);
  // A dropped frame is worth a warning; a frame that went out a little late
  // now and then (a laptop waking a core, a garbage collection) is not, until
  // it is one in a hundred.
  const worrying = (status.skippedFrames || 0) > 0
    || (status.lateFrames || 0) > Math.max(2, 0.01 * (status.frames || 0));

  if (status.fellBack) {
    return {
      id: 'engine', label, status: WARN,
      detail: `Rendering ${where}, because ${status.fellBack}.${timing}`,
      fix: 'The rig still runs, but a busy server can now delay it. Restart the server; if this keeps '
        + 'happening, note the error the log shows for the engine thread.',
    };
  }
  if (worrying) {
    return {
      id: 'engine', label, status: WARN,
      detail: `Rendering ${where}, but ${late} frame${late === 1 ? '' : 's'} went out late or not at all `
        + `in the last minute.${timing}`,
      fix: status.thread === 'worker'
        ? 'The machine itself is short of time: close other heavy programs, or plug a laptop in.'
        : 'Set Settings → Engine → Render On to its own thread and restart.',
    };
  }
  const note = late ? ` ${late} frame${late === 1 ? '' : 's'} a little late in the last minute.` : '';
  return { id: 'engine', label, status: OK, detail: `Rendering ${where}.${timing}${note}` };
}

/**
 * Whether anything leaves the machine (armed.ts). Disarmed is how the server
 * spends its days, so it is a warning here rather than a failure: worth
 * seeing before doors open, and one press to put right.
 */
function checkOutputsArmed(armed: boolean = isArmed(), { standalone = false } = {}): Check {
  const label = 'Outputs armed';
  if (standalone) {
    return { id: 'armed', label, status: INFO, detail: 'Checked on its own — the running server says whether its outputs are armed.' };
  }
  if (!armed) {
    return {
      id: 'armed', label, status: WARN,
      detail: 'Outputs disarmed: the show renders, but nothing goes out to the rig.',
      fix: 'Arm the outputs before doors open — the switch in Perform or Settings → Show, or POST /api/outputs/arm.',
    };
  }
  return { id: 'armed', label, status: OK, detail: 'Armed: frames go out to the rig.' };
}

function checkSacn(): Check {
  const config = output.getSacnConfig();
  if (!config.enabled) {
    return {
      id: 'sacn', label: 'sACN output', status: INFO,
      detail: 'Disabled. Turn it on in Settings → sACN (E1.31) if your console speaks it.',
    };
  }

  const mapped = wireUniverses().map((u) => [u, output.sacnUniverseFor(u)]);
  const unmappable = mapped.filter(([, to]) => to === null).map(([from]) => from);
  if (unmappable.length) {
    return {
      id: 'sacn', label: 'sACN output', status: FAIL,
      detail: `Universe ${unmappable.join(', ')} maps outside the ${MIN_UNIVERSE}–${MAX_UNIVERSE} sACN range `
        + `at offset ${config.universeOffset}, so ${unmappable.length === 1 ? 'it' : 'they'} will not be sent.`,
      fix: 'Change the universe offset in Settings → sACN (E1.31), or move those fixtures.',
    };
  }

  if (config.interface && !interfaces().some((i) => i.address === config.interface)) {
    return {
      id: 'sacn', label: 'sACN output', status: FAIL,
      detail: `Multicast is set to leave from ${config.interface}, which is not an address of this machine.`,
      fix: 'Pick the show network under Settings → sACN (E1.31) → Network, or let the computer choose.',
    };
  }

  const where = config.host
    ? `unicast to ${config.host}`
    : `multicast${config.interface ? ` from ${config.interface}` : ''}`;
  return {
    id: 'sacn', label: 'sACN output', status: OK,
    detail: `${where}, priority ${config.priority}, as "${config.sourceName}". `
      + `Universes ${mapped.map(([from, to]) => `${from}→${to}`).join(', ')}.`,
  };
}

/**
 * The WLEDs in the patch: does each answer, and is it still the length it was
 * patched as? A WLED re-set to fewer LEDs takes the pixels past its end
 * nowhere; one given more leaves them to its own effects.
 */
async function checkWled(client: Pick<WledClient, 'info'> = wledClient): Promise<Check> {
  const wleds = state.fixtures.filter((f) => f.output?.protocol === 'ddp');
  if (!wleds.length) {
    return { id: 'wled', label: 'WLED', status: INFO, detail: 'None in the patch. Add one under Settings → Output → WLED.' };
  }
  const answers = await Promise.all(wleds.map(async (fix) => {
    const output = fix.output as DdpOutput;
    const host = output.host;
    const profile = getProfile(fix);
    // A segment has to fit in the WLED; all of it has to be all of it — its
    // LEDs, which a wash or zones light a few cells across.
    const segment = output.at !== undefined;
    const patched = segment
      ? Math.max(...runsOf(output, profile, pixelWidth(profile) || profile.channelCount).map((run) => run.at + run.count))
      : output.leds ?? unitCount(profile);
    try {
      const info = await client.info(host);
      return { fix, host, patched, segment, leds: info.leds, error: null };
    } catch (err) {
      return { fix, host, patched, segment, leds: 0, error: err instanceof Error ? err.message : String(err) };
    }
  }));
  const silent = answers.filter((a) => a.error);
  const resized = answers.filter((a) => !a.error && (a.segment ? a.leds < a.patched : a.leds !== a.patched));
  if (silent.length) {
    return {
      id: 'wled', label: 'WLED', status: FAIL,
      detail: silent.map((a) => `"${a.fix.label}" at ${a.host} does not answer (${a.error})`).join('; '),
      fix: 'Check it is powered and on this network, or correct its address in Settings → Fixture Patch.',
    };
  }
  if (resized.length) {
    return {
      id: 'wled', label: 'WLED', status: WARN,
      detail: resized.map((a) => (a.segment
        ? `"${a.fix.label}" reaches LED ${a.patched}, but its WLED reports ${a.leds}`
        : `"${a.fix.label}" reports ${a.leds} LEDs but is patched as ${a.patched}`)).join('; '),
      fix: 'Remove it from the patch and add it again under Settings → Output → WLED.',
    };
  }
  return {
    id: 'wled', label: 'WLED', status: OK,
    detail: answers.map((a) => `"${a.fix.label}" at ${a.host}, ${a.leds} LEDs`).join('; ') + ', sent over DDP.',
  };
}

/**
 * The OpenRGB devices in the patch: does each server answer, does it still
 * list each device, and is the device still the length it was patched as? A
 * PC that is off is a warning, not a failure: the rest of the show goes on
 * without its RGB.
 */
async function checkOpenRgb(client: Pick<OpenRgbClient, 'discover'> = openrgbClient): Promise<Check> {
  const fixtures = state.fixtures.filter((f) => openrgbOutputOf(f));
  if (!fixtures.length) {
    return { id: 'openrgb', label: 'OpenRGB', status: INFO, detail: 'None in the patch. Add a PC\'s devices under Rig → Outputs → OpenRGB.' };
  }
  const servers = new Map<string, { host: string; port: number; fixtures: typeof fixtures }>();
  for (const fix of fixtures) {
    const output = openrgbOutputOf(fix) as NonNullable<ReturnType<typeof openrgbOutputOf>>;
    const port = output.port ?? OPENRGB_PORT;
    const key = `${output.host.toLowerCase()}:${port}`;
    const entry = servers.get(key) || { host: output.host, port, fixtures: [] };
    entry.fixtures.push(fix);
    servers.set(key, entry);
  }
  const where = (s: { host: string; port: number }) => (s.port === OPENRGB_PORT ? s.host : `${s.host}:${s.port}`);
  const silent: string[] = [];
  const wrong: string[] = [];
  const fine: string[] = [];
  await Promise.all([...servers.values()].map(async (server) => {
    const names = server.fixtures.map((f) => `"${f.label}"`).join(', ');
    let devices;
    try {
      devices = await client.discover(server.host, server.port);
    } catch (err) {
      silent.push(`OpenRGB at ${where(server)} does not answer (${messageOf(err)}); on it: ${names}`);
      return;
    }
    const outputs = server.fixtures.map((fix) => ({ fix, output: openrgbOutputOf(fix) as NonNullable<ReturnType<typeof openrgbOutputOf>> }));
    for (const { fix, output } of outputs) {
      // A device patched under a name is the one of its name, in order, as
      // the transmitter finds it (openrgb.ts resolve); one patched by number
      // alone is that number.
      let device = output.name ? undefined : devices.find((d) => d.index === output.device);
      let moved = '';
      if (output.name) {
        const named = devices.filter((d) => d.name === output.name);
        const siblings = outputs.filter((o) => o.output.name === output.name).map((o) => o.output.device).sort((a, b) => a - b);
        device = named[Math.max(0, siblings.indexOf(output.device))];
        if (!device) {
          wrong.push(`"${fix.label}" (${output.name}, #${output.device}) is not among the ${devices.length} devices at ${where(server)}`);
          continue;
        }
        if (device.index !== output.device) moved = ` (was #${output.device})`;
      } else if (!device) {
        wrong.push(`"${fix.label}" is device #${output.device} at ${where(server)}, which lists only ${devices.length}`);
        continue;
      }
      if (device.leds !== output.leds) wrong.push(`"${fix.label}" (${device.name}) reports ${device.leds} LEDs but is patched as ${output.leds}`);
      else fine.push(`"${fix.label}" at ${where(server)} #${device.index}${moved} ${device.name}, ${device.leds} LEDs`);
    }
  }));
  if (silent.length) {
    return {
      id: 'openrgb', label: 'OpenRGB', status: WARN, detail: silent.join('; '),
      fix: 'Start OpenRGB on that PC with its SDK server on, check the address in the patch, or remove its fixtures from the patch.',
    };
  }
  if (wrong.length) {
    return {
      id: 'openrgb', label: 'OpenRGB', status: WARN, detail: wrong.join('; '),
      fix: 'A device patched under its name is found again by it once OpenRGB lists it (a monitor asleep, a mouse off). '
        + 'One gone for good, or patched by number alone and renumbered: remove the fixture and add the device again under Rig → Outputs → OpenRGB.',
    };
  }
  return { id: 'openrgb', label: 'OpenRGB', status: OK, detail: `${fine.join('; ')}, sent over the OpenRGB SDK.` };
}

/**
 * Philips Hue: is the bridge there, does the area still exist, and is every
 * Hue lamp in the patch one of its channels?
 *
 * The last question is the one worth asking before doors. A lamp is patched
 * as a channel of the area, and an area rebuilt in the Hue app, or another one
 * picked, can leave it naming a channel that is not there — the bridge takes
 * the colour and ignores it, which on the night looks like a dead lamp rather
 * than a configuration mistake.
 */
async function checkHue(listAreas = listEntertainmentConfigs): Promise<Check[]> {
  const config = output.getHueConfig();
  const lamps = state.fixtures.filter((f) => f.output?.protocol === 'hue');
  const bridgeOf = (f: (typeof lamps)[number]) => (f.output?.protocol === 'hue' ? f.output.bridge : '');
  if (!config.bridges.length) {
    return [lamps.length ? {
      id: 'hue', label: 'Philips Hue', status: WARN,
      detail: `${lamps.length} Hue lamp${lamps.length === 1 ? ' is' : 's are'} in the patch, but no bridge is paired, so `
        + `${lamps.length === 1 ? 'it stays' : 'they stay'} dark.`,
      fix: 'Pair the bridge in Rig → Outputs → Philips Hue, or remove the lamps from the patch.',
    } : {
      id: 'hue', label: 'Philips Hue', status: INFO,
      detail: 'No bridge paired. Pair one in Rig → Outputs → Philips Hue to drive Hue lamps from the show.',
    }];
  }

  // Every bridge is asked at once: each is its own device on its own address.
  const checks = await Promise.all(config.bridges.map((bridge) =>
    checkHueBridge(bridge, lamps.filter((f) => bridgeOf(f) === bridge.id), listAreas)));
  const known = new Set(config.bridges.map((b) => b.id));
  const orphans = lamps.filter((f) => !known.has(bridgeOf(f)));
  if (orphans.length) {
    checks.push({
      id: 'hue', label: 'Philips Hue', status: WARN,
      detail: `${orphans.map((f) => `"${f.label}" (bridge ${bridgeOf(f)})`).join(', ')} name${orphans.length === 1 ? 's' : ''} a bridge `
        + `that is not paired, so ${orphans.length === 1 ? 'it stays' : 'they stay'} dark.`,
      fix: 'The bridge was forgotten. Remove those lamps and add them again from the bridge they belong to.',
    });
  }
  return checks;
}
async function checkHueBridge(bridge: Settings['hue']['bridges'][number], lamps: typeof state.fixtures,
  listAreas = listEntertainmentConfigs): Promise<Check> {
  const id = `hue:${bridge.id}`;
  const name = bridge.label || bridge.id;
  const label = `Philips Hue — ${name}`;
  const channelsOf = (f: (typeof lamps)[number]) => (f.output?.protocol === 'hue' ? f.output.channels : []);
  if (!bridge.enabled) {
    return lamps.length ? {
      id, label, status: WARN,
      detail: `${lamps.length} lamp${lamps.length === 1 ? ' is' : 's are'} in the patch, but the bridge's output is off, so `
        + `${lamps.length === 1 ? 'it stays' : 'they stay'} dark.`,
      fix: `Turn "${name}" on in Rig → Outputs → Philips Hue, or remove its lamps from the patch.`,
    } : {
      id, label, status: INFO,
      detail: `Off. Turn "${name}" on in Rig → Outputs → Philips Hue to drive its lamps from the show.`,
    };
  }

  const missing = [];
  if (!bridge.host) missing.push('bridge address');
  if (!bridge.username || !bridge.clientKey) missing.push('pairing');
  if (!bridge.entertainmentId) missing.push('entertainment area');
  if (missing.length) {
    return {
      id, label, status: FAIL,
      detail: `"${name}" is on but the ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not set up.`,
      fix: 'Open Rig → Outputs → Philips Hue, press the bridge\'s link button to pair, then pick an area.',
    };
  }

  if (!lamps.length) {
    return {
      id, label, status: WARN,
      detail: `Paired with "${name}" at ${bridge.host}, but none of its lamps is in the patch, so nothing of it will light.`,
      fix: 'Add the area\'s lamps in Rig → Outputs → Philips Hue.',
    };
  }

  const seen = new Map<number, string>();
  for (const lamp of lamps) {
    for (const channel of channelsOf(lamp)) {
      const other = seen.get(channel);
      if (other) {
        return {
          id, label, status: WARN,
          detail: `"${lamp.label}" and "${other}" are both on channel ${channel} of "${name}"; only "${other}" is shown there.`,
          fix: 'Remove one of them from the patch.',
        };
      }
      seen.set(channel, lamp.label);
    }
  }

  // A bridge that does not answer is a warning rather than a failure: the
  // rest of the rig, and the other bridges, still run, and it is named so the
  // operator knows which one to go and look at.
  let areas;
  try {
    areas = await listAreas(bridge.host, bridge.username);
  } catch (err) {
    return {
      id, label, status: WARN,
      detail: `Cannot reach "${name}" at ${bridge.host} — ${messageOf(err)}`,
      fix: 'Check the bridge is powered and on this network, and that its IP has not changed.',
    };
  }

  const area = areas.find((a) => a.id === bridge.entertainmentId);
  if (!area) {
    return {
      id, label, status: FAIL,
      detail: `"${name}" at ${bridge.host} has no entertainment area ${bridge.entertainmentId} any more.`,
      fix: 'It was probably renamed or rebuilt in the Hue app. Pick the area again in Rig → Outputs → Philips Hue.',
    };
  }

  // A channel the area does not define is accepted by the bridge and quietly
  // ignored, so it would never surface as an error at show time.
  const areaChannels = new Set(area.channels.map((c) => c.id));
  const stray = lamps.filter((f) => channelsOf(f).some((ch) => !areaChannels.has(ch)));
  if (stray.length) {
    const absent = (f: (typeof lamps)[number]) => channelsOf(f).filter((ch) => !areaChannels.has(ch)).map((ch) => `#${ch}`).join(', ');
    return {
      id, label, status: WARN,
      detail: `"${area.name}" has no channel ${stray.map((f) => `${absent(f)} for "${f.label}"`).join('; ')}, `
        + `so ${stray.length === 1 ? 'that stays' : 'those stay'} dark.`,
      fix: 'The area was probably changed in the Hue app. Remove those lamps and add them again from Rig → Outputs → Philips Hue.',
    };
  }

  // A gradient lamp whose sections were changed in the Hue app renders other
  // channels now; the patch still sends the old ones, so part of it is wrong.
  const resectioned = lamps.filter((f) => {
    const channels = channelsOf(f);
    const lamp = area.lamps.find((l) => l.channels.includes(channels[0]));
    return lamp && (lamp.channels.length !== channels.length || lamp.channels.some((ch, k) => ch !== channels[k]));
  });
  if (resectioned.length) {
    return {
      id, label, status: WARN,
      detail: `${resectioned.map((f) => `"${f.label}"`).join(', ')} ${resectioned.length === 1 ? 'has' : 'have'} different sections `
        + `in "${area.name}" now than when ${resectioned.length === 1 ? 'it was' : 'they were'} patched.`,
      fix: 'Remove those lamps and add them again from Rig → Outputs → Philips Hue.',
    };
  }

  const live = output.getHueStatus().find((s) => s.id === bridge.id);
  if (live && live.status === 'failed') {
    return {
      id, label, status: WARN,
      detail: `"${area.name}" on "${name}" is set up correctly, but the last stream attempt failed — ${live.error}.`,
      fix: 'A bridge only allows one entertainment stream at a time. Close the Hue app\'s sync or any other tool streaming to it.',
    };
  }

  const left = area.lamps.filter((l) => !l.channels.some((ch) => seen.has(ch))).length;
  return {
    id, label, status: OK,
    detail: `"${area.name}" on "${name}" at ${bridge.host}: ${lamps.map((f) => f.label).join(', ')}`
      + `${left > 0 ? `; ${left} of its lamp${left === 1 ? ' is' : 's are'} not in the patch` : ''}.`,
  };
}

function checkPatch(): Check {
  const problems = [];

  for (const fix of state.fixtures) {
    const issue = fitIssue(fix.label, fix.address, getProfile(fix), universeOf(fix));
    if (issue) problems.push(issue);
  }

  // Two fixtures only fight over an address when they share a universe — a
  // strip running on into the next counts on every universe it covers.
  const footprints = state.fixtures.map((f) => footprintOf(universeOf(f), f.address, getProfile(f)));
  for (let i = 0; i < state.fixtures.length; i++) {
    for (let j = i + 1; j < state.fixtures.length; j++) {
      if (!overlaps(footprints[i], footprints[j])) continue;
      const shared = footprints[i].find((x) => footprints[j].some((y) => y.universe === x.universe))?.universe;
      problems.push(`"${state.fixtures[i].label}" and "${state.fixtures[j].label}" overlap on universe ${shared}`);
    }
  }

  const universes = wireUniverses();
  const devices = state.fixtures.filter(hasNoAddress);
  const spanned = countUniverses(state.fixtures);
  if (spanned > MAX_UNIVERSES) {
    problems.push(`the patch spans ${spanned} universes, more than the ${MAX_UNIVERSES} rendered`);
  }

  if (problems.length) {
    return {
      id: 'patch', label: 'Fixture patch', status: FAIL,
      detail: problems.join('; '),
      fix: 'Fix the addressing in Settings → Fixture Patch.',
    };
  }

  return {
    id: 'patch', label: 'Fixture patch', status: OK,
    detail: `${state.fixtures.length - devices.length} fixture${state.fixtures.length - devices.length === 1 ? '' : 's'} `
      + `on universe${universes.length === 1 ? '' : 's'} ${universes.join(', ')}, no overlaps`
      + `${devices.length ? `, and ${deviceCounts(devices)} with no DMX address` : ''}.`,
  };
}

/** The fixtures sent to devices of their own, counted by kind: "2 Hue lamps and 1 WLED". */
function deviceCounts(fixtures: readonly Fixture[]): string {
  const kinds: [string, string, string][] = [['hue', 'Hue lamp', 'Hue lamps'], ['ddp', 'WLED', 'WLEDs'], ['openrgb', 'OpenRGB device', 'OpenRGB devices']];
  const parts = kinds.map(([protocol, one, many]) => {
    const n = fixtures.filter((f) => f.output?.protocol === protocol).length;
    return n ? `${n} ${n === 1 ? one : many}` : null;
  }).filter((part): part is string => part !== null);
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0];
}

function checkPython(): Check {
  const info = pythonEnv.resolve();
  if (!info.ok) {
    return {
      id: 'python', label: 'Python', status: FAIL,
      detail: `"${info.exe}" cannot be run — audio analysis will fail.`,
      fix: 'Set the analysis environment up under Sources → Analysis environment (it brings its own Python), '
        + 'or set a Python\'s full path under Sources → Analysis → Python.',
    };
  }
  if (info.missing.length) {
    const where = info.executable || info.exe;
    return {
      id: 'python', label: 'Python', status: FAIL,
      detail: `${where} (${info.version}) is missing: ${info.missing.join(', ')}.`,
      fix: `Set the analysis environment up under Sources → Analysis environment, or "${where}" -m pip install -r requirements.txt`,
    };
  }
  return {
    id: 'python', label: 'Python', status: OK,
    detail: `${info.executable || info.exe} (${info.version}) — all analyzer dependencies present.`,
  };
}

/**
 * The model stack, imported for real: torch, its audio and vision halves, the
 * beat model and the separator. `checkPython` only finds the packages; this is
 * what catches a torchvision built for a different torch, which installs
 * cleanly and then fails every model.
 */
async function checkModelStack(verify = pythonEnv.verify): Promise<Check> {
  const id = 'model-stack';
  const label = 'Model stack';
  const info = pythonEnv.resolve();
  if (!info.ok || info.missing.length) {
    return { id, label, status: INFO, detail: 'Not checked until the Python check above passes.' };
  }
  const report = await verify(info.executable || info.exe);
  const failures = Object.entries(report.errors);
  if (failures.length) {
    const torchPair = failures.some(([mod]) => mod.startsWith('torch'));
    return {
      id, label, status: FAIL,
      detail: failures.map(([mod, message]) => `${mod}: ${message}`).join('; '),
      fix: torchPair
        ? 'torch, torchaudio and torchvision have to come from the same build: reinstall the three together from one index '
          + '(Sources → Analysis environment → Update the environment, or see requirements.txt).'
        : `"${info.executable || info.exe}" -m pip install -r requirements.txt`,
    };
  }
  const where = report.accelerator === 'cpu' || !report.accelerator
    ? 'on the CPU'
    : `on ${report.device || 'the GPU'} (${report.accelerator === 'rocm' ? 'ROCm' : 'CUDA'})`;
  const versions = ([['torch', report.torch], ['torchaudio', report.torchaudio], ['torchvision', report.torchvision]] as const)
    .filter(([, version]) => version).map(([mod, version]) => `${mod} ${version}`).join(', ');
  return { id, label, status: OK, detail: `${versions}; the models load and run ${where}.` };
}

async function checkFfmpeg(): Promise<Check> {
  // On PATH, else the one the analysis environment installs (tools.ts).
  const found = await tools.ffmpeg();
  const r = await probeCommand(found ? found.command : 'ffmpeg', ['-version']);
  if (!r.ok) {
    return {
      id: 'ffmpeg', label: 'ffmpeg', status: FAIL,
      detail: `Not usable — ${r.error}. Downloaded audio cannot be decoded, so no track will analyse.`,
      fix: 'Set up the analysis environment (Sources → Analysis), which includes one, or install ffmpeg with your '
        + 'package manager and make sure it is on PATH.',
    };
  }
  const where = found && found.from === 'environment' ? ' — from the analysis environment' : '';
  return { id: 'ffmpeg', label: 'ffmpeg', status: OK, detail: `${r.version ?? ''}${where}` };
}

async function checkYtDlp(): Promise<Check> {
  // On PATH, else the one the analysis environment installs (tools.ts).
  const found = await ytdlp.find();
  const r = await probeCommand(found ? found.command : 'yt-dlp', ['--version']);
  if (!r.ok) {
    const hasDeezer = !!settings.get('deezer.arl');
    return {
      id: 'yt-dlp', label: 'yt-dlp', status: hasDeezer ? WARN : FAIL,
      detail: `Not usable — ${r.error}. `
        + (hasDeezer
          ? 'Deezer is configured, so ISRC-matched tracks still download; anything Deezer cannot match will fail.'
          : 'Nothing can be downloaded for analysis.'),
      fix: 'Set up the analysis environment (Sources → Analysis), which installs it, or '
        + 'pip install -U "yt-dlp[default]"  (or download it from https://github.com/yt-dlp/yt-dlp)',
    };
  }
  // Since 2025.11.12 YouTube needs a JavaScript runtime, which the server
  // hands yt-dlp itself (see src/ytdlp.ts) — but an older yt-dlp can neither
  // use one nor keep up with YouTube's current challenges.
  if (!ytdlp.needsJsRuntime(r.version ?? '')) {
    return {
      id: 'yt-dlp', label: 'yt-dlp', status: WARN,
      detail: `version ${r.version} predates ${ytdlp.JS_RUNTIME_SINCE}; YouTube downloads are likely to fail.`,
      fix: 'pip install -U "yt-dlp[default]"  (or download the latest from https://github.com/yt-dlp/yt-dlp)',
    };
  }
  const where = found && found.from === 'environment' ? ' from the analysis environment' : '';
  const runtime = ytdlp.runtimeName();
  if (!runtime) {
    return {
      id: 'yt-dlp', label: 'yt-dlp', status: WARN,
      detail: `version ${r.version}${where}, but no JavaScript runtime: YouTube downloads are likely to fail.`,
      fix: 'Set up the analysis environment (Sources → Analysis): it installs Deno beside yt-dlp.',
    };
  }
  return {
    id: 'yt-dlp', label: 'yt-dlp', status: OK,
    detail: `version ${r.version}${where}, JavaScript runtime: ${runtime}.`,
  };
}

// Kept in step with scripts/setup-panns.py, which downloads these.
const PANNS_DIR = path.join(os.homedir(), 'panns_data');
const PANNS_CHECKPOINT = path.join(PANNS_DIR, 'Cnn14_mAP=0.431.pth');
const PANNS_LABELS = path.join(PANNS_DIR, 'class_labels_indices.csv');
const PANNS_CHECKPOINT_SIZE = 327428481;

function checkPanns(): Check {
  const sizeOf = (file: string) => {
    try { return fs.statSync(file).size; } catch (_) { return null; }
  };

  const checkpoint = sizeOf(PANNS_CHECKPOINT);
  const labels = sizeOf(PANNS_LABELS);

  if (checkpoint === null || labels === null) {
    return {
      id: 'panns', label: 'PANNs tagger', status: WARN,
      detail: 'Not downloaded. Genre comes from MuQ-MuLan either way — see Analysis models — so '
        + 'this only costs the instrument-role priors and the genre fallback behind MuQ-MuLan.',
      fix: 'Download it under Settings → Analysis models, or run python scripts/setup-panns.py '
        + '(~310 MB, one time). The analysis never fetches it itself.',
    };
  }
  if (checkpoint !== PANNS_CHECKPOINT_SIZE) {
    return {
      id: 'panns', label: 'PANNs tagger', status: WARN,
      detail: `The checkpoint at ${PANNS_CHECKPOINT} is ${checkpoint} bytes, not the expected `
        + `${PANNS_CHECKPOINT_SIZE} — it is probably a truncated download.`,
      fix: 'python scripts/setup-panns.py --check',
    };
  }
  return {
    id: 'panns', label: 'PANNs tagger', status: OK,
    detail: `Checkpoint and labels in place at ${PANNS_DIR}.`,
  };
}

function checkCache(analysisCache: PreflightSubjects['analysisCache']): Check {
  const dir = analysisCache && analysisCache.dir;
  if (!dir) return { id: 'cache', label: 'Analysis cache', status: INFO, detail: 'Not configured.' };

  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
  } catch (err) {
    return {
      id: 'cache', label: 'Analysis cache', status: FAIL,
      detail: `${dir} is not writable — ${messageOf(err)}. Every track would be re-analysed from scratch.`,
      fix: 'Fix the permissions on that folder.',
    };
  }

  const entries = (analysisCache as { count(): number }).count();
  return {
    id: 'cache', label: 'Analysis cache', status: OK,
    detail: `${entries} cached ${entries === 1 ? 'analysis' : 'analyses'} in ${dir}.`,
  };
}

function checkMidi(midi: PreflightSubjects['midi']): Check {
  if (!midi) return { id: 'midi', label: 'MIDI', status: INFO, detail: 'Not available.' };

  const wanted = settings.get('midi.input');
  const { customised } = midiMap.snapshot();
  const mapNote = customised ? 'your saved mapping' : 'the built-in X-Touch mapping';

  if (midi.enabled) {
    return { id: 'midi', label: 'MIDI', status: OK, detail: `Connected, using ${mapNote}.` };
  }

  if (!wanted) {
    return {
      id: 'midi', label: 'MIDI', status: INFO,
      detail: 'No controller configured. The web UI and Companion still work.',
    };
  }

  const ports = midi.listPorts();
  const present = ports.inputs.includes(wanted);
  return {
    id: 'midi', label: 'MIDI', status: WARN,
    detail: present
      ? `"${wanted}" is present but not connected.`
      : `"${wanted}" is not among the available inputs (${ports.inputs.join(', ') || 'none'}).`,
    fix: 'Plug the controller in and reconnect it in Settings → MIDI.',
  };
}

function checkPlaybackSources({ spotify, prolink }: Pick<PreflightSubjects, 'spotify' | 'prolink'> = {}): Check {
  const configured: string[] = [];
  if (spotify && spotify.authenticated) configured.push('Spotify (connected)');
  else if (spotify && spotify.configured) configured.push('Spotify (configured, not connected — visit /auth/spotify)');
  if (prolink && prolink.connected) configured.push('PRO DJ LINK (connected)');
  else if (state.prolinkEnabled) configured.push('PRO DJ LINK (enabled, no CDJs seen yet)');
  const osKind = osNowPlayingKind();
  if (settings.get('sources.smtc') && osKind) configured.push(`Now playing (${osKind})`);
  if (settings.get('deezer.arl')) configured.push('Deezer ARL (exact ISRC audio)');

  if (!configured.length) {
    return {
      id: 'sources', label: 'Playback sources', status: WARN,
      detail: 'None connected. The auto-show can only run against a wall clock (the "timer" source).',
      fix: 'Connect a source in Settings → Playback Sources, or drive the show manually.',
    };
  }
  return { id: 'sources', label: 'Playback sources', status: OK, detail: configured.join(', ') };
}

/**
 * The live input, when it is on: a capture library the service can import,
 * and the device it is set to among those it finds.
 */
async function checkLiveInput(): Promise<Check> {
  const config = settings.group('live');
  if (!config.enabled) {
    return { id: 'live', label: 'Live input', status: INFO, detail: 'Off. Turn it on in Settings → Live Input to follow the music by ear.' };
  }
  let devices: LiveDevices;
  try {
    devices = await listLiveDevices();
  } catch (err) {
    return {
      id: 'live', label: 'Live input', status: WARN, detail: messageOf(err),
      fix: 'Check the Python interpreter in Settings → Analysis, and install requirements.txt into it.',
    };
  }
  if (!devices.backend) {
    return {
      id: 'live', label: 'Live input', status: WARN,
      detail: 'No capture library: the live input cannot hear anything.',
      fix: 'Install it into the analysis Python: pip install soundcard',
    };
  }
  const listed = config.source === 'loopback' ? devices.outputs : devices.inputs;
  const wanted = config.device;
  if (wanted && !listed.some((name) => name.toLowerCase().includes(wanted.toLowerCase()))) {
    return {
      id: 'live', label: 'Live input', status: WARN,
      detail: `"${wanted}" is not among the ${config.source === 'loopback' ? 'outputs' : 'inputs'} (${listed.join(', ') || 'none'}).`,
      fix: 'Plug it in, or pick another in Settings → Live Input.',
    };
  }
  const which = wanted || (config.source === 'loopback' ? devices.defaultOutput : devices.defaultInput) || 'the default device';
  return {
    id: 'live', label: 'Live input', status: OK,
    detail: `${config.source === 'loopback' ? 'Hears what' : 'Listens to'} ${which}${config.source === 'loopback' ? ' plays' : ''} (${devices.backend}).`,
  };
}

function checkAccess(): Check {
  const host = settings.get('server.host');
  const hasToken = !!settings.get('server.token');
  const loopback = isLoopback(host);

  if (loopback) {
    return {
      id: 'access', label: 'Access', status: INFO,
      detail: `Bound to ${host} — reachable from this machine only.`,
    };
  }
  if (!hasToken) {
    // The startup guard already refuses this, so reaching it means a
    // hand-edited config that has not been restarted into yet.
    return {
      id: 'access', label: 'Access', status: FAIL,
      detail: `Bound to ${host} with no access token — anyone on the network could black out the rig.`,
      fix: 'Set one in Settings → Server & Access → Access Token.',
    };
  }
  return {
    id: 'access', label: 'Access', status: OK,
    detail: `Bound to ${host}, token required.`,
  };
}

function checkCues(): Check {
  const count = cues.summaries().length;
  return {
    id: 'cues', label: 'Cues', status: INFO,
    detail: count ? `${count} saved look${count === 1 ? '' : 's'}.` : 'No cues saved.',
  };
}

// Model weights run to gigabytes. The check never downloads in the
// foreground: asked to fetch what is missing, it starts one background job in
// the model manager (Settings → Analysis models shows its progress) and
// reports on it; a second run while it goes, or after it has succeeded, does
// not start another.
/** What the show would download unprompted: the models it needs and the ones the settings ask for. */
function modelsWanted(rows: ModelRow[]): string[] {
  const wanted = new Set(rows.filter((m) => m.tier === 'required' || m.tier === 'recommended').map((m) => m.id));
  if (settings.get('analysis.separator') === 'bs-roformer') wanted.add('bs_roformer');
  if (settings.get('analysis.structureModel') === 'songformer') wanted.add('songformer');
  return rows.filter((m) => wanted.has(m.id)).map((m) => m.id);
}

async function checkAnalysisModels({ download = false, manager = modelManager }:
  { download?: boolean; manager?: ModelManager } = {}): Promise<Check> {
  const id = 'models';
  const label = 'Analysis models';
  let listing;
  try {
    listing = await manager.list({ refresh: true });
  } catch (err) {
    return { id, label, status: WARN, detail: messageOf(err),
      fix: 'Check the Python check above; the model list comes from scripts/download-models.py.' };
  }
  const rows = listing.models;
  const wanted = modelsWanted(rows);
  const missing = rows.filter((m) => wanted.includes(m.id) && !m.present);
  const names = (list: ModelRow[]) => list.map((m) => m.name).join(', ');

  let job = manager.job();
  if (missing.length && download && (!job || job.ok !== null)
    && !(job && job.ok === true && missing.every((m) => job?.ids.includes(m.id)))) {
    job = manager.download(missing.map((m) => m.id));
  }
  if (job && job.ok === null) {
    const minutes = Math.floor((Date.now() - job.startedAt) / 60000);
    const bytes = Object.values(job.models).reduce((sum, m) => sum + m.bytes, 0);
    const total = Object.values(job.models).reduce((sum, m) => sum + (m.total ?? 0), 0);
    const progress = total ? ` — ${Math.round(bytes / 1e6)} of ${Math.round(total / 1e6)} MB` : '';
    return { id, label, status: WARN,
      detail: `Downloading ${job.ids.join(', ')} in the background (started ${minutes ? `${minutes} min ago` : 'just now'})${progress}. `
        + 'The show keeps running meanwhile.',
      fix: 'Settings → Analysis models shows its progress.' };
  }
  if (missing.length) {
    const required = missing.filter((m) => m.tier === 'required');
    const failed = job && job.ok === false ? ` The last download failed: ${job.error || 'see the log'}.` : '';
    return { id, label, status: WARN,
      detail: (required.length
        ? `${names(required)} ${required.length === 1 ? 'is' : 'are'} not downloaded: the first track will fetch ${required.length === 1 ? 'it' : 'them'}.`
        : `${names(missing)} ${missing.length === 1 ? 'is' : 'are'} not downloaded; the analysis falls back without ${missing.length === 1 ? 'it' : 'them'}.`)
        + failed,
      fix: 'Download them under Settings → Analysis models, or run python scripts/download-models.py.' };
  }
  const extras = rows.filter((m) => m.present && !wanted.includes(m.id));
  return { id, label, status: OK,
    detail: `${names(rows.filter((m) => wanted.includes(m.id)))} ready`
      + (extras.length ? `; also ${names(extras)}.` : '.') };
}

/**
 * Run every check.
 *
 * The subsystems come in as arguments rather than being reached for, so this is
 * callable both from the server (which has live ones) and from the CLI (which
 * has none, and reports the checks that do not need them).
 */
async function runPreflight({ midi, spotify, prolink, analysisCache, downloadModels = false, standalone = false }:
  PreflightSubjects = {}): Promise<PreflightReport> {
  // The external-tool probes are independent and each costs a process spawn;
  // run them together rather than serially in front of an operator waiting on
  // the report.
  const [artnet, hue, wled, openrgb, ffmpeg, ytDlp, live, stack, models] = await Promise.all([
    checkArtnet(),
    checkHue(),
    checkWled(),
    checkOpenRgb(),
    checkFfmpeg(),
    checkYtDlp(),
    checkLiveInput(),
    checkModelStack(),
    checkAnalysisModels({ download: downloadModels }),
  ]);

  const checks: Check[] = [
    checkEngine(engineStatus(), { standalone }),
    checkOutputsArmed(isArmed(), { standalone }),
    artnet,
    checkSacn(),
    ...hue,
    wled,
    openrgb,
    checkPatch(),
    checkAccess(),
    checkMidi(midi),
    checkPython(),
    stack,
    ffmpeg,
    ytDlp,
    checkPanns(),
    checkCache(analysisCache),
    checkPlaybackSources({ spotify, prolink }),
    live,
    checkCues(),
    models,
  ];

  const counts: Record<CheckStatus, number> = { ok: 0, warn: 0, fail: 0, info: 0 };
  for (const check of checks) counts[check.status]++;

  return { ok: counts.fail === 0, counts, checks, at: new Date().toISOString() };
}

export const STATUSES = { OK, WARN, FAIL, INFO };

export {
  runPreflight,
  probeCommand,
  PANNS_DIR,
  PANNS_CHECKPOINT,
  PANNS_LABELS,
  PANNS_CHECKPOINT_SIZE,
  checkPatch,
  checkEngine,
  checkOutputsArmed,
  checkSacn,
  checkHue,
  checkWled,
  checkOpenRgb,
  checkPanns,
  checkAnalysisModels,
  checkModelStack,
  checkAccess,
  checkMidi,
};
