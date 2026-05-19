'use strict';

const fs = require('fs');
const { state, getClientState } = require('./state');
const { setHooks, applyPatch } = require('./patch');
const { restartBeatTimer } = require('./engine');
const {
  keyForSpotify,
  keyForDeezer,
  keyForQuery,
  keyForProlinkTrack,
} = require('../analysis-cache');

// Wires the auxiliary subsystems (MIDI feedback, Spotify, Deezer, PRO DJ LINK,
// auto-show) into the engine + state. Returns the integration handle that
// routes.js / sockets.js call back into.
function setupIntegrations({ io, midi, spotify, deezerSource, prolink, autoShow }) {
  let spotifyNext = {
    track: null,
    status: 'idle', // idle | prefetching | ready | queued | error | empty | unavailable
    message: '',
    cacheKey: null,
  };

  let autoPlayback = { progressMs: 0, isPlaying: false, updatedAt: 0 };

  // Throttle for the queue-lookahead poll.
  let lastQueuePeekAt = 0;
  const QUEUE_PEEK_INTERVAL_MS = 15000;

  function getAutoPositionMs() {
    if (!autoPlayback.isPlaying) return autoPlayback.progressMs;
    return autoPlayback.progressMs + (Date.now() - autoPlayback.updatedAt);
  }

  function getProlinkPositionMs() { return prolink.getPositionMs(); }

  function broadcast() {
    io.emit('state', getClientState());
    midi.sendFeedback();
  }

  // Inject the heavy "extras" the UI needs (autoShow / spotify / deezer /
  // prolink) into the snapshot getClientState() builds.
  function extras() {
    return {
      spotify: spotify.getStatus(),
      spotifyNext,
      deezer: {
        ...deezerSource.getStatus(),
        appId: process.env.DEEZER_APP_ID || '',
      },
      prolink: {
        enabled: state.prolinkEnabled,
        connected: prolink.connected,
        peers: prolink.getNumPeers(),
        master: prolink.getMaster(),
        track: prolink.getTrack(),
        loadedTracks: prolink.getLoadedTracks(),
        bpm: prolink.getTempo(),
        stale: prolink.stale,
        lastError: prolink.lastError,
      },
      autoShow: autoShow.getClientState(),
      midi: { enabled: midi.enabled, ports: midi.listPorts() },
    };
  }
  require('./state').setExtrasProvider(extras);

  // Hook the patch module so it can react to higher-level concerns.
  setHooks({
    broadcast,
    prolinkEnable: () => {
      prolink.enable().catch((err) => {
        console.error('PRO DJ LINK enable failed:', err.message);
        state.prolinkEnabled = false;
        broadcast();
      });
    },
    prolinkDisable: () => {
      prolink.disable().catch(() => { /* ignore */ });
    },
    autoPaletteSize: (n) => autoShow.setPaletteSize(Number(n)),
    autoIntensity: (n) => autoShow.setIntensity(Number(n)),
  });

  // Pick the active source for auto-show playback. Explicit user choice wins,
  // then 'auto' falls through to: prolink > spotify > deezer > timer.
  function resolveAutoSource() {
    if (state.autoSource === 'prolink' && prolink.connected) return 'prolink';
    if (state.autoSource === 'spotify' && spotify.authenticated) return 'spotify';
    if (state.autoSource === 'deezer' && deezerSource.authenticated) return 'deezer';
    if (state.autoSource === 'timer') return 'timer';
    if (prolink.connected && prolink.getMaster()) return 'prolink';
    if (spotify.authenticated) return 'spotify';
    if (deezerSource.authenticated) return 'deezer';
    return 'timer';
  }

  function startAutoShow() {
    const source = resolveAutoSource();
    if (source === 'prolink') {
      autoShow.start(getProlinkPositionMs);
    } else if (source === 'spotify') {
      spotify.startPolling(1000);
      autoShow.start(getAutoPositionMs);
    } else if (source === 'deezer') {
      autoShow.start(getAutoPositionMs);
    } else {
      const startTime = Date.now();
      autoShow.start(() => Date.now() - startTime);
    }
    return source;
  }

  // ─── Prolink callbacks ──────────────────────────────────────────────────
  prolink.onTempoChange((bpm) => {
    if (!state.prolinkEnabled) return;
    const rounded = Math.round(bpm);
    if (rounded >= 20 && rounded <= 300 && rounded !== state.bpm) {
      state.bpm = rounded;
      restartBeatTimer();
      broadcast();
    }
  });
  prolink.onPeersChange((peers) => {
    console.log(`PRO DJ LINK devices: ${peers}`);
    io.emit('state', getClientState());
  });
  prolink.onMasterChange(() => broadcast());
  prolink.onTrackChange(async (track) => {
    console.log(`PRO DJ LINK track changed: ${track.artist || '?'} — ${track.title || '?'}`);
    broadcast();
    if (!autoShow.running) return;
    if (resolveAutoSource() !== 'prolink') return;

    autoShow.stop();
    autoShow.track = {
      name: track.title || `Track ${track.trackId}`,
      artist: track.artist || 'PRO DJ LINK',
      album: track.album || '',
      albumArt: null,
      durationMs: track.durationMs || 0,
    };
    broadcast();
    try {
      if (!track.title || !track.artist) {
        throw new Error('Track has no rekordbox metadata — cannot search');
      }
      const query = `${track.artist} - ${track.title}`;
      const cacheKey = keyForProlinkTrack(track);
      const { audioPath } = await autoShow.downloadAndAnalyze(
        query, (track.durationMs || 0) / 1000, cacheKey,
      );
      if (audioPath) { try { fs.unlinkSync(audioPath); } catch (_) { /* ignore */ } }
      autoShow.start(getProlinkPositionMs);
      console.log('Auto show restarted for new CDJ track');
    } catch (err) {
      console.error('PRO DJ LINK auto analysis failed:', err.message);
    }
    broadcast();
  });
  prolink.onLoadedTracksChange(() => broadcast());

  // Prefetch analysis for every track loaded on any CDJ. Fires once per unique
  // track identity (deviceId:slot:trackId) per session — duplicates skipped.
  prolink.onAnyTrackLoaded((track) => {
    if (!track.title || !track.artist) return;
    const cacheKey = keyForProlinkTrack(track);
    if (!cacheKey) return;
    const query = `${track.artist} - ${track.title}`;
    const durationSec = track.durationMs ? track.durationMs / 1000 : null;
    const meta = { title: track.title, artist: track.artist };
    autoShow.prefetch(query, durationSec, cacheKey, meta)
      .then((r) => {
        if (r.skipped) return;
        if (r.error) console.warn(`[prolink] prefetch failed for "${query}": ${r.error}`);
        else console.log(`[prolink] prefetched: ${query}`);
      })
      .catch(() => { /* ignore */ });
  });

  // ─── Spotify polling ────────────────────────────────────────────────────
  spotify.onPlaybackUpdate((playing) => {
    if (resolveAutoSource() !== 'spotify') return;
    autoPlayback.progressMs = playing.progressMs;
    autoPlayback.isPlaying = playing.isPlaying;
    autoPlayback.updatedAt = Date.now();

    if (autoShow.running && Date.now() - lastQueuePeekAt >= QUEUE_PEEK_INTERVAL_MS) {
      lastQueuePeekAt = Date.now();
      prefetchNextFromQueue();
    }
  });

  /**
   * Peek the Spotify user queue and kick off a background prefetch of the next
   * upcoming track so its analysis is already in the cache when it starts
   * playing. Safe to call while a show is running — does not touch state.
   */
  async function prefetchNextFromQueue() {
    if (!spotify.authenticated) return;
    lastQueuePeekAt = Date.now();
    try {
      const queue = await spotify.getQueue();
      if (!queue || !queue.length) {
        spotifyNext = { track: null, status: 'empty', message: 'Queue is empty', cacheKey: null };
        broadcast();
        return;
      }
      const next = queue[0];
      if (!next || !next.trackId) {
        spotifyNext = { track: null, status: 'empty', message: 'Queue is empty', cacheKey: null };
        broadcast();
        return;
      }

      const query = `${next.artist} - ${next.name}`;
      const cacheKey = keyForSpotify(next.trackId) || keyForQuery(query);
      spotifyNext = {
        track: {
          name: next.name, artist: next.artist, album: next.album,
          albumArt: next.albumArt, durationMs: next.durationMs,
        },
        status: 'prefetching',
        message: 'Prefetching analysis',
        cacheKey,
      };
      broadcast();

      const meta = {
        track: {
          name: next.name, artist: next.artist, album: next.album,
          albumArt: next.albumArt, durationMs: next.durationMs,
        },
      };
      autoShow.prefetch(query, (next.durationMs || 0) / 1000, cacheKey, meta, next.isrc)
        .then((r) => {
          if (spotifyNext.cacheKey !== cacheKey) return;
          if (r.skipped && r.reason === 'already-cached') {
            spotifyNext.status = 'ready';
            spotifyNext.message = 'Analysis cached';
            console.log(`[prefetch] next queued track already cached: ${next.artist} — ${next.name}`);
          } else if (r.skipped && r.reason === 'in-flight') {
            spotifyNext.status = 'queued';
            spotifyNext.message = 'Prefetch in progress';
          } else if (!r.skipped && !r.error) {
            spotifyNext.status = 'ready';
            spotifyNext.message = 'Prefetch complete';
            console.log(`[prefetch] ready for next queued track: ${next.artist} — ${next.name}`);
          } else if (r.error) {
            spotifyNext.status = 'error';
            spotifyNext.message = r.error;
          }
          broadcast();
        })
        .catch((err) => {
          if (spotifyNext.cacheKey === cacheKey) {
            spotifyNext.status = 'error';
            spotifyNext.message = err.message;
            broadcast();
          }
          console.warn(`[prefetch] unexpected error: ${err.message}`);
        });
    } catch (err) {
      spotifyNext = { track: null, status: 'error', message: err.message, cacheKey: null };
      broadcast();
      console.warn(`[prefetch] queue lookup failed: ${err.message}`);
    }
  }

  spotify.onTrackChange(async (playing) => {
    console.log(`Spotify track changed: ${playing.artist} — ${playing.name}`);
    if (spotifyNext.track && spotifyNext.track.name === playing.name && spotifyNext.track.artist === playing.artist) {
      spotifyNext = { track: null, status: 'idle', message: '', cacheKey: null };
    }
    if (resolveAutoSource() !== 'spotify') return;
    if (autoShow.running) {
      autoShow.stop();
      autoShow.track = {
        name: playing.name, artist: playing.artist, album: playing.album,
        albumArt: playing.albumArt, durationMs: playing.durationMs,
      };
      broadcast();
      try {
        const query = `${playing.artist} - ${playing.name}`;
        const cacheKey = keyForSpotify(playing.trackId) || keyForQuery(query);
        await autoShow.downloadAndAnalyze(query, playing.durationMs / 1000, cacheKey, playing.isrc);
        autoShow.start(getAutoPositionMs);
        console.log('Auto show restarted for new track');
      } catch (err) {
        console.error('Auto show analysis failed for new track:', err.message);
      }
      broadcast();
      prefetchNextFromQueue();
    }
  });

  // ─── Deezer (browser-driven) ────────────────────────────────────────────
  deezerSource.onPlaybackUpdate((playing) => {
    if (resolveAutoSource() !== 'deezer') return;
    autoPlayback.progressMs = playing.progressMs;
    autoPlayback.isPlaying = playing.isPlaying;
    autoPlayback.updatedAt = Date.now();
  });

  deezerSource.onTrackChange(async (playing) => {
    console.log(`Deezer track changed: ${playing.artist} — ${playing.name}`);
    if (resolveAutoSource() !== 'deezer') return;
    if (!autoShow.running) return;

    autoShow.stop();
    autoShow.track = {
      name: playing.name, artist: playing.artist, album: playing.album,
      albumArt: playing.albumArt, durationMs: playing.durationMs,
    };
    broadcast();
    try {
      const query = `${playing.artist} - ${playing.name}`;
      const cacheKey = keyForDeezer(playing.trackId) || keyForQuery(query);
      await autoShow.downloadAndAnalyze(query, playing.durationMs / 1000, cacheKey, playing.isrc);
      autoShow.start(getAutoPositionMs);
      console.log('Auto show restarted for new Deezer track');
    } catch (err) {
      console.error('Deezer auto analysis failed for new track:', err.message);
    }
    broadcast();
  });

  // Broadcast playback position for the timeline visualiser at ~10 Hz.
  setInterval(() => {
    if (!autoShow.running) return;
    io.emit('auto-position', { positionMs: autoShow.getPositionMs(), running: true });
  }, 100);

  // Periodic state broadcast at ~10 Hz so the DMX monitor and live overlays
  // stay fresh even without explicit state changes.
  setInterval(() => io.emit('state', getClientState()), 100);

  return {
    broadcast,
    prefetchNextFromQueue,
    clearSpotifyNext: () => {
      spotifyNext = { track: null, status: 'unavailable', message: 'Spotify disconnected', cacheKey: null };
    },
    startAutoShow,
    resolveAutoSource,
    onDeezerPlayback(payload) { deezerSource.updatePlayback(payload); },
    onDeezerDisconnect() { deezerSource.disconnect(); broadcast(); },
  };
}

module.exports = { setupIntegrations };
