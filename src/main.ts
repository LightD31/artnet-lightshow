import './load-env.ts';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import compression from 'compression';
import { Server } from 'socket.io';

import MidiController, { openMidiOutput } from './midi.ts';
import ProLink from './prolink.ts';
import LiveInput from './live-input.ts';
import MidiClock from './midi-clock.ts';
import SpotifyClient from './spotify.ts';
import NowPlayingSource from './nowplaying-source.ts';
import SmtcReader from './smtc-source.ts';
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
import { createAuth, configError, hostOfUrl, isLoopbackHost, sourceMapsForLoopback } from './server/auth.ts';
import { settings, CONFIG_FILE, warnAboutLegacyEnv } from './server/settings.ts';
import { cacheDir } from './server/config-dir.ts';
import { createApplier } from './server/apply.ts';
import { midiMap } from './server/midi-map.ts';
import { cues } from './server/cues.ts';
import { showStore, SHOW_FILE } from './server/show-store.ts';
import { modelManager } from './server/model-manager.ts';
import * as pythonEnv from './python-env.ts';
import { installProcessSafetyNet } from './server/guard.ts';
import { messageOf } from './errors.ts';

// Before anything else can fail: a fault the code did not expect is reported
// and the rig keeps running, rather than the process exiting with every
// fixture latched on its last frame. See server/guard.ts.
installProcessSafetyNet();

// A .env from before settings moved into the UI would otherwise go quiet: the
// rig would come up on defaults with no clue why. Say which variables are now
// ignored, then carry on.
warnAboutLegacyEnv();

// ─── Bind address & access control ──────────────────────────────────────────
// Loopback by default: exposing the rig to the whole network should be a
// deliberate act, and once it is, a token is mandatory. These three are read
// before anything is listening, so changing them in the settings takes
// effect on the next start.
const HOST = settings.get('server.host');
const LIGHTSHOW_TOKEN = settings.get('server.token');

const fatal = configError({ host: HOST, token: LIGHTSHOW_TOKEN, configFile: CONFIG_FILE });
if (fatal) {
  console.error(`\n${fatal}\n`);
  process.exit(1);
}

const auth = createAuth({
  token: LIGHTSHOW_TOKEN,
  // Names beyond the ones every machine has (IP literals, localhost, its own
  // host name). Read per request so a public URL saved in the settings
  // applies without a restart.
  allowedHosts: () => [HOST, hostOfUrl(settings.get('server.publicUrl'))],
});

const app = express();
const server = http.createServer(app);
const io = new Server(server, { allowRequest: auth.allowSocketRequest });

// Before anything else, static files included: a page reached through a name
// this machine is not known by is a DNS-rebinding page, and it gets nothing.
app.use(auth.hostMiddleware);

// Compressed: the bundle and the timeline documents are text, and a tablet on
// venue Wi-Fi fetches both (A7.26). Socket.IO compresses its own messages.
app.use(compression());

// The bundle's source map is for whoever is debugging at this machine, not for
// every phone on the venue network (A7.26).
app.use(sourceMapsForLoopback);

// Static assets stay open: they carry no secrets, and the page needs to load
// before it can present a token. Everything that reads or changes show state
// goes through the guard.
app.use(express.static(path.join(import.meta.dirname, '..', 'public')));
app.use('/api', auth.httpMiddleware);   // before express.json: reject first, parse after
app.use(express.json());
io.use(auth.socketMiddleware);

// ─── Subsystems ─────────────────────────────────────────────────────────────

const midi = new MidiController(state, applyPatch, processTap);
midi.overrideFixture = applyOverride;
midi.setFixtureMax = setFixtureMaxBrightness;

// The control map is stored and relearnable, so the controller follows edits
// without a reconnect. Cue recall is wired in from here rather than reached for
// inside midi.js, which has no business knowing about the cue store.
midi.setMap(midiMap.get());
midiMap.onChange((map) => midi.setMap(map));
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

// One clock for every pattern (see src/server/conductor.js). The render loop
// drives the auto show's cursor, so a cue fires on the frame it is due, and
// the pattern clock follows the show's beat grid while it runs, else the
// playing deck's, else the playing track's, else the beat the live input
// hears, else the operator's tap.
autoShow.useFrameClock();
setFrameHook(() => autoShow.tick());
setPulseSource(() => autoShow.pulse());
// A model downloaded while the server runs is used from the next worker on:
// restart it, so it loads (and warms) what just arrived — once the track it
// may be analysing is done, not by starting that one over.
modelManager.onFinished((job) => {
  if (Object.values(job.models).some((m) => m.state === 'done') && autoShow.restartWorker) {
    autoShow.restartWorker('analysis models downloaded', { whenIdle: true });
  }
});
conductor.setAutoSource(() => autoShow.beatSource());
conductor.setProlinkSource(() => (state.prolinkEnabled && !autoShow.running ? prolink.getBeatReading() : null));
conductor.setLiveSource(() => liveInput.getBeatReading());
// The same clock, out to MIDI (settings: midi.clockOutput).
const midiClock = new MidiClock({ open: openMidiOutput, beatPos: () => conductor.peek().beatPos });
conductor.onTempo((bpm) => { state.bpm = bpm; });

// Windows "now playing" (SMTC) feeds the generic now-playing source: we read
// the OS media session, so any player that reports to it (Deezer, Tidal,
// YouTube, a browser tab, a desktop app…) drives the auto-show.
const smtc = new SmtcReader();
smtc.onUpdate((payload) => nowPlaying.updatePlayback(payload));

// The patch the operator left behind, put back before anything reads the
// fixture list: the applier binds Hue channels to fixtures, the engine sizes
// its buffers to them, and the banner below prints them.
const patchRestored = showStore.restore();

// Everything configurable is pushed into the subsystems from one place, both
// here at boot and again whenever the settings are saved.
const applier = createApplier({
  midi, spotify, smtc, live: liveInput, midiClock, deezer, autoShow, applyPatch,
  broadcast: () => integrations.broadcast(),
});
applier.applyAll();

// Art-Net, PRO DJ LINK and MIDI are also reachable from the main page and the
// patch panel. Persist those edits so the Rig view keeps showing the
// truth and the choice survives a restart.
setPersist((patch) => {
  try { settings.update(patch); }
  catch (err) { console.warn(`[settings] could not persist: ${messageOf(err)}`); }
});

// The patch itself is not a setting — it is the rig — so it has its own file.
// Edits reach it from the patch panel, the fixture routes and the socket, and
// every one of them saves, so the rig comes back as it was left.
setHooks({ showChanged: () => showStore.scheduleSave() });

// Keep the Spotify session across restarts. Only the refresh token is stored —
// access tokens last an hour, so one saved at shutdown would be stale by the
// next show, while the refresh token mints a fresh one on demand. Spotify may
// rotate it on any refresh, so this fires on every change rather than only at
// the initial connect.
spotify.onTokens((refreshToken) => {
  try { settings.update({ spotify: { refreshToken } }); }
  catch (err) { console.warn(`[spotify] could not save the session: ${messageOf(err)}`); }
});

attachRoutes(app, { midi, autoShow, spotify, nowPlaying, deezerSource, prolink, analysisCache, integrations, applier });
attachSockets(io, { midi, integrations });

// On a thread of its own unless the settings say otherwise (engine.thread).
startEngine({ thread: settings.get('engine.thread') });
// While Art-Net broadcasts, find the nodes and send each its universes.
artnetDiscovery.start();

/**
 * Sign back in with the stored refresh token, if there is one.
 *
 * Deliberately not awaited: a rig should come up and start doing lights whether
 * or not Spotify is reachable, and the poller starts on its own once this
 * lands. The two failure modes are treated differently — Spotify rejecting the
 * grant means the session is genuinely gone (revoked in the account, or the
 * client id changed under it) and the stored token is cleared so the banner
 * stops promising a connection that will never come; anything else is the
 * network not being up yet, which a headless rig does at every boot, and the
 * token is kept for the next attempt.
 */
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
      // restoreSession has already cleared the stored token if Spotify rejected
      // the grant, and kept it if the request simply never landed.
      if (err && err.status >= 400 && err.status < 500) {
        console.warn(`[spotify] saved session is no longer valid (${err.message}) — reconnect at /auth/spotify`);
      } else {
        console.warn(`[spotify] could not reconnect the saved session: ${err.message} — it will be retried on the next start`);
      }
    });
}

// ─── Listen ─────────────────────────────────────────────────────────────────

const PORT = settings.get('server.port');

// The safety net keeps the process up through unexpected faults, which is the
// wrong answer for this one: a server that cannot listen is no server at all,
// and staying up would leave the operator with a console and no page.
server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\nPort ${PORT} is already in use — is another copy of the lightshow running? `
      + 'Stop it, or change the port in config/settings.json (server.port).\n');
  } else {
    console.error(`\nCould not listen on ${HOST}:${PORT}: ${err.message}\n`);
  }
  let engineDown = Promise.resolve();
  try { engineDown = stopEngine(); } catch (_) { /* on the way out regardless */ }
  Promise.resolve(engineDown).catch(() => {}).finally(() => process.exit(1));
});

server.listen(PORT, HOST, () => {
  // Where the OAuth proxy sends the operator's browser back to. Must be an
  // address that browser can actually reach: "localhost" is only right when the
  // browser is on this machine. The "public URL" setting overrides for
  // anything unusual (reverse proxy, hostname, https).
  applier.refreshCallbackUrl();

  const shownHost = isLoopbackHost(HOST) ? 'localhost' : HOST;
  const smtcEnabled = settings.get('sources.smtc');

  console.log(`\n  ArtNet Lightshow  →  http://${shownHost}:${PORT}`);
  console.log(`  Settings          →  http://${shownHost}:${PORT}/settings.html  (everything is configured there)`);
  console.log(`  Config file       →  ${CONFIG_FILE}`);
  // Deliberately not the token itself: this banner is the first thing anyone
  // pastes into a bug report or a chat window.
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
  const npStatus = process.platform !== 'win32'
    ? 'unavailable (Windows-only)'
    : smtcEnabled ? 'reading OS media session (SMTC)' : 'disabled in settings';
  console.log(`  Now Playing       →  ${npStatus}`);
  console.log(`  Python            →  ${pythonEnv.describe()}`);
  console.log(`  Auto Show         →  Essentia + Spotify integration\n`);

  restoreSpotifySession();

  // Say this after the banner, where it won't scroll past unnoticed: otherwise
  // the first sign of a wrong interpreter is a traceback minutes into a set,
  // after a track has already downloaded.
  pythonEnv.warnIfUnusable();
});

// ─── Shutdown ───────────────────────────────────────────────────────────────
// One path for both signals: the two copies had to be edited in lockstep, and
// neither put the rig out on the way down. stopEngine() sends a final all-zero
// frame so the fixtures don't hold the last look after the server is gone.
let shuttingDown = false;

function shutdown(signal: string): void {
  if (shuttingDown) return;             // a second Ctrl-C shouldn't re-enter this
  shuttingDown = true;
  console.log(`\n${signal} — blacking out and shutting down…`);

  // Each of these is independent: one throwing must not skip the rest. The
  // engine answers once the rig is blacked out; the server waits for that
  // before it closes.
  let engineDown = Promise.resolve();
  for (const [what, fn] of [
    ['engine', () => { engineDown = stopEngine(); }],
    ['artnet', () => artnetDiscovery.stop()],
    ['smtc', () => smtc.stop()],
    ['autoShow', () => autoShow.destroy()],
    // No `forget`: this is the way down, not the operator disconnecting.
    ['spotify', () => spotify.disconnect()],
    ['nowPlaying', () => nowPlaying.disconnect()],
    ['deezer', () => deezerSource.disconnect()],
    ['prolink', () => prolink.destroy()],
    ['live input', () => liveInput.stop()],
    ['midi clock', () => midiClock.stop()],
    ['midi', () => midi.close()],
    // Lands a debounced patch write that had not fired yet. A no-op when the
    // file already matches, which is the usual case.
    ['show', () => showStore.save()],
    // Likewise a sync offset nudged in the last moment before quitting.
    ['settings', () => flushPendingPersist()],
  ] as [string, () => unknown][]) {
    try { fn(); } catch (err) { console.warn(`[shutdown] ${what}: ${messageOf(err)}`); }
  }

  Promise.resolve(engineDown).catch(() => {}).finally(() => server.close(() => process.exit(0)));
  // Don't hang on a lingering keep-alive socket or an in-flight analysis.
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
