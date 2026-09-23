import crypto from 'node:crypto';
import path from 'node:path';
import fsp from 'node:fs/promises';
import os from 'node:os';
import multer from 'multer';

import { state, getClientState, getFixture, allocateFixtureId, universeOf, maxBrightnessOf, countUniverses } from './state.ts';
import { applyPatch, applyOverride, setFixtureMaxBrightness, processTap } from './patch.ts';
import { PALETTES } from './palettes.ts';
import { resizeFixtureBuffers, startSyncTest, engineStatus } from './engine.ts';
import { parseGDTF } from '../gdtf.ts';
import { BUILTIN_PROFILE_ID, isBuiltinProfile, MAX_FIXTURES, UNIVERSE_SIZE, endChannel, fitsInUniverse, universeOverflow, registerProfile, unregisterProfile, listProfiles, getProfile, unitCapOverflow } from './profiles.ts';
import { MAX_UNIVERSES } from './universes.ts';
import { footprintOf, universeCount } from '../shared/placement.ts';
import { ddpConflict } from './ddp-routes.ts';
import { cues, cueWriteSchema, cueRestoreSchema, reorderSchema } from './cues.ts';
import { showStore, snapshotShow, applyShow } from './show-store.ts';
import { barProfile } from './bar-profile.ts';
import { parseOfl } from './ofl.ts';
import { createOflLibrary } from './ofl-library.ts';
import { wledClient, wledProfile } from './wled.ts';
import { midiMap, ACTIONS, defaultTypeFor, mapSchema, learnSchema, bindingWriteSchema } from './midi-map.ts';
import { profileSchema, deezerStateSchema, fixtureRestoreSchema, dmxUniverse, huePairSchema, wledAddSchema, validate } from './validation.ts';
import * as output from './output.ts';
import { discoverNodes } from './artnet.ts';
import { interfaces } from './artnet-nodes.ts';
import { discoverBridges, pair as pairBridge, listEntertainmentConfigs } from './hue.ts';
import { settings, RESTART_PATHS, CONFIG_FILE } from './settings.ts';
import { connectMidi } from './midi-connect.ts';
import { generateToken } from './auth.ts';
import { runPreflight } from './preflight.ts';
import { warmRequestSchema, warmPlaylistSchema, parseSetList, fromSpotifyTracks, MAX_TRACKS as MAX_WARM_TRACKS } from './warm.ts';
import * as pythonEnv from '../python-env.ts';
import {
  keyForSpotify, keyForYouTube, keyForQuery, keyForLocalFile, keyForBuffer,
} from '../analysis-cache.ts';
import { HttpError, messageOf, statusOf } from '../errors.ts';
import type { Express, NextFunction, Request, RequestHandler, Response } from 'express';
import type AutoShow from '../auto-show.ts';
import type { AnalysisCache } from '../analysis-cache.ts';
import type DeezerSource from '../deezer-source.ts';
import type MidiController from '../midi.ts';
import type NowPlayingSource from '../nowplaying-source.ts';
import type ProLink from '../prolink.ts';
import { listLiveDevices } from '../live-input.ts';
import type SpotifyClient from '../spotify.ts';
import type { createApplier } from './apply.ts';
import type { setupIntegrations } from './integrations.ts';
import type { ArtNode } from './artnet.ts';
import type { EntertainmentArea } from './hue.ts';
import type { OflLibrary } from './ofl-library.ts';
import type { WledClient } from './wled.ts';
import type { NowPlaying, PlaybackSource } from '../types/playback.ts';
import type { Fixture, Profile } from '../types/rig.ts';

/** The live subsystems the routes drive. */
export interface RouteDeps {
  midi: MidiController;
  autoShow: AutoShow;
  spotify: SpotifyClient;
  nowPlaying: NowPlayingSource;
  deezerSource: DeezerSource;
  prolink: ProLink;
  analysisCache: AnalysisCache;
  integrations: ReturnType<typeof setupIntegrations>;
  applier: ReturnType<typeof createApplier>;
  /** The Open Fixture Library online; the real one unless a test stands in. */
  oflLibrary?: OflLibrary;
  /** Finding and asking WLEDs; the real network unless a test stands in. */
  wled?: WledClient;
}

/** What the operator typed into "Analyse", classified (see classifyAnalyzeSource). */
export type AnalyzeSource =
  | { kind: 'url'; source: string; direct: boolean }
  | { kind: 'local'; source: string }
  | { kind: 'search'; source: string };

// Audio uploads genuinely need headroom; GDTF files do not. Separate limits so
// the fixture importer isn't handed a 50 MB budget it has no use for — a real
// GDTF is a few hundred KB.
// One file and a handful of fields per request: both are held in memory.
const uploadAudio = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024, files: 1, fields: 8 } });
const uploadGdtf = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: 1, fields: 8 } });
// An OFL fixture is plain JSON, tens of KB even for a pixel bar.
const uploadOfl = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024, files: 1, fields: 8 } });

// Local-file analysis reads a path off the filesystem. When a library folder is
// set in the settings page it is confined to that subtree; blank keeps the old
// behaviour of any absolute path. Read per request so a change applies without
// a restart.
//
// Both sides are resolved with realpath, so a symlink inside the folder cannot
// point the analyser somewhere outside it.
async function resolveLocalPath(source: string): Promise<string> {
  let resolved: string;
  try {
    resolved = await fsp.realpath(source);
  } catch (_) {
    throw new HttpError(404, `No such file: ${source}`);
  }
  const configured = settings.get('analysis.localRoot');
  if (!configured) return resolved;
  let root: string;
  try { root = await fsp.realpath(configured); } catch (_) { root = path.resolve(configured); }
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  if (resolved !== root && !resolved.startsWith(prefix)) {
    throw new HttpError(403, `Local file analysis is restricted to ${root}`);
  }
  return resolved;
}

const AUDIO_EXTENSIONS = ['.mp3', '.wav', '.ogg', '.flac', '.m4a', '.aac', '.wma', '.opus', '.webm', '.aiff', '.aif'];
const DIRECT_AUDIO_RE = /\.(mp3|wav|ogg|flac|m4a|aac|wma|opus|webm|aiff?)(\?|$)/i;

/**
 * What an operator typed into "Analyse", classified before anything touches it.
 *
 *   url     an http(s) link — a direct audio file or a page yt-dlp understands
 *   local   an absolute path on this machine
 *   search  anything else, handed to yt-dlp as a search
 *
 * Refused outright: UNC and device paths (\\server\share, //server/share,
 * \\?\C:), which on Windows make the machine authenticate to whatever server
 * the path names; any other URL scheme (file:, ftp:, smb:); and a relative
 * path to an audio file, whose meaning depends on the server's working folder.
 */
function classifyAnalyzeSource(source: unknown): AnalyzeSource {
  const text = String(source).trim();
  const refuse = (message: string): never => {
    throw new HttpError(400, message);
  };
  if (/^[\\/]{2}/.test(text)) refuse('Network (UNC) paths are not accepted — copy the file to this machine first');
  if (/^https?:\/\//i.test(text)) return { kind: 'url', source: text, direct: DIRECT_AUDIO_RE.test(text) };
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) refuse('Only http(s) links, absolute file paths or a search can be analysed');
  if (/^[a-zA-Z]:[\\/]/.test(text) || text.startsWith('/')) return { kind: 'local', source: text };
  if (DIRECT_AUDIO_RE.test(text) && /[\\/]/.test(text)) refuse('Give the full path to the file, not a relative one');
  return { kind: 'search', source: text };
}

/** Remember the chosen MIDI ports so the pick survives a restart. */
function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => unknown): RequestHandler {
  return (req, res, next) => { Promise.resolve(fn(req, res, next)).catch(next); };
}

function attachRoutes(app: Express, deps: RouteDeps): void {
  const { midi, autoShow, spotify, nowPlaying, deezerSource, prolink, analysisCache, integrations, applier } = deps;
  const oflLibrary = deps.oflLibrary || createOflLibrary();
  const wled = deps.wled || wledClient;

  // ─── State ────────────────────────────────────────────────────────────────
  app.get('/api/state', (_req, res) => res.json(getClientState()));

  app.post('/api/set', (req, res) => {
    try {
      applyPatch(req.body);
      res.json({ ok: true, state: getClientState() });
    } catch (err) {
      res.status(statusOf(err) || 400).json({ ok: false, error: messageOf(err) });
    }
  });

  // ─── Quick controls ───────────────────────────────────────────────────────
  app.post('/api/tap', (_req, res) => {
    processTap();
    res.json({ ok: true, bpm: state.bpm });
  });

  app.post('/api/blackout/toggle', (_req, res) => {
    applyPatch({ masterBlackout: !state.masterBlackout });
    res.json({ ok: true, masterBlackout: state.masterBlackout });
  });

  app.post('/api/blackout/:onoff', (req, res) => {
    applyPatch({ masterBlackout: req.params.onoff !== 'off' });
    res.json({ ok: true, masterBlackout: state.masterBlackout });
  });

  app.post('/api/pattern/:id', (req, res) => {
    try {
      applyPatch({ pattern: req.params.id });
      res.json({ ok: true, pattern: state.pattern });
    } catch (err) { res.status(400).json({ ok: false, error: messageOf(err) }); }
  });

  app.post('/api/color/:slot/:index', (req, res) => {
    const slotMap: Record<string, string> = { a: 'colorA', b: 'colorB', c: 'colorC', d: 'colorD' };
    const slot = slotMap[req.params.slot] || 'colorA';
    try {
      applyPatch({ [slot]: parseInt(req.params.index, 10) });
      res.json({ ok: true, colorA: state.colorA, colorB: state.colorB, colorC: state.colorC, colorD: state.colorD });
    } catch (err) { res.status(400).json({ ok: false, error: messageOf(err) }); }
  });

  // The named looks manual mode picks from, and the one on stage.
  app.get('/api/palettes', (_req, res) => {
    res.json({ ok: true, palettes: PALETTES, palette: state.palette });
  });

  // Writes all four colour slots from one look. `size` picks the bank (2, 3 or
  // 4 colours); a smaller palette wraps to fill every slot.
  app.post('/api/palette/:id', (req, res) => {
    try {
      const raw = (req.body && req.body.size) ?? req.query.size;
      const size = raw === undefined ? 4 : parseInt(raw, 10);
      applyPatch({ palette: req.params.id, paletteSize: size });
      res.json({
        ok: true,
        palette: state.palette,
        colorA: state.colorA, colorB: state.colorB, colorC: state.colorC, colorD: state.colorD,
      });
    } catch (err) { res.status(statusOf(err) || 400).json({ ok: false, error: messageOf(err) }); }
  });

  app.post('/api/bpm/:value', (req, res) => {
    try {
      applyPatch({ bpm: Number(req.params.value) });
      res.json({ ok: true, bpm: state.bpm });
    } catch (err) { res.status(400).json({ ok: false, error: messageOf(err) }); }
  });

  app.post('/api/bpm/adjust/:delta', (req, res) => {
    try {
      applyPatch({ bpm: Math.round((state.bpm + Number(req.params.delta)) * 100) / 100 });
      res.json({ ok: true, bpm: state.bpm });
    } catch (err) { res.status(400).json({ ok: false, error: messageOf(err) }); }
  });

  app.post('/api/play', (_req, res) => { applyPatch({ running: true });  res.json({ ok: true }); });
  app.post('/api/stop', (_req, res) => { applyPatch({ running: false }); res.json({ ok: true }); });

  app.post('/api/master/:value', (req, res) => {
    try {
      applyPatch({ masterDimmer: parseInt(req.params.value, 10) });
      res.json({ ok: true, masterDimmer: state.masterDimmer });
    } catch (err) { res.status(400).json({ ok: false, error: messageOf(err) }); }
  });

  // Note: /api/energy/off must come before :id
  app.post('/api/energy/off', (_req, res) => {
    applyPatch({ energyOverride: null });
    res.json({ ok: true, energyOverride: null });
  });

  app.post('/api/energy/:id', (req, res) => {
    try {
      applyPatch({ energyOverride: req.params.id });
      res.json({ ok: true, energyOverride: state.energyOverride });
    } catch (err) { res.status(400).json({ ok: false, error: messageOf(err) }); }
  });

  // ─── Per-fixture overrides ────────────────────────────────────────────────
  app.post('/api/fixture/:id/override', (req, res) => {
    try {
      applyOverride(parseInt(req.params.id, 10), req.body);
      res.json({ ok: true });
    } catch (err) { res.status(400).json({ ok: false, error: messageOf(err) }); }
  });

  app.post('/api/fixture/:id/blackout/toggle', (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const fixture = getFixture(id);
      if (!fixture) return res.status(404).json({ ok: false, error: 'No such fixture' });
      const cur = fixture.override;
      const blackout = !(cur && cur.blackout);
      if (!blackout && cur && cur.blackout && !cur.enabled) {
        applyOverride(id, null);
        return res.json({ ok: true });
      }
      applyOverride(id, {
        ...(cur || { enabled: false, r: 0, g: 0, b: 0, w: 0, a: 0, uv: 0, dim: 255, strobe: 0 }),
        blackout,
      });
      res.json({ ok: true });
    } catch (err) { res.status(400).json({ ok: false, error: messageOf(err) }); }
  });

  // A trim rather than an override: it scales whatever is driving the fixture —
  // the pattern engine, an override, or an energy override — and survives
  // clearing the override.
  app.post('/api/fixture/:id/max/:value', (req, res) => {
    const id = parseInt(req.params.id, 10);
    const value = parseInt(req.params.value, 10);
    if (!Number.isInteger(value) || value < 0 || value > 255) {
      return res.status(400).json({ ok: false, error: 'maxBrightness must be an integer from 0 to 255' });
    }
    const fixture = getFixture(id);
    if (!fixture) {
      return res.status(404).json({ ok: false, error: 'No such fixture' });
    }
    setFixtureMaxBrightness(id, value);
    res.json({ ok: true, id, maxBrightness: maxBrightnessOf(fixture) });
  });

  app.post('/api/fixture/:id/clear', (req, res) => {
    applyOverride(parseInt(req.params.id, 10), null);
    res.json({ ok: true });
  });

  // ─── MIDI ─────────────────────────────────────────────────────────────────
  app.get('/api/midi/ports', (_req, res) => res.json(midi.listPorts()));

  app.post('/api/midi/connect', (req, res) => {
    try {
      res.json(connectMidi(midi, req.body));
    } catch (err) { res.status(400).json({ ok: false, error: messageOf(err) }); }
  });

  // ─── MIDI mapping and learn ───────────────────────────────────────────────
  // The map used to be a constant describing one controller. It is now stored,
  // editable, and relearnable by pressing the control you want.
  app.get('/api/midi/map', (_req, res) => {
    res.json({
      ok: true,
      ...midiMap.snapshot(),
      // The catalogue the settings page renders its picker from, so the list of
      // bindable actions lives in one place rather than two.
      actions: ACTIONS,
      learning: midi.learning,
    });
  });

  app.put('/api/midi/map', (req, res) => {
    try {
      midiMap.replace(validate(mapSchema, req.body || {}, 'midi-map'));
      res.json({ ok: true, ...midiMap.snapshot() });
    } catch (err) { res.status(statusOf(err) || 400).json({ ok: false, error: messageOf(err) }); }
  });

  app.post('/api/midi/map/reset', (_req, res) => {
    midiMap.reset();
    res.json({ ok: true, ...midiMap.snapshot() });
  });

  /** Bind or clear one message by hand, for when the controller isn't to hand. */
  app.put('/api/midi/map/binding', (req, res) => {
    try {
      const { kind, number, binding } = validate(bindingWriteSchema, req.body || {}, 'midi-binding');
      midiMap.setBinding(kind, number, binding);
      res.json({ ok: true, ...midiMap.snapshot() });
    } catch (err) { res.status(statusOf(err) || 400).json({ ok: false, error: messageOf(err) }); }
  });

  /**
   * Arm learn and answer when a control is pressed.
   *
   * The request is held open until the controller sends something, learn is
   * cancelled, or it times out — so the page gets its answer without polling,
   * and a client that navigates away disarms nothing it did not arm.
   */
  app.post('/api/midi/learn', asyncHandler(async (req, res) => {
    if (!midi.enabled) {
      return res.status(400).json({ ok: false, error: 'No MIDI input connected — pick a port first' });
    }
    let binding;
    try {
      binding = validate(learnSchema, req.body || {}, 'midi-learn');
    } catch (err) {
      return res.status(400).json({ ok: false, error: messageOf(err) });
    }

    // A CC binding needs to know whether the control is an encoder or a fader.
    // The action says which by default; an explicit type in the request wins,
    // for the controller whose faders send relative or whose encoders don't.
    const captured = await midi.startLearn(binding);
    if (!captured) {
      return res.json({ ok: false, error: 'Learn cancelled or timed out', learned: null });
    }

    const stored = { ...captured.binding };
    if (captured.kind === 'cc' && !stored.type) stored.type = defaultTypeFor(stored.action);
    if (captured.kind === 'notes') delete stored.type;

    try {
      midiMap.setBinding(captured.kind, captured.number, stored);
    } catch (err) {
      return res.status(statusOf(err) || 500).json({ ok: false, error: messageOf(err) });
    }

    res.json({
      ok: true,
      learned: { kind: captured.kind, number: captured.number, channel: captured.channel, binding: stored },
      ...midiMap.snapshot(),
    });
  }));

  app.post('/api/midi/learn/cancel', (_req, res) => {
    res.json({ ok: true, cancelled: midi.cancelLearn('cancelled') });
  });

  // ─── PRO DJ LINK ──────────────────────────────────────────────────────────
  app.post('/api/prolink/enable',  (_req, res) => { applyPatch({ prolinkEnabled: true });  res.json({ ok: true, prolink: (getClientState() as Record<string, unknown>).prolink }); });
  app.post('/api/prolink/disable', (_req, res) => { applyPatch({ prolinkEnabled: false }); res.json({ ok: true, prolink: (getClientState() as Record<string, unknown>).prolink }); });
  app.post('/api/prolink/toggle',  (_req, res) => { applyPatch({ prolinkEnabled: !state.prolinkEnabled }); res.json({ ok: true, prolink: (getClientState() as Record<string, unknown>).prolink }); });

  // ─── GDTF / Profiles / Fixtures / Show ────────────────────────────────────
  app.post('/api/gdtf/parse', uploadGdtf.single('gdtf'), asyncHandler(async (req, res) => {
    if (!req.file) return res.status(400).json({ ok: false, error: 'No file uploaded' });
    try {
      const result = await parseGDTF(req.file.buffer);
      res.json({ ok: true, fixture: result });
    } catch (err) {
      console.error('GDTF parse error:', messageOf(err));
      res.status(400).json({ ok: false, error: messageOf(err) });
    }
  }));

  // ─── Open Fixture Library ─────────────────────────────────────────────────
  // A downloaded OFL fixture file (no internet needed), or a fixture searched
  // for and fetched from the library online. Both answer as /api/gdtf/parse
  // does, so the page offers their modes the same way.
  app.post('/api/ofl/parse', uploadOfl.single('ofl'), (req, res) => {
    if (!req.file) return res.status(400).json({ ok: false, error: 'No file uploaded' });
    let json: unknown;
    try {
      json = JSON.parse(req.file.buffer.toString('utf8'));
    } catch (_) {
      return res.status(400).json({ ok: false, error: 'That file is not JSON: an Open Fixture Library fixture is a .json file' });
    }
    try {
      const manufacturer = typeof req.body?.manufacturer === 'string' ? req.body.manufacturer.trim() : null;
      res.json({ ok: true, fixture: parseOfl(json, { manufacturer }) });
    } catch (err) {
      res.status(statusOf(err) || 400).json({ ok: false, error: messageOf(err) });
    }
  });

  app.get('/api/ofl/search', asyncHandler(async (req, res) => {
    try {
      const results = await oflLibrary.search(typeof req.query.q === 'string' ? req.query.q : '');
      res.json({ ok: true, results });
    } catch (err) {
      res.status(statusOf(err) || 502).json({ ok: false, error: messageOf(err) });
    }
  }));

  app.get('/api/ofl/fixture/:manufacturer/:fixture', asyncHandler(async (req, res) => {
    try {
      const fixture = await oflLibrary.fixture(String(req.params.manufacturer), String(req.params.fixture));
      res.json({ ok: true, fixture });
    } catch (err) {
      res.status(statusOf(err) || 502).json({ ok: false, error: messageOf(err) });
    }
  }));

  // ─── WLED ─────────────────────────────────────────────────────────────────
  // Find the WLEDs on the network, and add one: its profile from what it says
  // it is, patched on universes of its own and sent DDP (ddp-routes.ts).
  app.get('/api/wled/discover', asyncHandler(async (_req, res) => {
    try {
      const found = await wled.discover();
      const devices = await Promise.all(found.map(async (device) => {
        const patched = state.fixtures.find((f) => f.output?.protocol === 'ddp' && f.output.host === device.host);
        const base = { ...device, patched: patched ? patched.label : null };
        try {
          const info = await wled.info(device.host);
          return { ...base, name: info.name, leds: info.leds, rgbw: info.rgbw, matrix: info.matrix, version: info.version };
        } catch (err) {
          return { ...base, error: messageOf(err) };
        }
      }));
      res.json({ ok: true, devices });
    } catch (err) {
      res.status(statusOf(err) || 500).json({ ok: false, error: messageOf(err) });
    }
  }));

  app.post('/api/wled/add', asyncHandler(async (req, res) => {
    try {
      const { host, label } = validate(wledAddSchema, req.body || {}, 'wled');
      if (state.fixtures.length >= MAX_FIXTURES) {
        return res.status(400).json({ ok: false, error: `Patch is full (${MAX_FIXTURES} fixtures)` });
      }
      const sameHost = state.fixtures.find((f) => f.output?.protocol === 'ddp' && f.output.host.toLowerCase() === host.toLowerCase());
      if (sameHost) return res.status(409).json({ ok: false, error: `${host} is patched already, as "${sameHost.label}"` });

      const info = await wled.info(host);
      const profile = wledProfile(info, host);
      // The profile is named for the WLED's own address (its MAC), so the same
      // device found at a new IP is the fixture that is already there.
      const sameDevice = state.fixtures.find((f) => f.profileId === profile.id);
      if (sameDevice) {
        return res.status(409).json({ ok: false, error: `${info.name} is patched already, as "${sameDevice.label}"; change its address in the patch table` });
      }
      const universe = freeUniverses(universeCount(profile));
      if (universe === null) return res.status(400).json({ ok: false, error: 'No free universes left for it' });
      const fixture: Fixture = {
        id: -1, label: (label || info.name).slice(0, 64), address: 1, universe, profileId: profile.id, maxBrightness: 255,
        override: null, position: null, group: null, geometry: null, output: { protocol: 'ddp', host },
      };
      const next = [...state.fixtures, fixture];
      const profileOf = (f: Pick<Fixture, 'profileId'>) => (f.profileId === profile.id ? profile : getProfile(f));
      const tooMany = unitCapOverflow(next, profileOf);
      if (tooMany) return res.status(400).json({ ok: false, error: tooMany });
      if (countUniverses(next, profileOf) > MAX_UNIVERSES) {
        return res.status(400).json({ ok: false, error: `${info.name} would put the patch on more than the ${MAX_UNIVERSES} universes this server transmits` });
      }
      if (!registerProfile(profile)) return res.status(400).json({ ok: false, error: 'Invalid profile' });
      fixture.id = allocateFixtureId();
      state.fixtures.push(fixture);
      resizeFixtureBuffers();
      showStore.scheduleSave();
      integrations.broadcast();
      res.json({ ok: true, fixture, profile, info });
    } catch (err) {
      res.status(statusOf(err) || 400).json({ ok: false, error: messageOf(err) });
    }
  }));

  /**
   * The first run of `count` universes nothing is patched on, from 1: the
   * rig's default universe stays clear, since new fixtures land on it.
   */
  function freeUniverses(count: number): number | null {
    const used = new Set<number>([state.artnet.universe]);
    for (const f of state.fixtures) for (const part of footprintOf(universeOf(f), f.address, getProfile(f))) used.add(part.universe);
    for (let u = 1; u + count - 1 <= 32767; u++) {
      let free = true;
      for (let k = 0; k < count && free; k++) free = !used.has(u + k);
      if (free) return u;
    }
    return null;
  }

  app.post('/api/profiles', (req, res) => {
    try {
      const profile = validate(profileSchema, req.body, 'profile');
      // Re-importing a profile that is already patched changes every fixture
      // on it at once — a GDTF that now counts its fine channels is a channel
      // longer — so those fixtures are held to the same rules as patching them.
      const blocked = profileChangeBlocked(profile);
      if (blocked) return res.status(400).json({ ok: false, error: blocked });
      if (!registerProfile(profile)) return res.status(400).json({ ok: false, error: 'Invalid profile' });
      showStore.scheduleSave();
      integrations.broadcast();
      res.json({ ok: true });
    } catch (err) { res.status(400).json({ ok: false, error: messageOf(err) }); }
  });

  // A bar profile from its cell count and channel order (bar-profile.js).
  // `?dryRun=1` answers with the profile without adding it, for the preview.
  app.post('/api/profiles/bar', (req, res) => {
    try {
      const profile = barProfile(req.body || {});
      if (req.query.dryRun === '1') return res.json({ ok: true, profile });
      if (isBuiltinProfile(profile.id)) return res.status(400).json({ ok: false, error: 'That id is a built-in profile' });
      const blocked = profileChangeBlocked(profile);
      if (blocked) return res.status(400).json({ ok: false, error: blocked });
      if (!registerProfile(profile)) return res.status(400).json({ ok: false, error: 'Invalid profile' });
      showStore.scheduleSave();
      integrations.broadcast();
      res.json({ ok: true, profile });
    } catch (err) { res.status(statusOf(err) || 400).json({ ok: false, error: messageOf(err) }); }
  });

  /** Why replacing a profile with `profile` would break the patch, or null. */
  function profileChangeBlocked(profile: Profile): string | null {
    const users = state.fixtures.filter((f) => f.profileId === profile.id);
    for (const fixture of users) {
      const overflow = universeOverflow(fixture.label, fixture.address, profile, universeOf(fixture));
      if (overflow) return overflow;
    }
    if (!users.length) return null;
    const profiles = listProfiles();
    const profileOf = (f: Pick<Fixture, 'profileId'>) => (f.profileId === profile.id ? profile : profiles[f.profileId] || profiles[BUILTIN_PROFILE_ID]);
    // A WLED's profile growing reaches onto more universes, which must be free.
    return unitCapOverflow(state.fixtures, profileOf) || ddpConflict(state.fixtures, profileOf, universeOf);
  }

  app.delete('/api/profiles/:id', (req, res) => {
    const id = req.params.id;
    if (isBuiltinProfile(id)) return res.status(400).json({ ok: false, error: 'Cannot remove built-in profile' });
    const inUse = state.fixtures.some((f) => f.profileId === id);
    if (inUse) return res.status(400).json({ ok: false, error: 'Profile is in use by patched fixtures' });
    unregisterProfile(id);
    showStore.scheduleSave();
    integrations.broadcast();
    res.json({ ok: true });
  });

  app.post('/api/fixtures', (req, res) => {
    if (state.fixtures.length >= MAX_FIXTURES) {
      return res.status(400).json({ ok: false, error: `Patch is full (${MAX_FIXTURES} fixtures)` });
    }
    // New fixtures land on the rig's default universe unless the caller names
    // another one, and auto-address behind whatever is already on *that*
    // universe — addressing behind the whole patch would leave a hole at the
    // front of every universe but the first.
    let universe = state.artnet.universe;
    if (req.body && req.body.universe !== undefined) {
      const parsed = dmxUniverse.safeParse(req.body.universe);
      if (!parsed.success) {
        return res.status(400).json({ ok: false, error: 'universe must be an integer from 0 to 32767' });
      }
      universe = parsed.data;
    }

    // Behind everything on that universe, a strip running on into it included.
    let maxEnd = 0;
    const profiles = listProfiles();
    for (const fix of state.fixtures) {
      const profile = profiles[fix.profileId] || profiles[BUILTIN_PROFILE_ID];
      for (const part of footprintOf(universeOf(fix), fix.address, profile)) {
        if (part.universe === universe && part.last + 1 > maxEnd) maxEnd = part.last + 1;
      }
    }
    const chCount = profiles[BUILTIN_PROFILE_ID].channelCount;
    // Auto-address after the last patched fixture. Clamping to a fixed 501 used
    // to hand out an address the new fixture does not actually fit at, so the
    // tail of a full universe silently produced dead channels.
    const address = Math.max(1, maxEnd);
    if (!fitsInUniverse(address, chCount)) {
      return res.status(400).json({
        ok: false,
        error: `No room left in universe ${universe}: a ${chCount}-channel fixture at ${address} `
          + `would end at ${endChannel(address, chCount)}, past the ${UNIVERSE_SIZE}-channel universe`,
      });
    }
    const next = [...state.fixtures, { universe, profileId: BUILTIN_PROFILE_ID }];
    const tooMany = unitCapOverflow(next);
    if (tooMany) return res.status(400).json({ ok: false, error: tooMany });
    const wled = ddpConflict([...state.fixtures, { id: -1, label: `Fixture ${state.fixtures.length + 1}`, address, universe, profileId: BUILTIN_PROFILE_ID }],
      getProfile, universeOf);
    if (wled) return res.status(400).json({ ok: false, error: wled });
    if (countUniverses(next) > MAX_UNIVERSES) {
      return res.status(400).json({
        ok: false,
        error: `Universe ${universe} would put the patch on more than the ${MAX_UNIVERSES} `
          + 'universes this server transmits',
      });
    }
    const newId = allocateFixtureId();
    state.fixtures.push({
      id: newId,
      label: `Fixture ${newId + 1}`,
      address,
      universe,
      profileId: BUILTIN_PROFILE_ID,
      maxBrightness: 255,
      override: null,
    });
    resizeFixtureBuffers();
    showStore.scheduleSave();
    integrations.broadcast();
    res.json({ ok: true });
  });

  // Answers with the fixture that was removed and its position, so the client
  // can offer an undo. The id is stable because external bindings refer to it.
  app.delete('/api/fixtures/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (state.fixtures.length <= 1) return res.status(400).json({ ok: false, error: 'Must have at least one fixture' });
    const index = state.fixtures.findIndex((f) => f.id === id);
    if (index < 0) return res.status(404).json({ ok: false, error: 'No such fixture' });

    const [removed] = state.fixtures.splice(index, 1);
    resizeFixtureBuffers();
    showStore.scheduleSave();
    integrations.broadcast();
    res.json({
      ok: true,
      index,
      fixture: {
        id: removed.id,
        label: removed.label,
        address: removed.address,
        universe: universeOf(removed),
        profileId: removed.profileId,
        maxBrightness: maxBrightnessOf(removed),
        position: removed.position || null,
        group: removed.group || null,
        geometry: removed.geometry || null,
        output: removed.output || null,
        override: removed.override,
      },
    });
  });

  /**
   * Put a deleted fixture back at its old index.
   *
   * Held to exactly the same rules as adding one — the patch may have changed
   * in the seconds the undo was on screen, and an undo that reintroduces an
   * overlap or overflows a universe is worse than no undo at all.
   */
  app.post('/api/fixtures/restore', (req, res) => {
    try {
      const { index, fixture } = validate(fixtureRestoreSchema, req.body || {}, 'fixture-restore');
      if (state.fixtures.length >= MAX_FIXTURES) {
        return res.status(400).json({ ok: false, error: `Patch is full (${MAX_FIXTURES} fixtures)` });
      }

      const profiles = listProfiles();
      const profileId = profiles[fixture.profileId] ? fixture.profileId : BUILTIN_PROFILE_ID;
      const overflow = universeOverflow(fixture.label, fixture.address, profiles[profileId], fixture.universe ?? state.artnet.universe);
      if (overflow) return res.status(400).json({ ok: false, error: overflow });

      const restored = {
        id: fixture.id,
        label: fixture.label,
        address: fixture.address,
        universe: fixture.universe !== undefined ? fixture.universe : state.artnet.universe,
        profileId,
        maxBrightness: fixture.maxBrightness !== undefined ? fixture.maxBrightness : 255,
        position: fixture.position || null,
        group: fixture.group || null,
        geometry: fixture.geometry || null,
        output: fixture.output || null,
        override: fixture.override || null,
      };

      if (state.fixtures.some((existing) => existing.id === restored.id)) {
        return res.status(409).json({ ok: false, error: 'That fixture id is already in use' });
      }

      const tooMany = unitCapOverflow([...state.fixtures, restored]);
      if (tooMany) return res.status(400).json({ ok: false, error: tooMany });
      const wled = ddpConflict([...state.fixtures, restored as Fixture], getProfile, universeOf);
      if (wled) return res.status(400).json({ ok: false, error: wled });

      if (countUniverses([...state.fixtures, restored]) > MAX_UNIVERSES) {
        return res.status(400).json({
          ok: false,
          error: `Universe ${restored.universe} would put the patch on more than the ${MAX_UNIVERSES} `
            + 'universes this server transmits',
        });
      }

      const at = Math.max(0, Math.min(state.fixtures.length, index));
      if (restored.id === undefined) restored.id = allocateFixtureId();
      state.nextFixtureId = Math.max(state.nextFixtureId, restored.id + 1);
      state.fixtures.splice(at, 0, restored as typeof restored & { id: number });
      resizeFixtureBuffers();
      showStore.scheduleSave();
      integrations.broadcast();
      res.json({ ok: true, id: restored.id });
    } catch (err) { res.status(statusOf(err) || 400).json({ ok: false, error: messageOf(err) }); }
  });

  // The show file: the patch as a portable document. The server saves it for
  // the operator on every change (see show-store.js), so this is for moving a
  // rig between machines or keeping a copy, not for not losing your work.
  app.get('/api/show', (_req, res) => res.json(snapshotShow()));

  app.post('/api/show', (req, res) => {
    try {
      applyShow(req.body);
      // The uploaded show is the rig now, so it is also what a restart restores.
      showStore.scheduleSave();
      integrations.broadcast();
      res.json({ ok: true });
    } catch (err) { res.status(statusOf(err) || 400).json({ ok: false, error: messageOf(err) }); }
  });

  // ─── Cue stack ────────────────────────────────────────────────────────────
  // Named looks. GET returns the full stored look; the state broadcast carries
  // only the summaries the buttons need.
  app.get('/api/cues', (_req, res) => res.json({ ok: true, cues: cues.list() }));

  app.post('/api/cues', (req, res) => {
    try {
      const body = validate(cueWriteSchema, req.body || {}, 'cue');
      const cue = cues.create(body);
      integrations.broadcast();
      res.json({ ok: true, cue });
    } catch (err) { res.status(statusOf(err) || 400).json({ ok: false, error: messageOf(err) }); }
  });

  // Note: /api/cues/reorder must come before :id
  app.post('/api/cues/reorder', (req, res) => {
    try {
      const { ids } = validate(reorderSchema, req.body || {}, 'cue-reorder');
      cues.reorder(ids);
      integrations.broadcast();
      res.json({ ok: true, cues: cues.summaries() });
    } catch (err) { res.status(statusOf(err) || 400).json({ ok: false, error: messageOf(err) }); }
  });

  app.put('/api/cues/:id', (req, res) => {
    try {
      const body = validate(cueWriteSchema, req.body || {}, 'cue');
      const cue = cues.update(req.params.id, body);
      if (!cue) return res.status(404).json({ ok: false, error: 'No such cue' });
      integrations.broadcast();
      res.json({ ok: true, cue });
    } catch (err) { res.status(statusOf(err) || 400).json({ ok: false, error: messageOf(err) }); }
  });

  // Answers with what was removed and from where, so the client can offer an
  // undo that puts the same cue back in the same slot rather than appending a
  // copy with a new id.
  app.delete('/api/cues/:id', (req, res) => {
    try {
      const removed = cues.remove(req.params.id);
      if (!removed) return res.status(404).json({ ok: false, error: 'No such cue' });
      integrations.broadcast();
      res.json({ ok: true, cue: removed.cue, index: removed.index });
    } catch (err) { res.status(statusOf(err) || 500).json({ ok: false, error: messageOf(err) }); }
  });

  app.post('/api/cues/restore', (req, res) => {
    try {
      const { cue, index } = validate(cueRestoreSchema, req.body || {}, 'cue-restore');
      const restored = cues.insert(cue, index);
      if (!restored) return res.status(409).json({ ok: false, error: 'That cue is already in the stack' });
      integrations.broadcast();
      res.json({ ok: true, cue: restored });
    } catch (err) { res.status(statusOf(err) || 400).json({ ok: false, error: messageOf(err) }); }
  });

  app.post('/api/cues/:id/recall', (req, res) => {
    try {
      if (!cues.recall(req.params.id)) return res.status(404).json({ ok: false, error: 'No such cue' });
      // recallLook goes through applyPatch, which broadcasts on its own.
      res.json({ ok: true, state: getClientState() });
    } catch (err) { res.status(statusOf(err) || 400).json({ ok: false, error: messageOf(err) }); }
  });

  // ─── Spotify ──────────────────────────────────────────────────────────────
  app.get('/auth/spotify', (_req, res) => {
    if (!spotify.configured) {
      // Not env vars: settings.js deliberately never reads process.env, so
      // pointing the operator at one would send them somewhere that cannot work.
      return res.status(400).json({
        ok: false,
        error: 'Add a Spotify client ID and secret in the settings page first',
      });
    }
    res.redirect(spotify.getAuthorizeUrl());
  });

  app.get('/auth/spotify/callback', asyncHandler(async (req, res) => {
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    if (!code) return res.status(400).type('text/plain').send('Missing authorization code');

    // Bind this callback to a flow this server started. Without it, any page
    // could navigate the operator's browser here with an attacker's code and
    // silently bind the show to the attacker's account.
    if (!spotify.consumeState(req.query.state)) {
      if (settings.get('spotify.allowUnverifiedState')) {
        console.warn(
          '[spotify] callback state missing or unrecognised — accepted because '
          + '"accept unverified state" is enabled. This disables OAuth CSRF protection.'
        );
      } else {
        console.warn('[spotify] rejected callback: missing or unrecognised state parameter');
        return res.status(400).type('text/plain').send(
          'Spotify auth failed: missing or unrecognised state parameter. '
          + 'Start the flow from /auth/spotify in this browser.'
          + (spotify.usingProxy
            ? ' If your OAuth proxy does not forward the state parameter, either clear '
              + 'the proxy (Spotify accepts a 127.0.0.1 redirect directly, and the state '
              + 'then round-trips intact) or enable "accept unverified state" in the '
              + 'settings page — the latter disables OAuth CSRF protection.'
            : '')
        );
      }
    }

    try {
      await spotify.exchangeCode(code);
      spotify.startPolling();
      console.log('Spotify authenticated successfully');
      integrations.broadcast();
      res.send('<html><body style="background:#0d0d0f;color:#e8e8f0;font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh"><div style="text-align:center"><h2 style="color:#44ff88">Spotify Connected</h2><p>You can close this window and return to the lightshow.</p><script>setTimeout(()=>window.close(),2000)</script></div></body></html>');
    } catch (err) {
      console.error('Spotify auth error:', messageOf(err));
      // Plain text: the message can carry whatever Spotify or a proxy sent
      // back, and as HTML on this origin it would run in the operator's browser.
      res.status(500).type('text/plain').send(`Spotify auth failed: ${messageOf(err)}`);
    }
  }));

  app.post('/api/spotify/disconnect', (_req, res) => {
    // The operator asked to disconnect, so drop the saved session too —
    // otherwise the next restart would silently sign back in.
    spotify.disconnect({ forget: true });
    integrations.clearSpotifyNext();
    integrations.broadcast();
    res.json({ ok: true });
  });

  /**
   * The connected account's playlists, so warming can offer a picker instead of
   * demanding a pasted link. Private ones need the playlist scope — a
   * connection older than it gets the public subset, and `canReadPlaylists`
   * on the Spotify status tells the UI to offer a reconnect.
   */
  app.get('/api/spotify/playlists', asyncHandler(async (_req, res) => {
    if (!spotify.authenticated) return res.status(400).json({ ok: false, error: 'Spotify not connected' });
    try {
      const playlists = await spotify.getMyPlaylists();
      res.json({ ok: true, playlists, canReadPlaylists: spotify.canReadPlaylists });
    } catch (err) {
      res.status(statusOf(err) === 401 ? 400 : 502).json({ ok: false, error: messageOf(err) });
    }
  }));

  app.get('/api/spotify/now-playing', asyncHandler(async (_req, res) => {
    try {
      const playing = await spotify.getCurrentlyPlaying();
      res.json({ ok: true, playing });
    } catch (err) {
      res.status(500).json({ ok: false, error: messageOf(err) });
    }
  }));

  // ─── Now playing (OS media session) ─────────────────────────────────────────
  app.post('/api/nowplaying/disconnect', (_req, res) => {
    nowPlaying.disconnect();
    integrations.broadcast();
    res.json({ ok: true });
  });

  // ─── Deezer (browser extension) ─────────────────────────────────────────────
  // No CORS headers here on purpose. The extension POSTs from its background
  // script (see browser-extension/background.js), which holds a host permission
  // and is therefore not subject to page CORS at all. A wildcard
  // Access-Control-Allow-Origin used to sit here and let any website on the
  // internet push fake now-playing state into the show.

  // The Firefox extension POSTs the Deezer web player's state here: the current
  // track (with ISRC + position) and the upcoming queue (for prefetch).
  app.post('/api/deezer/state', (req, res) => {
    try {
      integrations.onDeezerState(validate(deezerStateSchema, req.body || {}, 'deezer-state'));
      res.json({ ok: true, status: deezerSource.getStatus() });
    } catch (err) { res.status(400).json({ ok: false, error: messageOf(err) }); }
  });

  app.post('/api/deezer/disconnect', (_req, res) => {
    integrations.onDeezerDisconnect();
    res.json({ ok: true });
  });

  // ─── Auto-show ────────────────────────────────────────────────────────────

  app.post('/api/auto/analyze', asyncHandler(async (req, res) => {
    const { source } = req.body || {};
    if (!source) return res.status(400).json({ ok: false, error: 'Provide a source (file path, URL, or YouTube search)' });

    try {
      const input = classifyAnalyzeSource(source);
      if (input.kind === 'local') {
        const file = await resolveLocalPath(input.source);
        autoShow.track = { name: path.basename(file), artist: 'Local file', album: '', albumArt: null };
        await autoShow.analyze(file, keyForLocalFile(file));
      } else if (input.kind === 'url' && input.direct) {
        autoShow.track = { name: path.basename(new URL(input.source).pathname), artist: 'Link', album: '', albumArt: null };
        await autoShow.analyze(input.source, `url:${input.source}`);
      } else {
        autoShow.track = { name: input.source, artist: '', album: '', albumArt: null };
        integrations.broadcast();
        const cacheKey = keyForYouTube(input.source) || keyForQuery(input.source);
        await autoShow.downloadAndAnalyze(input.source, null, cacheKey);
      }
      integrations.broadcast();
      res.json({ ok: true, analysis: autoShow.getClientState().analysis });
    } catch (err) {
      res.status(statusOf(err) || 500).json({ ok: false, error: messageOf(err) });
    }
  }));

  /**
   * Analyse whatever a playback source says is playing now.
   *
   * One handler for the sources that report a track rather than hand over
   * audio. They differ only in how they are asked, what they are called when
   * they are not connected, and the cache key: Spotify has a stable track id,
   * the others only a name.
   */
  function analyzePlaying({ source, notConnected, nothingPlaying, keyFor = () => null, after }: {
    source: PlaybackSource;
    notConnected: string;
    nothingPlaying: string;
    keyFor?: (playing: NowPlaying) => string | null;
    after?: () => unknown;
  }): RequestHandler {
    return asyncHandler(async (_req, res) => {
      if (!source.authenticated) return res.status(400).json({ ok: false, error: notConnected });
      try {
        const playing = await source.getCurrentlyPlaying();
        if (!playing) return res.status(400).json({ ok: false, error: nothingPlaying });

        autoShow.track = {
          name: playing.name, artist: playing.artist, album: playing.album,
          albumArt: playing.albumArt, durationMs: playing.durationMs,
        };
        integrations.broadcast();

        const query = `${playing.artist} - ${playing.name}`;
        const cacheKey = keyFor(playing) || keyForQuery(query);
        await autoShow.downloadAndAnalyze(query, playing.durationMs / 1000, cacheKey, playing.isrc);

        integrations.broadcast();
        res.json({ ok: true, track: autoShow.track, analysis: autoShow.getClientState().analysis });
        if (after) after();
      } catch (err) {
        res.status(500).json({ ok: false, error: messageOf(err) });
      }
    });
  }

  app.post('/api/auto/analyze-spotify', analyzePlaying({
    source: spotify,
    notConnected: 'Spotify not connected',
    nothingPlaying: 'No track currently playing on Spotify',
    keyFor: (playing) => keyForSpotify(playing.trackId),
    after: () => integrations.prefetchNextFromQueue(),
  }));

  app.post('/api/auto/analyze-nowplaying', analyzePlaying({
    source: nowPlaying,
    notConnected: 'Nothing is currently playing',
    nothingPlaying: 'Nothing is currently playing',
  }));

  app.post('/api/auto/analyze-deezer', analyzePlaying({
    source: deezerSource,
    notConnected: 'Deezer extension not connected',
    nothingPlaying: 'No track currently playing on Deezer',
  }));

  app.post('/api/auto/download-analyze', asyncHandler(async (req, res) => {
    const { query } = req.body || {};
    if (!query) return res.status(400).json({ ok: false, error: 'Provide a query (YouTube URL or search terms)' });
    try {
      autoShow.track = { name: query, artist: '', album: '', albumArt: null };
      integrations.broadcast();
      const cacheKey = keyForYouTube(query) || keyForQuery(query);
      await autoShow.downloadAndAnalyze(query, null, cacheKey);
      integrations.broadcast();
      res.json({ ok: true, analysis: autoShow.getClientState().analysis });
    } catch (err) {
      res.status(500).json({ ok: false, error: messageOf(err) });
    }
  }));

  app.post('/api/auto/analyze-upload', uploadAudio.single('audio'), asyncHandler(async (req, res) => {
    if (!req.file) return res.status(400).json({ ok: false, error: 'No audio file uploaded' });
    // The extension is the only part of the client's file name that reaches the
    // disk, and only from a fixed list: a name the client chose, or an
    // executable extension, has no business sitting in the temp folder.
    const ext = path.extname(req.file.originalname || '').toLowerCase();
    if (!AUDIO_EXTENSIONS.includes(ext)) {
      return res.status(400).json({ ok: false, error: `Not an audio file (${AUDIO_EXTENSIONS.join(', ')})` });
    }
    const tmpPath = path.join(os.tmpdir(), `auto-analyze-${crypto.randomUUID()}${ext}`);
    try {
      // Async on purpose: this buffer can be 50 MB, and a synchronous write of
      // that size stalls the event loop — which here means the 44 Hz Art-Net
      // render loop stops sending frames and the rig visibly freezes mid-show.
      await fsp.writeFile(tmpPath, req.file.buffer);
      autoShow.track = { name: req.file.originalname, artist: 'Local file', album: '', albumArt: null };
      const cacheKey = keyForBuffer(req.file.buffer);
      await autoShow.analyze(tmpPath, cacheKey);
      integrations.broadcast();
      res.json({ ok: true, track: autoShow.track, analysis: autoShow.getClientState().analysis });
    } catch (err) {
      res.status(500).json({ ok: false, error: messageOf(err) });
    } finally {
      await fsp.unlink(tmpPath).catch(() => { /* already gone */ });
    }
  }));

  app.post('/api/auto/analyze-prolink', asyncHandler(async (_req, res) => {
    if (!prolink.connected) return res.status(400).json({ ok: false, error: 'PRO DJ LINK not connected' });
    const track = prolink.getTrack();
    if (!track) return res.status(400).json({ ok: false, error: 'No track on the deck the show follows' });

    try {
      autoShow.track = {
        name: track.title || `Track ${track.trackId}`, artist: track.artist || 'PRO DJ LINK', album: track.album || '',
        albumArt: null, durationMs: track.durationMs || 0,
      };
      integrations.broadcast();

      await integrations.analyseCdjTrack(track);

      integrations.broadcast();
      res.json({ ok: true, track: autoShow.track, analysis: autoShow.getClientState().analysis });
    } catch (err) {
      res.status(500).json({ ok: false, error: messageOf(err) });
    }
  }));

  app.post('/api/auto/start', (_req, res) => {
    if (!autoShow.analysis) return res.status(400).json({ ok: false, error: 'No analysis loaded. Analyze a track first.' });
    const source = integrations.startAutoShow();
    integrations.broadcast();
    res.json({ ok: true, source });
  });

  app.post('/api/auto/stop', (_req, res) => {
    autoShow.stop();
    integrations.broadcast();
    res.json({ ok: true });
  });

  app.post('/api/auto/reset', (_req, res) => {
    autoShow.reset();
    integrations.broadcast();
    res.json({ ok: true });
  });

  // The energy slider, on its own endpoint so a Stream Deck button or a script
  // can reach it without composing a state patch.
  app.post('/api/auto/intensity/:value', (req, res) => {
    try {
      applyPatch({ autoIntensity: parseInt(req.params.value, 10) });
      res.json({ ok: true, intensity: state.autoIntensity });
    } catch (err) { res.status(statusOf(err) || 400).json({ ok: false, error: messageOf(err) }); }
  });

  // Nudging this mid-set is normal — an operator hears the lights lagging and
  // corrects — so it gets its own endpoint alongside intensity rather than
  // living only in the settings page.
  app.post('/api/auto/sync-offset/:value', (req, res) => {
    try {
      applyPatch({ autoSyncOffsetMs: parseInt(req.params.value, 10) });
      res.json({ ok: true, syncOffsetMs: state.autoSyncOffsetMs });
    } catch (err) { res.status(statusOf(err) || 400).json({ ok: false, error: messageOf(err) }); }
  });

  app.post('/api/auto/palette-size/:value', (req, res) => {
    try {
      const raw = req.params.value;
      applyPatch({ autoPaletteSize: raw === 'auto' ? 'auto' : parseInt(raw, 10) });
      res.json({ ok: true, paletteSize: autoShow.paletteSize });
    } catch (err) { res.status(statusOf(err) || 400).json({ ok: false, error: messageOf(err) }); }
  });

  app.get('/api/auto/state', (_req, res) => {
    res.json({
      ok: true,
      ...autoShow.getClientState(),
      spotify: spotify.getStatus(),
      nowPlaying: nowPlaying.getStatus(),
      deezer: deezerSource.getStatus(),
    });
  });

  app.get('/api/auto/timeline', (_req, res) => {
    const data = autoShow.getTimelineData();
    if (!data) return res.status(404).json({ ok: false, error: 'No analysis loaded' });
    res.json({ ok: true, data });
  });

  app.get('/api/auto/cache', asyncHandler(async (_req, res) => {
    res.json({ ok: true, entries: await analysisCache.list() });
  }));

  app.delete('/api/auto/cache', (_req, res) => {
    const removed = analysisCache.clear();
    res.json({ ok: true, removed });
  });

  app.delete('/api/auto/cache/entry', (req, res) => {
    const { key } = req.body || {};
    if (!key) return res.status(400).json({ ok: false, error: 'Missing key' });
    const ok = analysisCache.delete(key);
    res.json({ ok });
  });

  // ─── Set-list warming ─────────────────────────────────────────────────────
  // Analyse a whole night up front. Live prefetch only sees one to five tracks
  // ahead, and only once something is playing.
  app.get('/api/warm', (_req, res) => res.json({ ok: true, warm: integrations.warmer.status() }));

  app.post('/api/warm', (req, res) => {
    try {
      const body = validate(warmRequestSchema, req.body || {}, 'warm');
      const inputs = [...(body.tracks || []), ...parseSetList(body.text)];
      if (!inputs.length) {
        return res.status(400).json({ ok: false, error: 'Provide a set list as `text` or `tracks`' });
      }
      res.json({ ok: true, warm: integrations.warmer.start(inputs) });
    } catch (err) { res.status(statusOf(err) || 400).json({ ok: false, error: messageOf(err) }); }
  });

  /** Warm everything Spotify has queued, rather than only the next few. */
  app.post('/api/warm/spotify-queue', asyncHandler(async (_req, res) => {
    if (!spotify.authenticated) return res.status(400).json({ ok: false, error: 'Spotify not connected' });
    const queue = await spotify.getQueue();
    if (!queue || !queue.length) return res.status(400).json({ ok: false, error: 'Spotify queue is empty' });

    try {
      res.json({ ok: true, warm: integrations.warmer.start(fromSpotifyTracks(queue)) });
    } catch (err) { res.status(statusOf(err) || 400).json({ ok: false, error: messageOf(err) }); }
  }));

  /**
   * Warm a Spotify playlist.
   *
   * The queue only exists once something is playing and rarely holds a whole
   * night; a playlist is the set list most people already have. Takes a share
   * link, a Spotify URI or a bare id.
   */
  app.post('/api/warm/spotify-playlist', asyncHandler(async (req, res) => {
    if (!spotify.authenticated) return res.status(400).json({ ok: false, error: 'Spotify not connected' });

    let body;
    try {
      body = validate(warmPlaylistSchema, req.body || {}, 'warm playlist');
    } catch (err) { return res.status(statusOf(err) || 400).json({ ok: false, error: messageOf(err) }); }

    let playlist;
    try {
      playlist = await spotify.getPlaylist(body.playlist, { limit: MAX_WARM_TRACKS });
    } catch (err) {
      // Spotify answers 404 for a playlist you cannot see, which is also what a
      // private playlist looks like without the scope. Say which it probably is
      // rather than leaving the operator to guess at a bare "not found".
      if (statusOf(err) === 404 && !spotify.canReadPlaylists) {
        return res.status(400).json({
          ok: false,
          error: 'Playlist not found. If it is private or collaborative, reconnect '
            + 'Spotify — this connection predates the playlist permission.',
        });
      }
      // A bad reference or a lapsed connection is the caller's to fix; a real
      // 404 is the playlist's; anything else is Spotify failing on our behalf.
      const status = statusOf(err) === 400 || statusOf(err) === 401 ? 400
        : statusOf(err) === 404 ? 404
          : 502;
      return res.status(status).json({ ok: false, error: messageOf(err) });
    }

    const inputs = fromSpotifyTracks(playlist.tracks);
    if (!inputs.length) {
      return res.status(400).json({
        ok: false,
        error: `"${playlist.name}" has no tracks to warm`,
      });
    }

    try {
      res.json({
        ok: true,
        playlist: {
          id: playlist.id, name: playlist.name, owner: playlist.owner,
          total: playlist.total, truncated: playlist.truncated,
        },
        warm: integrations.warmer.start(inputs),
      });
    } catch (err) { res.status(statusOf(err) || 400).json({ ok: false, error: messageOf(err) }); }
  }));

  app.delete('/api/warm', (_req, res) => {
    const cancelled = integrations.warmer.cancel();
    if (!cancelled) integrations.warmer.clear();
    res.json({ ok: true, cancelled, warm: integrations.warmer.status() });
  });

  // ─── Preflight ────────────────────────────────────────────────────────────
  // The same checks `npm run preflight` runs, with the live subsystems wired in
  // so MIDI and the playback sources report what is actually connected rather
  // than what is merely configured.
  //
  // POST, not GET: it probes the network, spawns tools and may download
  // models. A GET can be fired from any web page by an <img> tag with no
  // Origin header, which is exactly what the origin check cannot catch.
  app.post('/api/preflight', asyncHandler(async (_req, res) => {
    const report = await runPreflight({ midi, spotify, prolink, analysisCache, downloadModels: true });
    res.json({ ok: true, report });
  }));

  // ─── Settings ─────────────────────────────────────────────────────────────
  // Everything the operator can configure. Secrets are never sent back: the
  // client gets a per-secret "is one set?" flag and may replace or clear a
  // value, but cannot read it.
  // ─── Philips Hue ──────────────────────────────────────────────────────────
  // Pairing and area selection cannot be plain settings fields: the bridge
  // issues the credentials itself, and the list of areas only exists on the
  // bridge. These are the calls the settings page drives that with.

  app.get('/api/hue/status', (_req, res) => {
    const config = output.getHueConfig();
    res.json({
      ok: true,
      status: output.getHueStatus(),
      // Never the credentials — only whether we have them.
      paired: !!(config.username && config.clientKey),
      host: config.host,
      entertainmentId: config.entertainmentId,
      channels: config.channels,
    });
  });

  // Ten seconds of one white flash a second on every fixture, to film the pars
  // against the Hue lamps while setting hue.latencyMs.
  app.post('/api/hue/sync-test', (_req, res) => {
    res.json({ ok: true, seconds: startSyncTest(10) });
  });

  /**
   * The Art-Net nodes on the network. While the rig broadcasts, the server
   * keeps this list itself and sends each node its universes directly; `scan`
   * asks the network now — a fresh poll when the list is being kept, a one-off
   * on every interface when it is not (a rig sending to one node already).
   */
  app.get('/api/artnet/nodes', asyncHandler(async (req, res) => {
    const discovery = output.artnetDiscovery;
    const scan = req.query.scan === '1' || req.query.scan === 'true';
    if (scan && discovery.active) {
      discovery.pollNow();
      await new Promise((r) => setTimeout(r, 1200));
    }
    const status = discovery.status();
    let nodes: (ArtNode & { from: string; seenAt?: number })[] = status.nodes;
    let error = status.error;
    if (scan && !discovery.active) {
      const hosts = interfaces().map((i) => i.broadcast);
      if (hosts.length) {
        const found = await discoverNodes({ hosts, port: 6454, timeoutMs: 1200 });
        nodes = found.nodes;
        error = found.error;
      }
    }
    res.json({
      ok: true,
      // Whether the server is keeping the list and routing by it, or not.
      routing: status.active,
      error,
      nodes: nodes.map((n) => ({
        address: n.from || n.address,
        shortName: n.shortName,
        longName: n.longName,
        outputs: n.outputs,
        mac: n.mac,
        seenAgoMs: n.seenAt ? Math.max(0, Date.now() - n.seenAt) : 0,
      })),
    });
  }));

  // This machine's IPv4 addresses, for choosing which network sACN multicast
  // leaves on.
  app.get('/api/network/interfaces', (_req, res) => {
    res.json({ ok: true, interfaces: interfaces().map(({ name, address, netmask }) => ({ name, address, netmask })) });
  });

  // The audio devices the live input can hear: outputs for loopback, inputs
  // for a line-in. Asks the Python service, so it also says whether one of its
  // capture libraries is installed.
  app.get('/api/live/devices', asyncHandler(async (_req, res) => {
    try {
      res.json({ ok: true, ...(await listLiveDevices()) });
    } catch (err) {
      res.json({ ok: false, error: messageOf(err) });
    }
  }));

  app.get('/api/hue/discover', asyncHandler(async (_req, res) => {
    const { bridges, error } = await discoverBridges();
    // Not an error status: discovery needs internet access the show network may
    // well not have, and typing the IP in is a perfectly normal path.
    res.json({ ok: true, bridges, error });
  }));

  /**
   * Pair with a bridge and store what it issues.
   *
   * The link button has to have been pressed in the last 30 seconds, so the
   * "press it and try again" answer is an ordinary outcome rather than a
   * failure — the page reports it and lets the operator retry.
   */
  app.post('/api/hue/pair', asyncHandler(async (req, res) => {
    const { host } = validate(huePairSchema, req.body || {}, 'hue pair');
    const result = await pairBridge(host, { label: os.hostname() });
    if (!result.ok) {
      return res.status(result.pressLink ? 409 : 502)
        .json({ ok: false, error: result.error, pressLink: !!result.pressLink });
    }

    const changed = settings.update({
      hue: {
        host,
        username: result.username,
        clientKey: result.clientKey,
        applicationId: result.applicationId || '',
      },
    });
    applier.applyChanged(changed);

    // Hand back the areas straight away: pairing is only ever done in order to
    // pick one, and a second round trip here just adds a step to the setup.
    let areas: EntertainmentArea[] = [];
    let areasError: string | null = null;
    try {
      areas = await listEntertainmentConfigs(host, result.username);
    } catch (err) {
      areasError = messageOf(err);
    }
    res.json({ ok: true, host, areas, areasError });
  }));

  /** The entertainment areas on the paired bridge, with their channel ids. */
  app.get('/api/hue/areas', asyncHandler(async (_req, res) => {
    const config = output.getHueConfig();
    if (!config.host || !config.username) {
      return res.status(409).json({ ok: false, error: 'Pair with a bridge first.' });
    }
    try {
      const areas = await listEntertainmentConfigs(config.host, config.username);
      res.json({ ok: true, areas });
    } catch (err) {
      res.status(502).json({ ok: false, error: messageOf(err) });
    }
  }));

  /**
   * Forget the bridge.
   *
   * Clears the credentials and turns the output off, because leaving it enabled
   * with nothing to connect to would have the render loop retrying a bridge the
   * operator has just said they are done with. The application key stays
   * registered on the bridge itself — Hue offers no way to revoke it from here,
   * so that is done in the Hue app under linked devices.
   */
  app.post('/api/hue/disconnect', (_req, res) => {
    try {
      const changed = settings.update({
        hue: {
          enabled: false, host: '', username: '', clientKey: '', applicationId: '',
          entertainmentId: '', channels: [],
        },
      });
      applier.applyChanged(changed);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ ok: false, error: messageOf(err) });
    }
  });

  app.get('/api/settings', (_req, res) => {
    const { settings: values, secrets } = settings.redacted();
    res.json({
      ok: true,
      settings: values,
      secrets,
      restartKeys: RESTART_PATHS,
      pendingRestart: applier.pendingRestart(),
      // Which interpreter the analyzer actually resolved to, and whether it can
      // import what it needs. Shown under the Python field, because "I ran pip
      // install" and "the analyzer can import librosa" are different claims.
      python: pythonEnv.resolve(),
      // Read-only context the page shows next to the restart-only fields.
      running: applier.bootValues.server,
      // Where the engine is actually rendering and how its frames are going,
      // shown under the thread setting — it can differ from the setting when
      // the worker could not run, and that is worth saying.
      engine: engineStatus(),
      configFile: CONFIG_FILE,
    });
  });

  app.put('/api/settings', (req, res) => {
    try {
      const changed = settings.update(req.body || {});
      applier.applyChanged(changed);
      const { settings: values, secrets } = settings.redacted();
      res.json({
        ok: true,
        changed,
        settings: values,
        secrets,
        pendingRestart: applier.pendingRestart(),
      });
    } catch (err) {
      // Zod errors carry the offending path; surface it rather than a bare 500.
      const issues = err && typeof err === 'object'
        ? (err as { issues?: { path: PropertyKey[]; message: string }[] }).issues : undefined;
      const detail = issues
        ? issues.map((i) => `${i.path.join('.') || '<root>'} ${i.message}`).join('; ')
        : messageOf(err);
      res.status(400).json({ ok: false, error: detail });
    }
  });

  // A token the operator can actually use, rather than asking them to run a
  // node one-liner. Returned once, in the clear, because it has to be copied
  // into Companion and the browser extension — it is not stored until saved.
  app.post('/api/settings/token/suggest', (_req, res) => {
    res.json({ ok: true, token: generateToken() });
  });

  // ─── Error handler ────────────────────────────────────────────────────────
  // Must be registered last. Without it, anything that reaches next(err) — an
  // upload over the size limit, a malformed JSON body, a throw inside an
  // asyncHandler — fell through to Express's default handler, which answers
  // with an HTML page carrying the stack trace (it only hides it when NODE_ENV
  // is 'production', which a locally-run show tool never sets). Every other
  // route here answers JSON; this makes the failure paths agree.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) return;
    const e = (err ?? {}) as { code?: string; field?: string; status?: number; statusCode?: number; stack?: string; message?: string };

    // Multer signals "too big" with a code rather than a status.
    if (e.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ ok: false, error: 'Uploaded file is too large' });
    }
    if (e.code === 'LIMIT_UNEXPECTED_FILE') {
      return res.status(400).json({ ok: false, error: `Unexpected file field "${e.field}"` });
    }

    const status = statusOf(err) || e.statusCode;
    if (status && status >= 400 && status < 500) {
      return res.status(status).json({ ok: false, error: messageOf(err) });
    }

    // Genuine server-side faults: log the detail, return only the message.
    console.error('[api] unhandled error:', e.stack ? e.stack : err);
    res.status(500).json({ ok: false, error: e.message || 'Internal error' });
  });
}

export {
  attachRoutes,
  classifyAnalyzeSource,
  resolveLocalPath,
};
