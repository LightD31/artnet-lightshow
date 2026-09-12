'use strict';

const { state, getLiveState, getDmxSnapshot } = require('./state');
const { setHooks } = require('./patch');
const { restartBeatTimer } = require('./engine');
const { cues } = require('./cues');
const { Warmer } = require('./warm');
const {
  keyForSpotify,
  keyForQuery,
  keyForProlinkTrack,
} = require('../analysis-cache');
const HybridSource = require('../hybrid-source');

// A track change that lands while the previous track is still being analysed
// hands the analyser to the new song and abandons the old job. That is the
// priority rule working, not a failure — say so without crying error.
function reportAnalysisError(label, err) {
  if (err && err.superseded) console.log(`[auto-show] ${label} dropped: ${err.message}`);
  else console.error(`${label}:`, err.message);
}

// Wires the auxiliary subsystems (MIDI feedback, Spotify, now-playing, PRO DJ
// LINK, auto-show) into the engine + state. Returns the integration handle that
// routes.js / sockets.js call back into.
function setupIntegrations({ io, midi, spotify, nowPlaying, deezerSource, prolink, autoShow }) {
  // Slot statuses, one per upcoming track up to state.autoPrefetchDepth.
  // slots[0] is the immediate next track (back-compat with the old
  // spotifyNext shape — that field still mirrors slots[0]).
  // Statuses: idle | prefetching | ready | queued | error | empty | unavailable
  let spotifySlots = [];

  // Deezer prefetch slots (same shape/UI as spotifySlots), fed from the
  // extension's queue. lastDeezerQueueSig avoids rebuilding (and flickering
  // statuses) on every 1 Hz update when the queue hasn't actually changed.
  let deezerSlots = [];
  let lastDeezerSlotsSig = '';

  function emptySlot(reason = 'empty', message = 'Queue is empty') {
    return { track: null, status: reason, message, cacheKey: null };
  }

  function spotifyNextView() {
    // Back-compat: callers (and the old UI) read `spotifyNext.track / .status /
    // .message / .cacheKey` directly. Keep that working by mirroring slot 0.
    return spotifySlots[0] || emptySlot('idle', '');
  }

  const autoPlayback = { progressMs: 0, isPlaying: false, updatedAt: 0 };

  // Spotify for the content and the queue, the OS media session for the clock.
  // Fed from both sets of callbacks below; it decides for itself which half is
  // currently able to drive.
  const hybrid = new HybridSource();

  // Set-list warming: analyses a whole night ahead of time rather than relying
  // on the live queue lookahead, which only sees one to five tracks and only
  // once something is playing. Progress rides the state broadcast.
  const warmer = new Warmer({ autoShow, onChange: () => broadcast() });

  // Throttle for the queue-lookahead poll.
  let lastQueuePeekAt = 0;
  const QUEUE_PEEK_INTERVAL_MS = 15000;

  function getAutoPositionMs() {
    if (!autoPlayback.isPlaying) return autoPlayback.progressMs;
    return autoPlayback.progressMs + (Date.now() - autoPlayback.updatedAt);
  }

  function getProlinkPositionMs() { return prolink.getPositionMs(); }

  function getHybridPositionMs() { return hybrid.getPositionMs(); }

  // Last live payload we sent, as JSON. Used to skip re-sending an identical
  // snapshot.
  let lastLiveJson = '';

  function broadcast() {
    const live = getLiveState();
    const json = JSON.stringify(live);
    if (json !== lastLiveJson) {
      lastLiveJson = json;
      io.emit('state', live);
    }
    midi.sendFeedback();
  }


  // Inject the heavy "extras" the UI needs (autoShow / spotify / nowPlaying /
  // prolink) into the snapshot getClientState() builds.
  function extras() {
    return {
      spotify: spotify.getStatus(),
      spotifyNext: spotifyNextView(),
      spotifyPrefetch: spotifySlots,
      nowPlaying: nowPlaying.getStatus(),
      hybrid: hybrid.getStatus(),
      // Which source is *actually* driving right now. `state.autoSource` is
      // the operator's choice, which is often 'auto' and so says nothing about
      // what is happening; this is the answer to "why is the show following
      // that".
      activeSource: resolveAutoSource(),
      deezer: deezerSource.getStatus(),
      deezerPrefetch: deezerSlots,
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
      // Summaries, not the stored looks: a hundred full cues would ride every
      // broadcast, and the buttons only need a name and a swatch.
      cues: cues.summaries(),
      warm: warmer.status(),
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
    autoPaletteSize: (n) => autoShow.setPaletteSize(n === 'auto' ? 'auto' : Number(n)),
    autoIntensity: (n) => autoShow.setIntensity(Number(n)),
    autoSyncOffsetMs: (n) => autoShow.setSyncOffsetMs(Number(n)),
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
  // then 'auto' falls through to:
  //   prolink > hybrid > spotify > deezer > nowplaying > timer
  //
  // Hybrid outranks plain Spotify whenever the OS media session is also live,
  // because it is the same source of content with a better clock and an
  // automatic fallback to exactly the Spotify behaviour when the session stops
  // matching — there is no state in which it is the worse of the two.
  //
  // Deezer (extension) outranks generic SMTC: when Deezer plays in the browser
  // both see it, but the extension carries ISRC + queue, so it should win.
  function resolveAutoSource() {
    if (state.autoSource === 'prolink' && prolink.connected) return 'prolink';
    // Hybrid asks only for Spotify: without the OS session it degrades to the
    // Spotify clock rather than refusing to run, which is what the operator
    // picking it would want on a machine where SMTC is unavailable.
    if (state.autoSource === 'hybrid' && spotify.authenticated) return 'hybrid';
    if (state.autoSource === 'spotify' && spotify.authenticated) return 'spotify';
    if (state.autoSource === 'deezer' && deezerSource.authenticated) return 'deezer';
    if (state.autoSource === 'nowplaying' && nowPlaying.authenticated) return 'nowplaying';
    if (state.autoSource === 'timer') return 'timer';
    if (prolink.connected && prolink.getMaster()) return 'prolink';
    if (spotify.authenticated && nowPlaying.authenticated) return 'hybrid';
    if (spotify.authenticated) return 'spotify';
    if (deezerSource.authenticated) return 'deezer';
    if (nowPlaying.authenticated) return 'nowplaying';
    return 'timer';
  }

  /** Sources that take their content and their queue from Spotify. */
  function usesSpotifyContent(source) {
    return source === 'spotify' || source === 'hybrid';
  }

  function startAutoShow() {
    const source = resolveAutoSource();
    if (source === 'prolink') {
      autoShow.start(getProlinkPositionMs);
    } else if (source === 'hybrid') {
      spotify.startPolling(1000);
      autoShow.start(getHybridPositionMs);
    } else if (source === 'spotify') {
      spotify.startPolling(1000);
      autoShow.start(getAutoPositionMs);
    } else if (source === 'deezer' || source === 'nowplaying') {
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
    broadcast();
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
      // The downloaded WAV is unlinked by auto-show's own finally block.
      await autoShow.downloadAndAnalyze(query, (track.durationMs || 0) / 1000, cacheKey);
      autoShow.start(getProlinkPositionMs);
      console.log('Auto show restarted for new CDJ track');
    } catch (err) {
      reportAnalysisError('PRO DJ LINK auto analysis failed', err);
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
    // Fed to the hybrid source unconditionally, whichever source is active, so
    // that switching to it mid-show does not start from a cold clock. It only
    // ever *reads* Spotify's position when the OS session cannot supply one.
    hybrid.observeContent(playing);

    if (!usesSpotifyContent(resolveAutoSource())) return;
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
   * already in the cache when they start playing. The analyzer worker serves
   * one at a time, in queue order, so multiple prefetches serialize behind it —
   * depth 5 just means more cache warming over the course of the current song,
   * not concurrent CPU thrash — and the song that starts playing interrupts
   * whichever one is running. Safe to call while a show is running.
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

      // Re-rank prefetches that are already waiting before adding to them: the
      // queue may have reshaped since the last peek, and the track that is now
      // next must not sit behind one the listener pushed further down.
      autoShow.applyQueueOrder(newSlots.map((s) => s.cacheKey));

      // Fire prefetches in queue order, and tell the analyzer that order so a
      // deeper slot can't delay a nearer one. Each one writes its result back
      // to the matching slot (by cacheKey) so out-of-order completion is
      // harmless.
      for (const [queuePos, seed] of newSlots.entries()) {
        const { cacheKey, _query, _isrc, _durationMs, track } = seed;
        const meta = { track };
        autoShow.prefetch(_query, (_durationMs || 0) / 1000, cacheKey, meta, _isrc, 'normal', queuePos)
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
    const source = resolveAutoSource();
    if (!usesSpotifyContent(source)) return;
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
        autoShow.start(source === 'hybrid' ? getHybridPositionMs : getAutoPositionMs);
        console.log('Auto show restarted for new track');
      } catch (err) {
        reportAnalysisError('Auto show analysis failed for new track', err);
      }
      broadcast();
      prefetchNextFromQueue();
    }
  });

  // ─── Now playing (OS media session) ─────────────────────────────────────
  nowPlaying.onPlaybackUpdate((playing) => {
    // The clock half of the hybrid source. Offered whatever the active source
    // is; `hybrid` itself decides whether this session is the track Spotify
    // says is playing and ignores it when it is not.
    hybrid.observeSession(playing);

    if (resolveAutoSource() !== 'nowplaying') return;
    autoPlayback.progressMs = playing.progressMs;
    autoPlayback.isPlaying = playing.isPlaying;
    autoPlayback.updatedAt = Date.now();
  });

  nowPlaying.onTrackChange(async (playing) => {
    console.log(`Now playing changed: ${playing.artist} — ${playing.name}`);
    if (resolveAutoSource() !== 'nowplaying') return;
    if (!autoShow.running) return;

    autoShow.stop();
    autoShow.track = {
      name: playing.name, artist: playing.artist, album: playing.album,
      albumArt: playing.albumArt, durationMs: playing.durationMs,
    };
    broadcast();
    try {
      const query = `${playing.artist} - ${playing.name}`;
      const cacheKey = keyForQuery(query);
      await autoShow.downloadAndAnalyze(query, playing.durationMs / 1000, cacheKey, playing.isrc);
      autoShow.start(getAutoPositionMs);
      console.log('Auto show restarted for new now-playing track');
    } catch (err) {
      reportAnalysisError('Now-playing auto analysis failed for new track', err);
    }
    broadcast();
  });

  // ─── Deezer (browser extension) ─────────────────────────────────────────
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
      const cacheKey = keyForQuery(query);
      // ISRC → exact Deezer audio via src/deezer.js (falls back to yt-dlp).
      await autoShow.downloadAndAnalyze(query, playing.durationMs / 1000, cacheKey, playing.isrc);
      autoShow.start(getAutoPositionMs);
      console.log('Auto show restarted for new Deezer track');
    } catch (err) {
      reportAnalysisError('Deezer auto analysis failed for new track', err);
    }
    broadcast();
  });

  // Build prefetch slots for the upcoming Deezer queue (the extension can see
  // it; SMTC can't) and warm the analysis cache, mirroring the Spotify "up
  // next" list. Only when Deezer is the active source, so we don't burn the
  // analyzer while another source drives the show. autoShow.prefetch dedupes on
  // cache + in-flight, so re-running is cheap.
  function prefetchDeezerQueue() {
    if (resolveAutoSource() !== 'deezer') {
      if (deezerSlots.length) { deezerSlots = []; lastDeezerSlotsSig = ''; broadcast(); }
      return;
    }
    const depth = Math.max(1, Math.min(5, state.autoPrefetchDepth || 1));
    const upcoming = deezerSource.getQueue().slice(0, depth);

    // Derive each slot's status SYNCHRONOUSLY from the cache/in-flight state
    // instead of a one-shot prefetch result. The extension POSTs at ~1 Hz and
    // Deezer's queue (esp. Flow/radio) reshapes the list constantly; deriving
    // from real state means a cached track is always 'ready' with no prefetch
    // job — so it can never blip back to 'prefetching'. Only a genuinely new
    // (uncached, not-yet-running) track kicks off a prefetch.

    // Deezer's queue reshapes constantly (Flow and radio rebuild the tail), so
    // re-rank the prefetches already waiting to the list as it stands now.
    autoShow.applyQueueOrder(upcoming.map((t) => keyForQuery(`${t.artist} - ${t.name}`)));

    const slots = upcoming.map((t, queuePos) => {
      const query = `${t.artist} - ${t.name}`;
      const cacheKey = keyForQuery(query);
      const cached = autoShow.isCached(cacheKey);
      if (!cached && !autoShow.isPrefetching(cacheKey)) {
        autoShow.prefetch(query, (t.durationMs || 0) / 1000, cacheKey, { track: { name: t.name, artist: t.artist } }, t.isrc, 'normal', queuePos)
          .then((r) => { if (!r.skipped && !r.error) console.log(`[deezer] prefetched: ${query}`); })
          .catch(() => { /* ignore */ });
      }
      return {
        track: { name: t.name, artist: t.artist, album: '', albumArt: null, durationMs: t.durationMs },
        status: cached ? 'ready' : 'prefetching',
        message: cached ? 'Analysis cached' : 'Prefetching analysis',
        cacheKey,
      };
    });

    // Only broadcast when the rendered list (tracks + statuses) actually
    // changed, so the 1 Hz updates don't spam identical state.
    const sig = slots.map((s) => `${s.cacheKey}:${s.status}`).join('|');
    deezerSlots = slots;
    if (sig === lastDeezerSlotsSig) return;
    lastDeezerSlotsSig = sig;
    broadcast();
  }

  // Broadcast playback position for the timeline visualiser at ~10 Hz.
  //
  // These three timers are unref'd: the HTTP listener is what keeps the server
  // alive, and a status sweep should not be the thing holding the process open.
  // It also means a test can wire the integrations up without the run hanging
  // afterwards on a heartbeat nobody is listening to.
  const positionTimer = setInterval(() => {
    if (!autoShow.running) return;
    io.emit('auto-position', { positionMs: autoShow.getPositionMs(), running: true });
  }, 100);
  if (positionTimer.unref) positionTimer.unref();

  // DMX values on their own high-rate channel. This is the only field that
  // genuinely changes every frame; sending it alone keeps the 10 Hz payload at
  // ~100 bytes instead of ~7 KB, and lets the client re-render just the DMX
  // views instead of the whole tree.
  let lastDmxJson = '';
  const dmxTimer = setInterval(() => {
    const snapshot = getDmxSnapshot();
    const json = JSON.stringify(snapshot);
    if (json === lastDmxJson) return;      // blackout / idle rig: nothing to send
    lastDmxJson = json;
    io.emit('dmx', snapshot);
  }, 100);
  if (dmxTimer.unref) dmxTimer.unref();

  // Some status fields drift without any explicit event — `authenticated` on
  // the now-playing and Deezer sources expires on a staleness timer, and
  // Spotify's poll updates status without calling broadcast(). A low-rate
  // dirty-checked sweep picks those up; broadcast() covers everything else the
  // moment it changes.
  const statusTimer = setInterval(broadcast, 1000);
  if (statusTimer.unref) statusTimer.unref();

  return {
    broadcast,
    warmer,
    hybrid,
    prefetchNextFromQueue,
    clearSpotifyNext: () => {
      spotifySlots = [{ track: null, status: 'unavailable', message: 'Spotify disconnected', cacheKey: null }];
    },
    startAutoShow,
    resolveAutoSource,
    // Called by the Deezer browser extension (via routes) with the web player's
    // current track + upcoming queue.
    onDeezerState(payload) {
      if (!payload) return;
      if (payload.current) deezerSource.updatePlayback(payload.current);
      deezerSource.updateQueue(payload.upcoming || []);
      prefetchDeezerQueue();
    },
    onDeezerDisconnect() {
      deezerSource.disconnect();
      deezerSlots = [];
      lastDeezerSlotsSig = '';
      broadcast();
    },
  };
}

module.exports = { setupIntegrations };
