import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { state, universeOf, activeUniverses } from './state.ts';
import { getProfile } from './profiles.ts';
import { fitIssue, footprintOf, overlaps } from '../shared/placement.ts';
import { MAX_UNIVERSES } from './universes.ts';
import { settings } from './settings.ts';
import { discoverNodes, probeSend } from './artnet.ts';
import { interfaces } from './artnet-nodes.ts';
import * as output from './output.ts';
import { engineStatus } from './engine.ts';
import { MIN_UNIVERSE, MAX_UNIVERSE } from './sacn.ts';
import { listEntertainmentConfigs } from './hue.ts';
import { wledClient } from './wled.ts';
import { unitCount } from '../shared/rig.ts';
import type { WledClient } from './wled.ts';
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

function checkSacn(): Check {
  const config = output.getSacnConfig();
  if (!config.enabled) {
    return {
      id: 'sacn', label: 'sACN output', status: INFO,
      detail: 'Disabled. Turn it on in Settings → sACN (E1.31) if your console speaks it.',
    };
  }

  const mapped = activeUniverses().map((u) => [u, output.sacnUniverseFor(u)]);
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
    const host = (fix.output as { host: string }).host;
    const patched = unitCount(getProfile(fix));
    try {
      const info = await client.info(host);
      return { fix, host, patched, leds: info.leds, error: null };
    } catch (err) {
      return { fix, host, patched, leds: 0, error: err instanceof Error ? err.message : String(err) };
    }
  }));
  const silent = answers.filter((a) => a.error);
  const resized = answers.filter((a) => !a.error && a.leds !== a.patched);
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
      detail: resized.map((a) => `"${a.fix.label}" reports ${a.leds} LEDs but is patched as ${a.patched}`).join('; '),
      fix: 'Remove it from the patch and add it again under Settings → Output → WLED.',
    };
  }
  return {
    id: 'wled', label: 'WLED', status: OK,
    detail: answers.map((a) => `"${a.fix.label}" at ${a.host}, ${a.leds} LEDs`).join('; ') + ', sent over DDP.',
  };
}

/**
 * Philips Hue: is the bridge there, does the area still exist, and is every
 * channel bound to a fixture that is still in the patch?
 *
 * The last question is the one worth asking before doors. A Hue binding names a
 * fixture id, and deleting that fixture from the patch leaves the binding
 * pointing at nothing — the lamp simply stops being sent, which on the night
 * looks like a dead lamp rather than a configuration mistake.
 */
async function checkHue(): Promise<Check> {
  const config = output.getHueConfig();
  if (!config.enabled) {
    return {
      id: 'hue', label: 'Philips Hue', status: INFO,
      detail: 'Disabled. Turn it on in Settings → Philips Hue to drive Hue lamps from the show.',
    };
  }

  const missing = [];
  if (!config.host) missing.push('bridge address');
  if (!config.username || !config.clientKey) missing.push('pairing');
  if (!config.entertainmentId) missing.push('entertainment area');
  if (missing.length) {
    return {
      id: 'hue', label: 'Philips Hue', status: FAIL,
      detail: `Output is on but the ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not set up.`,
      fix: 'Open Settings → Philips Hue, find the bridge, press its link button to pair, then pick an area.',
    };
  }

  if (!config.channels.length) {
    return {
      id: 'hue', label: 'Philips Hue', status: WARN,
      detail: `Paired with ${config.host}, but no Hue channel is bound to a fixture, so nothing will light.`,
      fix: 'Bind each channel to a fixture in Settings → Philips Hue.',
    };
  }

  const known = new Set(state.fixtures.map((f) => f.id));
  const orphans = config.channels.filter((c) => !known.has(c.fixture));
  if (orphans.length) {
    return {
      id: 'hue', label: 'Philips Hue', status: FAIL,
      detail: `Channel ${orphans.map((c) => c.channel).join(', ')} `
        + `${orphans.length === 1 ? 'is' : 'are'} bound to a fixture that is no longer in the patch, `
        + `so ${orphans.length === 1 ? 'that lamp' : 'those lamps'} will never be sent a colour.`,
      fix: 'Re-bind them in Settings → Philips Hue, or put the missing fixtures back.',
    };
  }

  let areas;
  try {
    areas = await listEntertainmentConfigs(config.host, config.username);
  } catch (err) {
    return {
      id: 'hue', label: 'Philips Hue', status: FAIL,
      detail: `Cannot reach the bridge at ${config.host} — ${messageOf(err)}`,
      fix: 'Check the bridge is powered and on this network, and that its IP has not changed.',
    };
  }

  const area = areas.find((a) => a.id === config.entertainmentId);
  if (!area) {
    return {
      id: 'hue', label: 'Philips Hue', status: FAIL,
      detail: `The bridge at ${config.host} has no entertainment area ${config.entertainmentId} any more.`,
      fix: 'It was probably renamed or rebuilt in the Hue app. Pick the area again in Settings → Philips Hue.',
    };
  }

  // A channel the area does not define is accepted by the bridge and quietly
  // ignored, so it would never surface as an error at show time.
  const areaChannels = new Set(area.channels.map((c) => c.id));
  const lampNames = new Map(area.channels.filter((c) => c.name).map((c) => [c.id, c.name]));
  const unknown = config.channels.filter((c) => !areaChannels.has(c.channel)).map((c) => c.channel);
  if (unknown.length) {
    return {
      id: 'hue', label: 'Philips Hue', status: WARN,
      detail: `"${area.name}" has no channel ${unknown.join(', ')}, so those bindings go nowhere. `
        + `The area defines ${areaChannels.size} channel${areaChannels.size === 1 ? '' : 's'}.`,
      fix: 'The area was probably changed in the Hue app. Re-bind the channels in Settings → Philips Hue.',
    };
  }

  const live = output.getHueStatus();
  if (live.status === 'failed') {
    return {
      id: 'hue', label: 'Philips Hue', status: WARN,
      detail: `"${area.name}" on ${config.host} is set up correctly, but the last stream attempt failed — ${live.error}.`,
      fix: 'A bridge only allows one entertainment stream at a time. Close the Hue app\'s sync or any other tool streaming to it.',
    };
  }

  // Name the lamps rather than the channel numbers: "Right follows PAR 1" is
  // checkable against the room, "#0 → 0" is not.
  const bound = config.channels
    .map((c) => {
      const fixture = state.fixtures.find((f) => f.id === c.fixture);
      return `${lampNames.get(c.channel) || `#${c.channel}`} → ${fixture ? fixture.label : `fixture ${c.fixture}`}`;
    })
    .join(', ');

  return {
    id: 'hue', label: 'Philips Hue', status: OK,
    detail: `"${area.name}" on ${config.host}, `
      + `${config.channels.length} of ${areaChannels.size} channel${areaChannels.size === 1 ? '' : 's'} bound: ${bound}.`,
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

  const universes = activeUniverses();
  if (universes.length > MAX_UNIVERSES) {
    problems.push(`the patch spans ${universes.length} universes, more than the ${MAX_UNIVERSES} transmitted`);
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
    detail: `${state.fixtures.length} fixture${state.fixtures.length === 1 ? '' : 's'} `
      + `on universe${universes.length === 1 ? '' : 's'} ${universes.join(', ')}, no overlaps.`,
  };
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
  if (settings.get('sources.smtc') && process.platform === 'win32') configured.push('Now playing (SMTC)');
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
  const [artnet, hue, wled, ffmpeg, ytDlp, live, stack, models] = await Promise.all([
    checkArtnet(),
    checkHue(),
    checkWled(),
    checkFfmpeg(),
    checkYtDlp(),
    checkLiveInput(),
    checkModelStack(),
    checkAnalysisModels({ download: downloadModels }),
  ]);

  const checks: Check[] = [
    checkEngine(engineStatus(), { standalone }),
    artnet,
    checkSacn(),
    hue,
    wled,
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
  checkSacn,
  checkHue,
  checkWled,
  checkPanns,
  checkAnalysisModels,
  checkModelStack,
  checkAccess,
  checkMidi,
};
