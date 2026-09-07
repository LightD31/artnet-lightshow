'use strict';

require('dotenv').config();
const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const MidiController = require('./src/midi');
const ProLink = require('./src/prolink');
const SpotifyClient = require('./src/spotify');
const NowPlayingSource = require('./src/nowplaying-source');
const SmtcReader = require('./src/smtc-source');
const DeezerSource = require('./src/deezer-source');
const deezer = require('./src/deezer');
const AutoShow = require('./src/auto-show');
const { AnalysisCache } = require('./src/analysis-cache');

const { state } = require('./src/server/state');
const { startEngine, stopEngine } = require('./src/server/engine');
const { applyPatch, applyOverride, processTap, setPersist } = require('./src/server/patch');
const { COLOR_PRESETS, PATTERNS } = require('./src/server/presets');
const { setupIntegrations } = require('./src/server/integrations');
const { attachRoutes } = require('./src/server/routes');
const { attachSockets } = require('./src/server/sockets');
const { createAuth, configError, isLoopbackHost } = require('./src/server/auth');
const { settings, CONFIG_FILE, warnAboutLegacyEnv } = require('./src/server/settings');
const { createApplier } = require('./src/server/apply');

// A .env from before settings moved into the UI would otherwise go quiet: the
// rig would come up on defaults with no clue why. Say which variables are now
// ignored, then carry on.
warnAboutLegacyEnv();

// ─── Bind address & access control ──────────────────────────────────────────
// Loopback by default: exposing the rig to the whole network should be a
// deliberate act, and once it is, a token is mandatory. These three are read
// before anything is listening, so changing them in the settings page takes
// effect on the next start.
const HOST = settings.get('server.host');
const LIGHTSHOW_TOKEN = settings.get('server.token');

const fatal = configError({ host: HOST, token: LIGHTSHOW_TOKEN, configFile: CONFIG_FILE });
if (fatal) {
  console.error(`\n${fatal}\n`);
  process.exit(1);
}

const auth = createAuth({ token: LIGHTSHOW_TOKEN });

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Static assets stay open: they carry no secrets, and the page needs to load
// before it can present a token. Everything that reads or changes show state
// goes through the guard.
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api', auth.httpMiddleware);   // before express.json: reject first, parse after
app.use(express.json());
io.use(auth.socketMiddleware);

// ─── Subsystems ─────────────────────────────────────────────────────────────

const midi = new MidiController(state, applyPatch, processTap);
midi.overrideFixture = applyOverride;

const prolink = new ProLink();
const spotify = new SpotifyClient();
const nowPlaying = new NowPlayingSource();
const deezerSource = new DeezerSource();

const analysisCache = new AnalysisCache(path.join(__dirname, 'cache', 'analysis'));
const autoShow = new AutoShow(applyPatch, COLOR_PRESETS, PATTERNS, analysisCache);

const integrations = setupIntegrations({ io, midi, spotify, nowPlaying, deezerSource, prolink, autoShow });

// Windows "now playing" (SMTC) feeds the generic now-playing source: we read
// the OS media session, so any player that reports to it (Deezer, Tidal,
// YouTube, a browser tab, a desktop app…) drives the auto-show.
const smtc = new SmtcReader();
smtc.onUpdate((payload) => nowPlaying.updatePlayback(payload));

// Everything configurable is pushed into the subsystems from one place, both
// here at boot and again whenever the settings page saves.
const applier = createApplier({
  midi, spotify, smtc, deezer, applyPatch,
  broadcast: () => integrations.broadcast(),
});
applier.applyAll();

// Art-Net, PRO DJ LINK and MIDI are also reachable from the main page and the
// patch panel. Persist those edits so the settings page keeps showing the
// truth and the choice survives a restart.
setPersist((patch) => {
  try { settings.update(patch); }
  catch (err) { console.warn(`[settings] could not persist: ${err.message}`); }
});

attachRoutes(app, { midi, autoShow, spotify, nowPlaying, deezerSource, prolink, analysisCache, integrations, applier });
attachSockets(io, { midi, integrations });

startEngine();

// ─── Listen ─────────────────────────────────────────────────────────────────

const PORT = settings.get('server.port');
server.listen(PORT, HOST, () => {
  // Where the OAuth proxy sends the operator's browser back to. Must be an
  // address that browser can actually reach: "localhost" is only right when the
  // browser is on this machine. The settings page's "public URL" overrides for
  // anything unusual (reverse proxy, hostname, https).
  applier.refreshCallbackUrl();

  const shownHost = isLoopbackHost(HOST) ? 'localhost' : HOST;
  const smtcEnabled = settings.get('sources.smtc');

  console.log(`\n  ArtNet Lightshow  →  http://${shownHost}:${PORT}`);
  console.log(`  Settings          →  http://${shownHost}:${PORT}/settings.html  (everything is configured there)`);
  console.log(`  Config file       →  ${CONFIG_FILE}`);
  console.log(`  Access            →  ${auth.enabled
    ? `token required (open /?token=… once per browser)`
    : 'no token — loopback only, this machine can reach it'}`);
  console.log(`  ArtNet            →  ${state.artnet.host}:${state.artnet.port} universe ${state.artnet.universe}`);
  console.log(`  Fixtures          →  ${state.fixtures.length}x at DMX ${state.fixtures.map((f) => f.address).join(', ')}`);
  console.log(`  MIDI              →  ${midi.enabled ? 'connected' : 'not connected (pick a port in the settings page)'}`);
  console.log(`  PRO DJ LINK       →  ${state.prolinkEnabled ? 'enabled' : 'disabled (enable it in the settings page)'}`);
  console.log(`  Spotify           →  ${spotify.configured ? 'configured (visit /auth/spotify to connect)' : 'not configured (add a client ID & secret in the settings page)'}`);
  if (spotify.configured) {
    console.log(`  Spotify redirect  →  register this URL in your Spotify dashboard:`);
    console.log(`                       ${spotify.redirectUri}`);
  }
  console.log(`  Deezer            →  ${settings.get('deezer.arl') ? 'configured (ISRC-based downloads)' : 'not configured (add an ARL in the settings page — falls back to yt-dlp)'}`);
  const npStatus = process.platform !== 'win32'
    ? 'unavailable (Windows-only)'
    : smtcEnabled ? 'reading OS media session (SMTC)' : 'disabled in settings';
  console.log(`  Now Playing       →  ${npStatus}`);
  console.log(`  Auto Show         →  Essentia + Spotify integration (python: ${AutoShow.PYTHON_EXE})\n`);
});

// ─── Shutdown ───────────────────────────────────────────────────────────────
// One path for both signals: the two copies had to be edited in lockstep, and
// neither put the rig out on the way down. stopEngine() sends a final all-zero
// frame so the fixtures don't hold the last look after the server is gone.
let shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown) return;             // a second Ctrl-C shouldn't re-enter this
  shuttingDown = true;
  console.log(`\n${signal} — blacking out and shutting down…`);

  // Each of these is independent: one throwing must not skip the rest.
  for (const [what, fn] of [
    ['engine', () => stopEngine()],
    ['smtc', () => smtc.stop()],
    ['autoShow', () => autoShow.destroy()],
    ['spotify', () => spotify.disconnect()],
    ['nowPlaying', () => nowPlaying.disconnect()],
    ['deezer', () => deezerSource.disconnect()],
    ['prolink', () => prolink.destroy()],
    ['midi', () => midi.close()],
  ]) {
    try { fn(); } catch (err) { console.warn(`[shutdown] ${what}: ${err.message}`); }
  }

  server.close(() => process.exit(0));
  // Don't hang on a lingering keep-alive socket or an in-flight analysis.
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
