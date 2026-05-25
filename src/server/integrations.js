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
  // Slot statuses, one per upcoming track up to state.autoPrefetchDepth.
  // slots[0] is the immediate next track (back-compat with the old
  // spotifyNext shape — that field still mirrors slots[0]).
  // Statuses: idle | prefetching | ready | queued | error | empty | unavailable
  let spotifySlots = [];

  function emptySlot(reason = 'empty', message = 'Queue is empty') {
    return { track: null, status: reason, message, cacheKey: null };
  }

  function spotifyNextView() {
    // Back-compat: callers (and the old UI) read `spotifyNext.track / .status /
    // .message / .cacheKey` directly. Keep that working by mirroring slot 0.
    return spotifySlots[0] || emptySlot('idle', '');
  }

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
      spotifyNext: spotifyNextView(),
      spotifyPrefetch: spotifySlots,
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
    autoPrefetchDepth: () => {
      // Depth change → trim slots that are now out of range and immediately
      // queue prefetches for newly in-range positions.
      const depth = Math.max(1, Math.min(5, state.autoPrefetchDepth || 1));
      if (spotifySlots.length > depth) {
        spotifySlots = spotifySlots.slice(0, depth);
      }
      broadcast();
      if (autoShow.running) prefetchNextFromQueue();
    },
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
   * Peek the Spotify user queue and kick off background prefetches of the
   * next `state.autoPrefetchDepth` upcoming tracks so their analyses are
   * already in the cache when they start playing. The analyzer worker has a
   * FIFO queue so multiple prefetches serialize behind it — depth 5 just
   * means more cache warming over the course of the current song, not
   * concurrent CPU thrash. Safe to call while a show is running.
   */
  async function prefetchNextFromQueue() {
    if (!spotify.authenticated) return;
    lastQueuePeekAt = Date.now();
    const depth = Math.max(1, Math.min(5, state.autoPrefetchDepth || 1));

    try {
      const queue = await spotify.getQueue();
      if (!queue || !queue.length) {
        spotifySlots = [emptySlot('empty', 'Queue is empty')];
        broadcast();
        return;
      }

      // Take the first `depth` valid track entries from the user's queue.
      const upcoming = queue.filter((t) => t && t.trackId).slice(0, depth);
      if (!upcoming.length) {
        spotifySlots = [emptySlot('empty', 'Queue is empty')];
        broadcast();
        return;
      }

      // Snapshot the cacheKeys for this dispatch — `spotifySlots` may be
      // reassigned later if depth changes or the queue rotates, so we use
      // each slot's own cacheKey to detect "is this status callback still
      // relevant?" inside the .then().
      const newSlots = upcoming.map((next) => {
        const query = `${next.artist} - ${next.name}`;
        const cacheKey = keyForSpotify(next.trackId) || keyForQuery(query);
        return {
          track: {
            name: next.name, artist: next.artist, album: next.album,
            albumArt: next.albumArt, durationMs: next.durationMs,
          },
          status: 'prefetching',
          message: 'Prefetching analysis',
          cacheKey,
          _query: query,
          _isrc: next.isrc,
          _durationMs: next.durationMs,
        };
      });
      spotifySlots = newSlots.map(({ _query, _isrc, _durationMs, ...slot }) => slot);
      broadcast();

      // Fire prefetches in order. Each one writes its result back to the
      // matching slot (by cacheKey) so out-of-order completion is harmless.
      for (const seed of newSlots) {
        const { cacheKey, _query, _isrc, _durationMs, track } = seed;
        const meta = { track };
        autoShow.prefetch(_query, (_durationMs || 0) / 1000, cacheKey, meta, _isrc)
          .then((r) => {
            const slot = spotifySlots.find((s) => s.cacheKey === cacheKey);
            if (!slot) return;  // depth shrank or queue rotated past this slot
            if (r.skipped && r.reason === 'already-cached') {
              slot.status = 'ready';
              slot.message = 'Analysis cached';
            } else if (r.skipped && r.reason === 'in-flight') {
              slot.status = 'queued';
              slot.message = 'Prefetch in progress';
            } else if (!r.skipped && !r.error) {
              slot.status = 'ready';
              slot.message = 'Prefetch complete';
              console.log(`[prefetch] ready: ${track.artist} — ${track.name}`);
            } else if (r.error) {
              slot.status = 'error';
              slot.message = r.error;
            }
            broadcast();
          })
          .catch((err) => {
            const slot = spotifySlots.find((s) => s.cacheKey === cacheKey);
            if (slot) {
              slot.status = 'error';
              slot.message = err.message;
              broadcast();
            }
            console.warn(`[prefetch] unexpected error: ${err.message}`);
          });
      }
    } catch (err) {
      spotifySlots = [{ track: null, status: 'error', message: err.message, cacheKey: null }];
      broadcast();
      console.warn(`[prefetch] queue lookup failed: ${err.message}`);
    }
  }

  spotify.onTrackChange(async (playing) => {
    console.log(`Spotify track changed: ${playing.artist} — ${playing.name}`);
    // The track we were prefetching as "next" has become the current track —
    // shift it off the slot list. The remaining slots are still valid (the
    // queue moved up by one) and will be refreshed by the next queue peek.
    if (spotifySlots.length && spotifySlots[0].track
        && spotifySlots[0].track.name === playing.name
        && spotifySlots[0].track.artist === playing.artist) {
      spotifySlots = spotifySlots.slice(1);
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
      spotifySlots = [{ track: null, status: 'unavailable', message: 'Spotify disconnected', cacheKey: null }];
    },
    startAutoShow,
    resolveAutoSource,
    onDeezerPlayback(payload) { deezerSource.updatePlayback(payload); },
    onDeezerDisconnect() { deezerSource.disconnect(); broadcast(); },
  };
}

module.exports = { setupIntegrations };
