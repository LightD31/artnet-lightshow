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
const deezer = require('./src/deezer');
const AutoShow = require('./src/auto-show');
const { AnalysisCache } = require('./src/analysis-cache');

const { state } = require('./src/server/state');
const { startEngine } = require('./src/server/engine');
const { applyPatch, applyOverride, processTap } = require('./src/server/patch');
const { COLOR_PRESETS, PATTERNS } = require('./src/server/presets');
const { setupIntegrations } = require('./src/server/integrations');
const { attachRoutes } = require('./src/server/routes');
const { attachSockets } = require('./src/server/sockets');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ─── Subsystems ─────────────────────────────────────────────────────────────

const midi = new MidiController(state, applyPatch, processTap);
midi.overrideFixture = applyOverride;

const midiInputName  = process.env.MIDI_INPUT  || null;
const midiOutputName = process.env.MIDI_OUTPUT || null;
midi.connect(midiInputName, midiOutputName);

const prolink = new ProLink();
const spotify = new SpotifyClient();
const nowPlaying = new NowPlayingSource();

const analysisCache = new AnalysisCache(path.join(__dirname, 'cache', 'analysis'));
const autoShow = new AutoShow(applyPatch, COLOR_PRESETS, PATTERNS, analysisCache);

if (process.env.DEEZER_ARL) {
  deezer.init(process.env.DEEZER_ARL).catch((err) => {
    console.warn(`[deezer] Init failed: ${err.message} — will fall back to yt-dlp`);
  });
}

const integrations = setupIntegrations({ io, midi, spotify, nowPlaying, prolink, autoShow });

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

attachRoutes(app, { midi, autoShow, spotify, nowPlaying, prolink, analysisCache, integrations });
attachSockets(io, { midi });

startEngine();

// ─── Listen ─────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  spotify.localCallbackUrl = `http://localhost:${PORT}/auth/spotify/callback`;

  console.log(`\n  ArtNet Lightshow  →  http://localhost:${PORT}`);
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

process.on('SIGINT',  () => { smtc.stop(); autoShow.destroy(); spotify.disconnect(); nowPlaying.disconnect(); prolink.destroy(); process.exit(0); });
process.on('SIGTERM', () => { smtc.stop(); autoShow.destroy(); spotify.disconnect(); nowPlaying.disconnect(); prolink.destroy(); process.exit(0); });
