'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const { state, universeOf, activeUniverses } = require('./state');
const { getProfile, fitsInUniverse, endChannel, UNIVERSE_SIZE } = require('./profiles');
const { MAX_UNIVERSES } = require('./universes');
const { settings } = require('./settings');
const { discoverNodes, probeSend } = require('./artnet');
const output = require('./output');
const { MIN_UNIVERSE, MAX_UNIVERSE } = require('./sacn');
const { cues } = require('./cues');
const { midiMap } = require('./midi-map');
const pythonEnv = require('../python-env');

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

const OK = 'ok';
const WARN = 'warn';
const FAIL = 'fail';
const INFO = 'info';

/** Run a command and capture its first line of output. */
function probeCommand(command, args, timeoutMs = 5000) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { windowsHide: true });
    } catch (err) {
      resolve({ ok: false, error: err.message });
      return;
    }

    let out = '';
    let settled = false;
    const finish = (result) => {
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
      error: err.code === 'ENOENT' ? 'not found on PATH' : err.message,
    }));
    child.on('close', (code) => finish({
      ok: code === 0,
      version: String(out).trim().split(/\r?\n/)[0] || '',
      error: code === 0 ? null : `exited ${code}`,
    }));
  });
}

// ── Individual checks ───────────────────────────────────────────────────────

async function checkArtnet() {
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

  const { nodes, error } = await discoverNodes({ host: target.host, port: target.port });
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
      + nodes.map((n) => `${n.shortName || n.longName || 'unnamed'} at ${n.from} (universe ${n.universe})`).join(', '),
    nodes,
  };
}

function checkSacn() {
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

  const where = config.host ? `unicast to ${config.host}` : 'multicast';
  return {
    id: 'sacn', label: 'sACN output', status: OK,
    detail: `${where}, priority ${config.priority}, as "${config.sourceName}". `
      + `Universes ${mapped.map(([from, to]) => `${from}→${to}`).join(', ')}.`,
  };
}

function checkPatch() {
  const problems = [];

  for (const fix of state.fixtures) {
    const profile = getProfile(fix);
    if (!fitsInUniverse(fix.address, profile.channelCount)) {
      problems.push(`"${fix.label}" at ${fix.address} ends at ${endChannel(fix.address, profile.channelCount)}, `
        + `past the ${UNIVERSE_SIZE}-channel universe`);
    }
  }

  // Two fixtures only fight over an address when they share a universe.
  for (let i = 0; i < state.fixtures.length; i++) {
    const a = state.fixtures[i];
    const aEnd = endChannel(a.address, getProfile(a).channelCount);
    for (let j = i + 1; j < state.fixtures.length; j++) {
      const b = state.fixtures[j];
      if (universeOf(a) !== universeOf(b)) continue;
      const bEnd = endChannel(b.address, getProfile(b).channelCount);
      if (a.address <= bEnd && b.address <= aEnd) {
        problems.push(`"${a.label}" and "${b.label}" overlap on universe ${universeOf(a)}`);
      }
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

function checkPython() {
  const info = pythonEnv.resolve();
  if (!info.ok) {
    return {
      id: 'python', label: 'Python', status: FAIL,
      detail: `"${info.exe}" cannot be run — audio analysis will fail.`,
      fix: 'Install Python 3, or set its full path in Settings → Analysis → Python.',
    };
  }
  if (info.missing.length) {
    const where = info.executable || info.exe;
    return {
      id: 'python', label: 'Python', status: FAIL,
      detail: `${where} (${info.version}) is missing: ${info.missing.join(', ')}.`,
      fix: `"${where}" -m pip install -r requirements.txt`,
    };
  }
  return {
    id: 'python', label: 'Python', status: OK,
    detail: `${info.executable || info.exe} (${info.version}) — all analyzer dependencies present.`,
  };
}

async function checkFfmpeg() {
  const r = await probeCommand('ffmpeg', ['-version']);
  if (!r.ok) {
    return {
      id: 'ffmpeg', label: 'ffmpeg', status: FAIL,
      detail: `Not usable — ${r.error}. Downloaded audio cannot be decoded, so no track will analyse.`,
      fix: 'Install ffmpeg with your package manager and make sure it is on PATH.',
    };
  }
  return { id: 'ffmpeg', label: 'ffmpeg', status: OK, detail: r.version };
}

async function checkYtDlp() {
  const r = await probeCommand('yt-dlp', ['--version']);
  if (!r.ok) {
    const hasDeezer = !!settings.get('deezer.arl');
    return {
      id: 'yt-dlp', label: 'yt-dlp', status: hasDeezer ? WARN : FAIL,
      detail: `Not usable — ${r.error}. `
        + (hasDeezer
          ? 'Deezer is configured, so ISRC-matched tracks still download; anything Deezer cannot match will fail.'
          : 'Nothing can be downloaded for analysis.'),
      fix: 'pip install yt-dlp  (or download it from https://github.com/yt-dlp/yt-dlp)',
    };
  }
  return { id: 'yt-dlp', label: 'yt-dlp', status: OK, detail: `version ${r.version}` };
}

// Kept in step with scripts/setup-panns.py, which downloads these.
const PANNS_DIR = path.join(os.homedir(), 'panns_data');
const PANNS_CHECKPOINT = path.join(PANNS_DIR, 'Cnn14_mAP=0.431.pth');
const PANNS_LABELS = path.join(PANNS_DIR, 'class_labels_indices.csv');
const PANNS_CHECKPOINT_SIZE = 327428481;

function checkPanns() {
  const sizeOf = (file) => {
    try { return fs.statSync(file).size; } catch (_) { return null; }
  };

  const checkpoint = sizeOf(PANNS_CHECKPOINT);
  const labels = sizeOf(PANNS_LABELS);

  if (checkpoint === null || labels === null) {
    return {
      id: 'panns', label: 'PANNs tagger', status: WARN,
      detail: 'Not downloaded. Genre comes from MuQ-MuLan either way — see Analysis models — so '
        + 'this only costs the instrument-role priors and the genre fallback behind MuQ-MuLan.',
      fix: 'python scripts/setup-panns.py   (~310 MB, one time). It is also fetched automatically '
        + 'on the first track you analyse — which is a poor moment to discover a slow connection.',
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

function checkCache(analysisCache) {
  const dir = analysisCache && analysisCache.dir;
  if (!dir) return { id: 'cache', label: 'Analysis cache', status: INFO, detail: 'Not configured.' };

  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
  } catch (err) {
    return {
      id: 'cache', label: 'Analysis cache', status: FAIL,
      detail: `${dir} is not writable — ${err.message}. Every track would be re-analysed from scratch.`,
      fix: 'Fix the permissions on that folder.',
    };
  }

  const entries = analysisCache.list().length;
  return {
    id: 'cache', label: 'Analysis cache', status: OK,
    detail: `${entries} cached ${entries === 1 ? 'analysis' : 'analyses'} in ${dir}.`,
  };
}

function checkMidi(midi) {
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

function checkPlaybackSources({ spotify, prolink } = {}) {
  const configured = [];
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

function checkAccess() {
  const host = settings.get('server.host');
  const hasToken = !!settings.get('server.token');
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(String(host).toLowerCase());

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

function checkCues() {
  const count = cues.summaries().length;
  return {
    id: 'cues', label: 'Cues', status: INFO,
    detail: count ? `${count} saved look${count === 1 ? '' : 's'}.` : 'No cues saved.',
  };
}

function checkAnalysisModels({ download = false } = {}) {
  const root = process.env.ARTNET_MODEL_DIR
    || path.join(os.homedir(), '.cache', 'artnet-lightshow', 'models');
  const bs = path.join(root, 'BS-Roformer-SW.ckpt');
  const bsReady = path.join(root, 'BS-Roformer-SW.ready');
  const muq = path.join(root, 'muq');
  const mulan = path.join(root, 'muq_mulan');
  const text = process.env.ARTNET_MUQ_TEXT_MODEL || path.join(root, 'xlm-roberta-base');
  const skey = path.join(root, 'skey');
  const beat = path.join(root, 'beat_this.ready');
  const bsEnabled = !['0', 'false', 'no'].includes(String(process.env.ARTNET_USE_BS_ROFORMER || '0').toLowerCase());
  const ready = (!bsEnabled || (fs.existsSync(bs) && fs.existsSync(bsReady))) && fs.existsSync(muq) && fs.existsSync(mulan)
    && fs.existsSync(text) && fs.existsSync(skey) && fs.existsSync(beat);
  if (!ready && download) {
    const py = process.env.ARTNET_PYTHON || pythonEnv.resolve().executable || 'python';
    const script = path.join(__dirname, '..', '..', 'scripts', 'download-models.py');
    const result = spawnSync(py, [script], { encoding: 'utf8', env: process.env });
    if (result.status !== 0) {
      return { id: 'models', label: 'Analysis models', status: WARN,
        detail: `Model download failed: ${(result.stderr || '').trim() || 'Python unavailable'}.`,
        fix: 'Install huggingface_hub and run npm run preflight.' };
    }
  }
  const after = (!bsEnabled || (fs.existsSync(bs) && fs.existsSync(bsReady))) && fs.existsSync(muq) && fs.existsSync(mulan)
    && fs.existsSync(text) && fs.existsSync(skey) && fs.existsSync(beat);
  return { id: 'models', label: 'Analysis models', status: after ? OK : WARN,
    detail: after
      ? (bsEnabled
        ? 'BS-RoFormer, Beat This!, S-KEY, MuQ and MuQ-MuLan weights are ready.'
        : 'Beat This!, S-KEY, MuQ and MuQ-MuLan are ready; Demucs is active for stems.')
      : 'Pretrained weights are not available; deterministic analysis fallback remains active.',
    fix: after ? null : 'Run the preflight again after installing huggingface_hub.' };
}

/**
 * Run every check.
 *
 * The subsystems come in as arguments rather than being reached for, so this is
 * callable both from the server (which has live ones) and from the CLI (which
 * has none, and reports the checks that do not need them).
 */
async function runPreflight({ midi, spotify, prolink, analysisCache, downloadModels = false } = {}) {
  // The external-tool probes are independent and each costs a process spawn;
  // run them together rather than serially in front of an operator waiting on
  // the report.
  const [artnet, ffmpeg, ytDlp] = await Promise.all([
    checkArtnet(),
    checkFfmpeg(),
    checkYtDlp(),
  ]);

  const checks = [
    artnet,
    checkSacn(),
    checkPatch(),
    checkAccess(),
    checkMidi(midi),
    checkPython(),
    ffmpeg,
    ytDlp,
    checkPanns(),
    checkCache(analysisCache),
    checkPlaybackSources({ spotify, prolink }),
    checkCues(),
    checkAnalysisModels({ download: downloadModels }),
  ];

  const counts = { ok: 0, warn: 0, fail: 0, info: 0 };
  for (const check of checks) counts[check.status]++;

  return { ok: counts.fail === 0, counts, checks, at: new Date().toISOString() };
}

module.exports = {
  runPreflight,
  probeCommand,
  PANNS_DIR,
  PANNS_CHECKPOINT,
  PANNS_LABELS,
  PANNS_CHECKPOINT_SIZE,
  // Exported for tests, which drive them against a doctored state rather than
  // standing up a server.
  checkPatch,
  checkSacn,
  checkPanns,
  checkAnalysisModels,
  checkAccess,
  checkMidi,
  STATUSES: { OK, WARN, FAIL, INFO },
};
