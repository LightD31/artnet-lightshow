'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const multer = require('multer');

const { state, getClientState, getFixtureCount } = require('./state');
const { applyPatch, applyOverride, processTap } = require('./patch');
const { resizeFixtureBuffers } = require('./engine');
const { parseGDTF } = require('../gdtf');
const {
  BUILTIN_PROFILE_ID,
  registerProfile,
  unregisterProfile,
  listProfiles,
  clearNonBuiltinProfiles,
} = require('./profiles');
const { profileSchema, showSchema, midiConnectSchema, validate } = require('./validation');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function attachRoutes(app, deps) {
  const { midi, autoShow, spotify, prolink, analysisCache, integrations } = deps;

  // ─── State ────────────────────────────────────────────────────────────────
  app.get('/api/state', (_req, res) => res.json(getClientState()));

  app.post('/api/set', (req, res) => {
    try {
      applyPatch(req.body);
      res.json({ ok: true, state: getClientState() });
    } catch (err) {
      res.status(err.status || 400).json({ ok: false, error: err.message });
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
    } catch (err) { res.status(400).json({ ok: false, error: err.message }); }
  });

  app.post('/api/color/:slot/:index', (req, res) => {
    const slotMap = { a: 'colorA', b: 'colorB', c: 'colorC', d: 'colorD' };
    const slot = slotMap[req.params.slot] || 'colorA';
    try {
      applyPatch({ [slot]: parseInt(req.params.index, 10) });
      res.json({ ok: true, colorA: state.colorA, colorB: state.colorB, colorC: state.colorC, colorD: state.colorD });
    } catch (err) { res.status(400).json({ ok: false, error: err.message }); }
  });

  app.post('/api/bpm/:value', (req, res) => {
    try {
      applyPatch({ bpm: parseInt(req.params.value, 10) });
      res.json({ ok: true, bpm: state.bpm });
    } catch (err) { res.status(400).json({ ok: false, error: err.message }); }
  });

  app.post('/api/bpm/adjust/:delta', (req, res) => {
    try {
      applyPatch({ bpm: state.bpm + parseInt(req.params.delta, 10) });
      res.json({ ok: true, bpm: state.bpm });
    } catch (err) { res.status(400).json({ ok: false, error: err.message }); }
  });

  app.post('/api/play', (_req, res) => { applyPatch({ running: true });  res.json({ ok: true }); });
  app.post('/api/stop', (_req, res) => { applyPatch({ running: false }); res.json({ ok: true }); });

  app.post('/api/master/:value', (req, res) => {
    try {
      applyPatch({ masterDimmer: parseInt(req.params.value, 10) });
      res.json({ ok: true, masterDimmer: state.masterDimmer });
    } catch (err) { res.status(400).json({ ok: false, error: err.message }); }
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
    } catch (err) { res.status(400).json({ ok: false, error: err.message }); }
  });

  // ─── Per-fixture overrides ────────────────────────────────────────────────
  app.post('/api/fixture/:id/override', (req, res) => {
    try {
      applyOverride(parseInt(req.params.id, 10), req.body);
      res.json({ ok: true });
    } catch (err) { res.status(400).json({ ok: false, error: err.message }); }
  });

  app.post('/api/fixture/:id/blackout/toggle', (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const cur = state.fixtures[id] && state.fixtures[id].override;
      applyOverride(id, {
        ...(cur || { r: 0, g: 0, b: 0, w: 0, a: 0, uv: 0, dim: 0, strobe: 0 }),
        enabled: true,
        blackout: !(cur && cur.blackout),
      });
      res.json({ ok: true });
    } catch (err) { res.status(400).json({ ok: false, error: err.message }); }
  });

  app.post('/api/fixture/:id/clear', (req, res) => {
    applyOverride(parseInt(req.params.id, 10), null);
    res.json({ ok: true });
  });

  // ─── MIDI ─────────────────────────────────────────────────────────────────
  app.get('/api/midi/ports', (_req, res) => res.json(midi.listPorts()));

  app.post('/api/midi/connect', (req, res) => {
    try {
      const body = validate(midiConnectSchema, req.body || {}, 'midi-connect');
      midi.close();
      const ok = midi.connect(body.input || null, body.output || null);
      res.json({ ok, enabled: midi.enabled, ports: midi.listPorts() });
    } catch (err) { res.status(400).json({ ok: false, error: err.message }); }
  });

  // ─── PRO DJ LINK ──────────────────────────────────────────────────────────
  app.post('/api/prolink/enable',  (_req, res) => { applyPatch({ prolinkEnabled: true });  res.json({ ok: true, prolink: getClientState().prolink }); });
  app.post('/api/prolink/disable', (_req, res) => { applyPatch({ prolinkEnabled: false }); res.json({ ok: true, prolink: getClientState().prolink }); });
  app.post('/api/prolink/toggle',  (_req, res) => { applyPatch({ prolinkEnabled: !state.prolinkEnabled }); res.json({ ok: true, prolink: getClientState().prolink }); });

  // ─── GDTF / Profiles / Fixtures / Show ────────────────────────────────────
  app.post('/api/gdtf/parse', upload.single('gdtf'), asyncHandler(async (req, res) => {
    if (!req.file) return res.status(400).json({ ok: false, error: 'No file uploaded' });
    try {
      const result = await parseGDTF(req.file.buffer);
      res.json({ ok: true, fixture: result });
    } catch (err) {
      console.error('GDTF parse error:', err.message);
      res.status(400).json({ ok: false, error: err.message });
    }
  }));

  app.post('/api/profiles', (req, res) => {
    try {
      const profile = validate(profileSchema, req.body, 'profile');
      if (!registerProfile(profile)) return res.status(400).json({ ok: false, error: 'Invalid profile' });
      integrations.broadcast();
      res.json({ ok: true });
    } catch (err) { res.status(400).json({ ok: false, error: err.message }); }
  });

  app.delete('/api/profiles/:id', (req, res) => {
    const id = req.params.id;
    if (id === BUILTIN_PROFILE_ID) return res.status(400).json({ ok: false, error: 'Cannot remove built-in profile' });
    const inUse = state.fixtures.some((f) => f.profileId === id);
    if (inUse) return res.status(400).json({ ok: false, error: 'Profile is in use by patched fixtures' });
    unregisterProfile(id);
    integrations.broadcast();
    res.json({ ok: true });
  });

  app.post('/api/fixtures', (_req, res) => {
    let maxEnd = 0;
    const profiles = listProfiles();
    for (const fix of state.fixtures) {
      const profile = profiles[fix.profileId] || profiles[BUILTIN_PROFILE_ID];
      const end = fix.address + profile.channelCount;
      if (end > maxEnd) maxEnd = end;
    }
    const newId = state.fixtures.length;
    state.fixtures.push({
      id: newId,
      label: `Fixture ${newId + 1}`,
      address: Math.min(maxEnd, 501),
      profileId: BUILTIN_PROFILE_ID,
      override: null,
    });
    resizeFixtureBuffers();
    integrations.broadcast();
    res.json({ ok: true });
  });

  app.delete('/api/fixtures/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (state.fixtures.length <= 1) return res.status(400).json({ ok: false, error: 'Must have at least one fixture' });
    state.fixtures = state.fixtures.filter((f) => f.id !== id);
    state.fixtures.forEach((f, i) => { f.id = i; });
    resizeFixtureBuffers();
    integrations.broadcast();
    res.json({ ok: true });
  });

  app.get('/api/show', (_req, res) => {
    const profiles = listProfiles();
    res.json({
      artnet: state.artnet,
      profiles: Object.values(profiles).filter((p) => p.id !== BUILTIN_PROFILE_ID),
      fixtures: state.fixtures.map((f) => ({
        label: f.label,
        address: f.address,
        profileId: f.profileId,
      })),
    });
  });

  app.post('/api/show', (req, res) => {
    try {
      const show = validate(showSchema, req.body, 'show');
      if (Array.isArray(show.profiles)) {
        clearNonBuiltinProfiles();
        show.profiles.forEach((p) => { if (p && p.id) registerProfile(p); });
      }
      if (show.artnet) Object.assign(state.artnet, show.artnet);
      const profiles = listProfiles();
      if (Array.isArray(show.fixtures) && show.fixtures.length > 0) {
        state.fixtures = show.fixtures.map((f, i) => ({
          id: i,
          label: f.label || `Fixture ${i + 1}`,
          address: f.address || 1,
          profileId: profiles[f.profileId] ? f.profileId : BUILTIN_PROFILE_ID,
          override: null,
        }));
        resizeFixtureBuffers();
      }
      integrations.broadcast();
      res.json({ ok: true });
    } catch (err) { res.status(400).json({ ok: false, error: err.message }); }
  });

  // ─── Spotify ──────────────────────────────────────────────────────────────
  app.get('/auth/spotify', (_req, res) => {
    if (!spotify.configured) {
      return res.status(400).json({ ok: false, error: 'Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET env vars' });
    }
    res.redirect(spotify.getAuthorizeUrl());
  });

  app.get('/auth/spotify/callback', asyncHandler(async (req, res) => {
    const code = req.query.code;
    if (!code) return res.status(400).send('Missing authorization code');
    try {
      await spotify.exchangeCode(code);
      spotify.startPolling();
      console.log('Spotify authenticated successfully');
      integrations.broadcast();
      res.send('<html><body style="background:#0d0d0f;color:#e8e8f0;font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh"><div style="text-align:center"><h2 style="color:#44ff88">Spotify Connected</h2><p>You can close this window and return to the lightshow.</p><script>setTimeout(()=>window.close(),2000)</script></div></body></html>');
    } catch (err) {
      console.error('Spotify auth error:', err.message);
      res.status(500).send(`Spotify auth failed: ${err.message}`);
    }
  }));

  app.post('/api/spotify/disconnect', (_req, res) => {
    spotify.disconnect();
    integrations.clearSpotifyNext();
    integrations.broadcast();
    res.json({ ok: true });
  });

  app.get('/api/spotify/now-playing', asyncHandler(async (_req, res) => {
    try {
      const playing = await spotify.getCurrentlyPlaying();
      res.json({ ok: true, playing });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  }));

  // ─── Auto-show ────────────────────────────────────────────────────────────
  const { keyForSpotify, keyForYouTube, keyForQuery, keyForLocalFile, keyForBuffer, keyForProlinkTrack } =
    require('../analysis-cache');

  app.post('/api/auto/analyze', asyncHandler(async (req, res) => {
    const { source } = req.body || {};
    if (!source) return res.status(400).json({ ok: false, error: 'Provide a source (file path, URL, or YouTube search)' });

    const isYouTube = /(?:youtube\.com|youtu\.be|music\.youtube)/.test(source);
    const isLocalFile = /^[a-zA-Z]:[\\/]|^\//.test(source);
    const isDirectAudio = /\.(mp3|wav|ogg|flac|m4a|aac|wma)(\?|$)/i.test(source);

    try {
      if (isLocalFile || isDirectAudio) {
        autoShow.track = { name: path.basename(source), artist: 'Local file', album: '', albumArt: null };
        const cacheKey = isLocalFile ? keyForLocalFile(source) : `url:${source}`;
        await autoShow.analyze(source, cacheKey);
      } else {
        autoShow.track = { name: source, artist: '', album: '', albumArt: null };
        integrations.broadcast();
        const cacheKey = keyForYouTube(source) || keyForQuery(source);
        await autoShow.downloadAndAnalyze(source, null, cacheKey);
      }
      integrations.broadcast();
      res.json({ ok: true, analysis: autoShow.getClientState().analysis });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  }));

  app.post('/api/auto/analyze-spotify', asyncHandler(async (_req, res) => {
    if (!spotify.authenticated) return res.status(400).json({ ok: false, error: 'Spotify not connected' });
    try {
      const playing = await spotify.getCurrentlyPlaying();
      if (!playing) return res.status(400).json({ ok: false, error: 'No track currently playing on Spotify' });

      autoShow.track = {
        name: playing.name, artist: playing.artist, album: playing.album,
        albumArt: playing.albumArt, durationMs: playing.durationMs,
      };
      integrations.broadcast();

      const query = `${playing.artist} - ${playing.name}`;
      const cacheKey = keyForSpotify(playing.trackId) || keyForQuery(query);
      await autoShow.downloadAndAnalyze(query, playing.durationMs / 1000, cacheKey, playing.isrc);

      integrations.broadcast();
      res.json({ ok: true, track: autoShow.track, analysis: autoShow.getClientState().analysis });
      integrations.prefetchNextFromQueue();
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
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
      res.status(500).json({ ok: false, error: err.message });
    }
  }));

  app.post('/api/auto/analyze-upload', upload.single('audio'), asyncHandler(async (req, res) => {
    if (!req.file) return res.status(400).json({ ok: false, error: 'No audio file uploaded' });
    const tmpPath = path.join(os.tmpdir(), `auto-analyze-${Date.now()}${path.extname(req.file.originalname) || '.mp3'}`);
    try {
      fs.writeFileSync(tmpPath, req.file.buffer);
      autoShow.track = { name: req.file.originalname, artist: 'Local file', album: '', albumArt: null };
      const cacheKey = keyForBuffer(req.file.buffer);
      await autoShow.analyze(tmpPath, cacheKey);
      integrations.broadcast();
      res.json({ ok: true, track: autoShow.track, analysis: autoShow.getClientState().analysis });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    } finally {
      try { fs.unlinkSync(tmpPath); } catch (_) { /* ignore */ }
    }
  }));

  app.post('/api/auto/analyze-prolink', asyncHandler(async (_req, res) => {
    if (!prolink.connected) return res.status(400).json({ ok: false, error: 'PRO DJ LINK not connected' });
    const track = prolink.getTrack();
    if (!track) return res.status(400).json({ ok: false, error: 'No track loaded on the master CDJ' });
    if (!track.title || !track.artist) return res.status(400).json({ ok: false, error: 'Track has no rekordbox metadata — cannot search' });

    try {
      autoShow.track = {
        name: track.title, artist: track.artist, album: track.album || '',
        albumArt: null, durationMs: track.durationMs || 0,
      };
      integrations.broadcast();

      const query = `${track.artist} - ${track.title}`;
      const cacheKey = keyForProlinkTrack(track);
      const { audioPath } = await autoShow.downloadAndAnalyze(query, (track.durationMs || 0) / 1000, cacheKey);
      if (audioPath) { try { fs.unlinkSync(audioPath); } catch (_) { /* ignore */ } }

      integrations.broadcast();
      res.json({ ok: true, track: autoShow.track, analysis: autoShow.getClientState().analysis });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
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

  app.get('/api/auto/state', (_req, res) => {
    res.json({ ok: true, ...autoShow.getClientState(), spotify: spotify.getStatus() });
  });

  app.get('/api/auto/timeline', (_req, res) => {
    const data = autoShow.getTimelineData();
    if (!data) return res.status(404).json({ ok: false, error: 'No analysis loaded' });
    res.json({ ok: true, data });
  });

  app.get('/api/auto/cache', (_req, res) => {
    res.json({ ok: true, entries: analysisCache.list() });
  });

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
}

module.exports = { attachRoutes };
