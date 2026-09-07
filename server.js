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
const { applyPatch, applyOverride, processTap } = require('./src/server/patch');
const { COLOR_PRESETS, PATTERNS } = require('./src/server/presets');
const { setupIntegrations } = require('./src/server/integrations');
const { attachRoutes } = require('./src/server/routes');
const { attachSockets } = require('./src/server/sockets');
const { createAuth, configError, isLoopbackHost } = require('./src/server/auth');

// ─── Bind address & access control ──────────────────────────────────────────
// Loopback by default: exposing the rig to the whole network should be a
// deliberate act, and once it is, a token is mandatory.
const HOST = process.env.HOST || '127.0.0.1';
const LIGHTSHOW_TOKEN = process.env.LIGHTSHOW_TOKEN || '';

const fatal = configError({ host: HOST, token: LIGHTSHOW_TOKEN });
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

const midiInputName  = process.env.MIDI_INPUT  || null;
const midiOutputName = process.env.MIDI_OUTPUT || null;
midi.connect(midiInputName, midiOutputName);

const prolink = new ProLink();
const spotify = new SpotifyClient();
const nowPlaying = new NowPlayingSource();
const deezerSource = new DeezerSource();

const analysisCache = new AnalysisCache(path.join(__dirname, 'cache', 'analysis'));
const autoShow = new AutoShow(applyPatch, COLOR_PRESETS, PATTERNS, analysisCache);

if (process.env.DEEZER_ARL) {
  deezer.init(process.env.DEEZER_ARL).catch((err) => {
    console.warn(`[deezer] Init failed: ${err.message} — will fall back to yt-dlp`);
  });
}

const integrations = setupIntegrations({ io, midi, spotify, nowPlaying, deezerSource, prolink, autoShow });

// Windows "now playing" (SMTC) feeds the generic now-playing source: we read
// the OS media session, so any player that reports to it (Deezer, Tidal,
// YouTube, a browser tab, a desktop app…) drives the auto-show. SMTC=0 disables.
const smtc = new SmtcReader();
if (process.env.SMTC !== '0') {
  smtc.onUpdate((payload) => nowPlaying.updatePlayback(payload));
  smtc.start();
}

if (process.env.PROLINK === '1') {
  state.prolinkEnabled = true;
  prolink.enable().catch((err) => {
    console.error('PRO DJ LINK enable failed:', err.message);
    state.prolinkEnabled = false;
  });
}

attachRoutes(app, { midi, autoShow, spotify, nowPlaying, deezerSource, prolink, analysisCache, integrations });
attachSockets(io, { midi, integrations });

startEngine();

// ─── Listen ─────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
server.listen(PORT, HOST, () => {
  // Where the OAuth proxy sends the operator's browser back to. Must be an
  // address that browser can actually reach: "localhost" is only right when the
  // browser is on this machine. PUBLIC_URL overrides for anything unusual
  // (reverse proxy, hostname, https).
  const publicBase = process.env.PUBLIC_URL
    ? process.env.PUBLIC_URL.replace(/\/+$/, '')
    : `http://${isLoopbackHost(HOST) ? 'localhost' : HOST}:${PORT}`;
  spotify.localCallbackUrl = `${publicBase}/auth/spotify/callback`;

  console.log(`\n  ArtNet Lightshow  →  http://${isLoopbackHost(HOST) ? 'localhost' : HOST}:${PORT}`);
  console.log(`  Access            →  ${auth.enabled
    ? `token required (open /?token=… once per browser)`
    : 'no token — loopback only, this machine can reach it'}`);
  console.log(`  ArtNet            →  ${state.artnet.host}:${state.artnet.port} universe ${state.artnet.universe}`);
  console.log(`  Fixtures          →  ${state.fixtures.length}x at DMX ${state.fixtures.map((f) => f.address).join(', ')}`);
  console.log(`  MIDI              →  ${midi.enabled ? 'connected' : 'not connected (set MIDI_INPUT env var or use /api/midi/connect)'}`);
  console.log(`  PRO DJ LINK       →  ${state.prolinkEnabled ? 'enabled' : 'disabled (set PROLINK=1 env var or use web UI)'}`);
  console.log(`  Spotify           →  ${spotify.configured ? 'configured (visit /auth/spotify to connect)' : 'not configured (set SPOTIFY_CLIENT_ID & SPOTIFY_CLIENT_SECRET in .env)'}`);
  if (spotify.configured) {
    console.log(`  Spotify redirect  →  register this URL in your Spotify dashboard:`);
    console.log(`                       ${spotify.redirectUri}`);
  }
  console.log(`  Deezer            →  ${process.env.DEEZER_ARL ? 'configured (ISRC-based downloads)' : 'not configured (set DEEZER_ARL in .env for exact audio — falls back to yt-dlp)'}`);
  const npStatus = process.platform !== 'win32'
    ? 'unavailable (Windows-only)'
    : process.env.SMTC === '0' ? 'disabled (SMTC=0)' : 'reading OS media session (SMTC)';
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
