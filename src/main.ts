import './load-env.ts';
import './start-logging.ts';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import compression from 'compression';
import { Server } from 'socket.io';

import MidiController, { openMidiOutput } from './midi.ts';
import ProLink from './prolink.ts';
import LiveInput from './live-input.ts';
import type { LiveOptions } from './live-input.ts';
import MidiClock from './midi-clock.ts';
import SpotifyClient from './spotify.ts';
import NowPlayingSource from './nowplaying-source.ts';
import { createOsNowPlaying, osNowPlayingKind } from './os-now-playing.ts';
import DeezerSource from './deezer-source.ts';
import * as deezer from './deezer.ts';
import AutoShow from './auto-show.ts';
import { AnalysisCache } from './analysis-cache.ts';

import { state } from './server/state.ts';
import { startEngine, stopEngine, setFrameHook, setPulseSource } from './server/engine.ts';
import { artnetDiscovery } from './server/output.ts';
import { conductor } from './server/conductor.ts';
import { applyPatch, applyOverride, setFixtureMaxBrightness, processTap, setPersist, setHooks, flushPendingPersist } from './server/patch.ts';
import { COLOR_PRESETS, PATTERNS } from './server/presets.ts';
import { setupIntegrations } from './server/integrations.ts';
import { attachRoutes } from './server/routes.ts';
import { attachSockets } from './server/sockets.ts';
import { createAuth, configError, hostOfUrl, sourceMapsForLoopback } from './server/auth.ts';
import { isLoopback } from './server/loopback.ts';
import { settings, CONFIG_FILE, warnAboutLegacyEnv } from './server/settings.ts';
import { cacheDir, dataDir } from './server/config-dir.ts';
import { openBrowser, shouldOpenBrowser } from './server/open-browser.ts';
import { createApplier } from './server/apply.ts';
import { midiMap } from './server/midi-map.ts';
import { cues } from './server/cues.ts';
import { showStore, SHOW_FILE } from './server/show-store.ts';
import { modelManager } from './server/model-manager.ts';
import { pythonSetup } from './server/python-setup.ts';
import * as pythonEnv from './python-env.ts';
import { installProcessSafetyNet } from './server/guard.ts';
import { startHealthMonitor } from './server/health.ts';
import { supervision, startHeartbeat, listenToSupervisor, EXIT_CONFIG, EXIT_RESTART } from './server/supervised.ts';
import { LookStore, currentLook, putBack, resumeAt } from './server/look-store.ts';
import { configFile } from './server/config-dir.ts';
import { messageOf } from './errors.ts';

// Install fault handlers first so module startup failures are reported before the show begins.
installProcessSafetyNet();
startHealthMonitor();

const supervised = supervision();
if (supervised.restarts) {
  console.warn(`[supervisor] restart ${supervised.restarts}: the last run ${supervised.lastExit ? supervised.lastExit.reason : 'ended'}`);
}

warnAboutLegacyEnv();

const HOST = settings.get('server.host');
const LIGHTSHOW_TOKEN = settings.get('server.token');

const fatal = configError({ host: HOST, token: LIGHTSHOW_TOKEN, configFile: CONFIG_FILE });
if (fatal) {
  console.error(`\n${fatal}\n`);
  process.exit(EXIT_CONFIG);
}

const auth = createAuth({
  token: LIGHTSHOW_TOKEN,
  // Read allowed public hostnames per request so URL edits take effect without restart.
  allowedHosts: () => [HOST, hostOfUrl(settings.get('server.publicUrl'))],
});

const app = express();
const server = http.createServer(app);
const io = new Server(server, { allowRequest: auth.allowSocketRequest });

app.use(auth.hostMiddleware);

app.use(compression());

app.use(sourceMapsForLoopback);

app.use(express.static(path.join(import.meta.dirname, '..', 'public')));
app.use('/api', auth.httpMiddleware);   // before express.json: reject first, parse after
app.use(express.json());
io.use(auth.socketMiddleware);

const midi = new MidiController(state, applyPatch, processTap);
midi.overrideFixture = applyOverride;
midi.setFixtureMax = setFixtureMaxBrightness;

midi.setMap(midiMap.get());
midiMap.onChange((map) => midi.setMap(map));
midi.onRebind = (_from, to, binding) => midiMap.setBinding('cc', to, binding);
midi.recallCue = (id) => {
  if (!cues.recall(id)) console.warn(`[MIDI] recallCue: no cue ${id} — it may have been deleted`);
};

const prolink = new ProLink();
const liveInput = new LiveInput();
const spotify = new SpotifyClient();
const nowPlaying = new NowPlayingSource();
const deezerSource = new DeezerSource();

const analysisCache = new AnalysisCache(path.join(cacheDir(), 'analysis'));
const autoShow = new AutoShow(applyPatch, COLOR_PRESETS, PATTERNS, analysisCache);

const integrations = setupIntegrations({ io, midi, spotify, nowPlaying, deezerSource, prolink, autoShow, analysisCache, liveInput });

autoShow.useFrameClock();
setFrameHook(() => autoShow.tick());
setPulseSource(() => autoShow.pulse());
// Recycle an idle worker after model downloads so current analysis is not interrupted.
modelManager.onFinished((job) => {
  if (Object.values(job.models).some((m) => m.state === 'done') && autoShow.restartWorker) {
    autoShow.restartWorker('analysis models downloaded', { whenIdle: true });
  }
});
let liveBeforeSetup: LiveOptions | null = null;
pythonSetup.onHooks({
  before: (reason) => {
    autoShow.pauseAnalysis(reason);
    liveBeforeSetup = liveInput.running ? liveInput.options : null;
    liveInput.stop();
  },
  after: () => {
    autoShow.resumeAnalysis();
    if (liveBeforeSetup) liveInput.start(liveBeforeSetup);
    liveBeforeSetup = null;
  },
});
conductor.setAutoSource(() => autoShow.beatSource());
conductor.setProlinkSource(() => (state.prolinkEnabled && !autoShow.running ? prolink.getBeatReading() : null));
conductor.setLiveSource(() => liveInput.getBeatReading());
const midiClock = new MidiClock({ open: openMidiOutput, beatPos: () => conductor.peek().beatPos });
conductor.onTempo((bpm) => { state.bpm = bpm; });

const smtc = createOsNowPlaying();
smtc.onUpdate((payload) => nowPlaying.updatePlayback(payload));

const patchRestored = showStore.restore();

const applier = createApplier({
  midi, spotify, smtc, live: liveInput, midiClock, deezer, autoShow, applyPatch,
  broadcast: () => integrations.broadcast(),
});
applier.applyAll();

setPersist((patch) => {
  try { settings.update(patch); }
  catch (err) { console.warn(`[settings] could not persist: ${messageOf(err)}`); }
});

setHooks({ showChanged: () => showStore.scheduleSave() });

const lookStore = new LookStore(configFile('look.json'));
const savedLook = supervised.recovering ? lookStore.load() : undefined;
if (savedLook && putBack(savedLook)) {
  console.log(`[look] put back the look from ${savedLook.savedAt}, before the restart`);
}

// Persist refresh-token changes because short-lived access tokens cannot survive between shows.
spotify.onTokens((refreshToken) => {
  try { settings.update({ spotify: { refreshToken } }); }
  catch (err) { console.warn(`[spotify] could not save the session: ${messageOf(err)}`); }
});

attachRoutes(app, { midi, autoShow, spotify, nowPlaying, deezerSource, prolink, analysisCache, integrations, applier, restart: restartServer });
attachSockets(io, { midi, integrations });

// On a thread of its own unless the settings say otherwise (engine.thread).
startEngine({ thread: settings.get('engine.thread') });

// Wait for the playback source on recovery so a resumed show follows the music rather than a stopwatch.
async function resumeAutoShow(auto: NonNullable<NonNullable<typeof savedLook>['auto']>): Promise<void> {
  const saved = savedLook as NonNullable<typeof savedLook>;
  if (!auto.key || !(await autoShow.resume(auto.key, auto.track as typeof autoShow.track))) {
    console.warn('[look] the auto show was running, but its track is no longer in the analysis cache');
    return;
  }
  for (let waited = 0; auto.source !== 'timer' && integrations.resolveAutoSource() !== auto.source && waited < 30_000; waited += 1000) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  const source = integrations.startAutoShow({ fromMs: resumeAt(saved) ?? 0 });
  integrations.broadcast();
  console.log(`[look] took the auto show up again, following ${source}`);
}
if (savedLook?.auto?.running) resumeAutoShow(savedLook.auto).catch((err) => console.warn(`[look] could not resume the auto show: ${messageOf(err)}`));

setInterval(() => lookStore.save(currentLook(autoShow, integrations.resolveAutoSource())), 2000).unref();
artnetDiscovery.start();

// Do not await Spotify sign-in because network failures must not prevent the rig from starting.
function restoreSpotifySession() {
  const stored = settings.get('spotify.refreshToken');
  if (!stored || !spotify.configured) return;

  spotify.restoreSession(stored)
    .then((ok) => {
      if (!ok) return;
      spotify.startPolling();
      integrations.broadcast();
      console.log('  Spotify           →  reconnected from the saved session');
    })
    .catch((err) => {
      if (err && err.status >= 400 && err.status < 500) {
        console.warn(`[spotify] saved session is no longer valid (${err.message}) — reconnect at /auth/spotify`);
      } else {
        console.warn(`[spotify] could not reconnect the saved session: ${err.message} — it will be retried on the next start`);
      }
    });
}

const PORT = settings.get('server.port');

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\nPort ${PORT} is already in use — is another copy of the lightshow running? `
      + `Stop it, or change the port in ${CONFIG_FILE} (server.port).\n`);
  } else {
    console.error(`\nCould not listen on ${HOST}:${PORT}: ${err.message}\n`);
  }
  let engineDown = Promise.resolve();
  try { engineDown = stopEngine(); } catch (_) { /* on the way out regardless */ }
  Promise.resolve(engineDown).catch(() => {}).finally(() => process.exit(EXIT_CONFIG));
});

server.listen(PORT, HOST, () => {
  startHeartbeat();
  applier.refreshCallbackUrl();

  const shownHost = isLoopback(HOST) ? 'localhost' : HOST;
  const smtcEnabled = settings.get('sources.smtc');

  console.log(`\n  ArtNet Lightshow  →  http://${shownHost}:${PORT}`);
  console.log(`  Setup             →  http://${shownHost}:${PORT}/#rig  (the Rig, Sources and Settings views)`);
  console.log(`  Config file       →  ${CONFIG_FILE}`);
  if (process.env.LIGHTSHOW_DATA_DIR) console.log(`  Data folder       →  ${dataDir()}`);
  console.log(`  Access            →  ${auth.enabled
    ? 'token required — the page asks for it on first open'
    : 'no token — loopback only, this machine can reach it'}`);
  if (auth.enabled) {
    console.log(`                       (it is in ${CONFIG_FILE} under "server.token";`);
    console.log(`                        http://${shownHost}:${PORT}/?token=… still works)`);
  }
  console.log(`  ArtNet            →  ${state.artnet.host}:${state.artnet.port} universe ${state.artnet.universe}`);
  console.log(`  Fixtures          →  ${state.fixtures.length}x at DMX ${state.fixtures.map((f) => f.address).join(', ')}`
    + `  [${patchRestored ? `saved patch, ${SHOW_FILE}` : 'default patch — saved as you change it'}]`);
  console.log(`  MIDI              →  ${midi.enabled ? 'connected' : 'not connected (pick a port under Settings → MIDI controller)'}`
    + `  [${midiMap.snapshot().customised ? 'custom map' : 'default X-Touch map'}]`);
  console.log(`  PRO DJ LINK       →  ${state.prolinkEnabled ? 'enabled' : 'disabled (enable it under Sources)'}`);
  console.log(`  Spotify           →  ${spotify.configured ? 'configured (visit /auth/spotify to connect)' : 'not configured (add a client ID & secret under Sources)'}`);
  if (spotify.configured) {
    console.log(`  Spotify auth      →  ${spotify.usingProxy ? `via proxy ${spotify.proxyBase}` : 'direct (no proxy)'}`);
    console.log(`  Spotify redirect  →  register this URL in your Spotify dashboard:`);
    console.log(`                       ${spotify.redirectUri}`);
  }
  console.log(`  Deezer            →  ${settings.get('deezer.arl') ? 'configured (ISRC-based downloads)' : 'not configured (add an ARL under Sources — falls back to yt-dlp)'}`);
  const npKind = osNowPlayingKind();
  const npStatus = !npKind
    ? 'unavailable (Windows and Linux only)'
    : !smtcEnabled ? 'disabled in settings'
      : npKind === 'SMTC' ? 'reading OS media session (SMTC)' : 'reading MPRIS players on the session bus';
  console.log(`  Now Playing       →  ${npStatus}`);
  console.log(`  Python            →  ${pythonEnv.describe()}`);
  console.log(`  Auto Show         →  Essentia + Spotify integration\n`);

  if (shouldOpenBrowser({ restarts: supervised.restarts })) openBrowser(`http://${shownHost}:${PORT}/`);

  restoreSpotifySession();

  pythonEnv.warnIfUnusable();
});

let shuttingDown = false;

function shutdown(signal: string, exitCode = 0): void {
  if (shuttingDown) return;             // a second Ctrl-C shouldn't re-enter this
  shuttingDown = true;
  console.log(`\n${signal} — blacking out and shutting down…`);

  let engineDown = Promise.resolve();
  for (const [what, fn] of [
    ['engine', () => { engineDown = stopEngine(); }],
    ['artnet', () => artnetDiscovery.stop()],
    ['smtc', () => smtc.stop()],
    ['autoShow', () => autoShow.destroy()],
    ['spotify', () => spotify.disconnect()],
    ['nowPlaying', () => nowPlaying.disconnect()],
    ['deezer', () => deezerSource.disconnect()],
    ['prolink', () => prolink.destroy()],
    ['live input', () => liveInput.stop()],
    ['midi clock', () => midiClock.stop()],
    ['midi', () => midi.close()],
    ['show', () => showStore.save()],
    ['settings', () => flushPendingPersist()],
  ] as [string, () => unknown][]) {
    try { fn(); } catch (err) { console.warn(`[shutdown] ${what}: ${messageOf(err)}`); }
  }

  Promise.resolve(engineDown).catch(() => {}).finally(() => server.close(() => process.exit(exitCode)));
  setTimeout(() => process.exit(exitCode), 2000).unref();
}

function restartServer(reason: string): boolean {
  if (!supervised.supervised || !process.send) return false;
  process.send({ type: 'restart', reason });
  setTimeout(() => shutdown('Restart', EXIT_RESTART), 200);
  return true;
}

process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGHUP',  () => shutdown('SIGHUP'));
listenToSupervisor({
  stop: (signal) => shutdown(signal),
  gone: () => shutdown('The supervisor has gone'),
});
