'use strict';

/**
 * PRO DJ LINK wrapper around the `prolink-connect` package.
 *
 * Mirrors the shape of src/spotify.js so server.js can hook into the same
 * autoShow pipeline that already drives the Spotify flow:
 *
 *   - onTempoChange(bpm)        → state.bpm sync (like Ableton Link did)
 *   - onPeersChange(count)      → UI peer counter
 *   - onMasterChange(info)      → master CDJ or trackId changed
 *   - onTrackChange(track)      → AFTER metadata has been resolved from rekordbox
 *   - getPositionMs()           → callback handed to autoShow.start()
 *
 * Position derivation is anchored to the master CDJ's `beat` counter (the beat
 * 'timestamp' from each status packet) plus the track's beat grid (offsets in
 * ms). Between status packets we extrapolate using the local wall clock — each
 * incoming beat re-anchors, so pitch / nudge / scratch / seek all snap within
 * one auto-show tick (20 ms).
 *
 * The package is CommonJS (verified at install time), so we can require() it
 * directly. If the require fails (wrong Node version, package corrupt) the
 * wrapper degrades gracefully: enable() rejects, the rest of the app keeps
 * working.
 */

let prolink = null;
let CDJStatus = null;
let MediaSlot = null;
let TrackType = null;
try {
  // eslint-disable-next-line global-require
  prolink = require('prolink-connect');
  CDJStatus = prolink.CDJStatus; // PlayState enum lives here
  MediaSlot = prolink.MediaSlot;
  TrackType = prolink.TrackType;
} catch (err) {
  console.error('[prolink] failed to load prolink-connect:', err.message);
}

const STALE_PACKET_MS = 5000;

class ProLink {
  constructor() {
    this._network = null;
    this._enabled = false;
    this._connected = false;
    this._lastError = null;
    this._peers = 0;

    // Master state
    this._masterDeviceId = null;
    this._masterTrackId = null;
    this._masterSlot = null;
    this._masterTrackType = null;
    this._masterBpm = 0;          // effective BPM (with pitch)
    this._masterTrackBpm = 0;     // raw track BPM
    this._masterPitch = 0;        // percent
    this._masterBeatInMeasure = 0;
    this._masterPlayState = 0;

    // Position tracking
    this._lastBeat = null;        // beat counter from latest packet
    this._lastBeatAtMs = 0;       // local Date.now() when _lastBeat was captured
    this._lastPacketAtMs = 0;
    this._beatGrid = null;        // Array<{offset_ms, count, bpm}>, one entry per beat
    this._trackDurationMs = 0;
    this._frozenPositionMs = 0;
    this._lastComputedPositionMs = 0;
    this._stale = false;

    // Resolved metadata for the current master track
    this._track = null;           // { trackId, deviceId, slot, title, artist, album, durationMs }

    // Listeners
    this._onTempoChange = null;
    this._onPeersChange = null;
    this._onMasterChange = null;
    this._onTrackChange = null;
  }

  // ── Public getters ──────────────────────────────────────────────────────────

  get enabled() { return this._enabled; }
  get connected() { return this._connected; }
  get lastError() { return this._lastError; }
  get stale() { return this._stale; }

  getNumPeers() { return this._peers; }
  getTempo() { return this._masterBpm || 0; }

  getMaster() {
    if (this._masterDeviceId == null) return null;
    return {
      deviceId: this._masterDeviceId,
      trackId: this._masterTrackId,
      slot: this._masterSlot,
      bpm: this._masterBpm,
      trackBpm: this._masterTrackBpm,
      pitch: this._masterPitch,
      beat: this._lastBeat,
      beatInMeasure: this._masterBeatInMeasure,
      playState: this._masterPlayState,
    };
  }

  getTrack() { return this._track; }

  /** Position in ms within the loaded master track. 0 when nothing is playing. */
  getPositionMs() {
    if (!this._masterTrackId) return 0;

    // Stale-packet cutoff: master may have gone away. Freeze, don't drift.
    if (this._lastPacketAtMs && Date.now() - this._lastPacketAtMs > STALE_PACKET_MS) {
      this._stale = true;
      return this._lastComputedPositionMs || 0;
    }
    this._stale = false;

    // Paused / Cued → frozen at the moment of the transition
    if (this._isFrozenState(this._masterPlayState)) {
      return this._frozenPositionMs;
    }

    if (this._lastBeat == null) return 0;

    const baseMs = this._beatMsFromGrid(this._lastBeat);
    const elapsed = Date.now() - this._lastBeatAtMs;
    const pos = baseMs + elapsed;
    this._lastComputedPositionMs = pos;
    return pos;
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  async enable() {
    if (!prolink) {
      const err = new Error('prolink-connect not available — check Node version (need >= 20)');
      this._lastError = err.message;
      throw err;
    }
    if (this._enabled) return;

    this._enabled = true;
    this._lastError = null;

    try {
      this._network = await prolink.bringOnline();
      // Wait for any device to show up so we can determine the right NIC.
      // This will hang forever if no CDJs are present, so we timeout it.
      await this._withTimeout(this._network.autoconfigFromPeers(), 10000, 'autoconfig timeout (no devices found on the network)');
      this._network.connect();
      this._connected = true;

      // Status updates
      const statusEmitter = this._network.statusEmitter;
      if (!statusEmitter) {
        throw new Error('statusEmitter unavailable after connect()');
      }
      this._statusHandler = (s) => this._onStatus(s);
      statusEmitter.on('status', this._statusHandler);

      // Device list updates → peer count
      const dm = this._network.deviceManager;
      if (dm) {
        const updatePeers = () => {
          const next = dm.devices ? dm.devices.size : 0;
          if (next !== this._peers) {
            this._peers = next;
            if (this._onPeersChange) this._onPeersChange(this._peers);
          }
        };
        this._connectedHandler = () => updatePeers();
        this._disconnectedHandler = () => updatePeers();
        dm.on('connected', this._connectedHandler);
        dm.on('disconnected', this._disconnectedHandler);
        updatePeers();
      }

      console.log('[prolink] connected to PRO DJ LINK network');
    } catch (err) {
      this._lastError = err.message;
      this._connected = false;
      this._enabled = false;
      // Attempt cleanup so a retry can rebind sockets
      try { if (this._network && this._network.disconnect) await this._network.disconnect(); } catch (_) {}
      this._network = null;
      console.error('[prolink] enable failed:', err.message);
      throw err;
    }
  }

  async disable() {
    if (!this._enabled && !this._connected) return;
    this._enabled = false;
    this._connected = false;

    try {
      if (this._network) {
        const se = this._network.statusEmitter;
        if (se && this._statusHandler) se.off('status', this._statusHandler);
        const dm = this._network.deviceManager;
        if (dm && this._connectedHandler) dm.off('connected', this._connectedHandler);
        if (dm && this._disconnectedHandler) dm.off('disconnected', this._disconnectedHandler);
        if (this._network.disconnect) await this._network.disconnect();
      }
    } catch (err) {
      console.error('[prolink] disable cleanup error:', err.message);
    } finally {
      this._network = null;
      this._statusHandler = null;
      this._connectedHandler = null;
      this._disconnectedHandler = null;
      this._resetMaster();
      this._peers = 0;
      console.log('[prolink] disconnected');
    }
  }

  destroy() {
    // Fire-and-forget; don't await on shutdown.
    this.disable().catch(() => {});
  }

  // ── Listeners ───────────────────────────────────────────────────────────────

  onTempoChange(fn)  { this._onTempoChange  = fn; }
  onPeersChange(fn)  { this._onPeersChange  = fn; }
  onMasterChange(fn) { this._onMasterChange = fn; }
  onTrackChange(fn)  { this._onTrackChange  = fn; }

  // ── Status packet handler ───────────────────────────────────────────────────

  _onStatus(s) {
    if (!s) return;
    this._lastPacketAtMs = Date.now();

    // Only the master drives our state. Ignore packets from non-master devices.
    if (!s.isMaster) return;

    // Effective BPM = trackBPM * (1 + effectivePitch / 100). prolink-connect
    // reports pitch in percent (e.g. -6.0 = -6%, +6.0 = +6%).
    const trackBpm = (typeof s.trackBPM === 'number' && isFinite(s.trackBPM)) ? s.trackBPM : 0;
    const pitchPct = (typeof s.effectivePitch === 'number') ? s.effectivePitch : 0;
    const effectiveBpm = trackBpm > 0 ? trackBpm * (1 + pitchPct / 100) : 0;

    const trackChanged =
      s.trackDeviceId !== this._masterDeviceId ||
      s.trackId !== this._masterTrackId ||
      s.trackSlot !== this._masterSlot;

    if (trackChanged) {
      this._resetMaster();
      this._masterDeviceId = s.trackDeviceId;
      this._masterTrackId = s.trackId;
      this._masterSlot = s.trackSlot;
      this._masterTrackType = s.trackType;
      if (this._onMasterChange) this._onMasterChange(this.getMaster());

      // Resolve metadata asynchronously. We capture the trackId we're
      // resolving so a fast track-change cycle doesn't blast stale info into
      // _track / _beatGrid.
      const resolvingDeviceId = s.trackDeviceId;
      const resolvingTrackId = s.trackId;
      const resolvingSlot = s.trackSlot;
      const resolvingType = s.trackType;
      if (resolvingTrackId) {
        this._resolveTrackMetadata(resolvingDeviceId, resolvingSlot, resolvingType, resolvingTrackId)
          .then((track) => {
            // Drop result if the master moved on while we were waiting
            if (
              this._masterDeviceId === resolvingDeviceId &&
              this._masterTrackId === resolvingTrackId
            ) {
              this._track = track;
              if (track && Array.isArray(track.beatGrid)) this._beatGrid = track.beatGrid;
              if (track && track.durationMs) this._trackDurationMs = track.durationMs;
              if (this._onTrackChange) this._onTrackChange(track);
            }
          })
          .catch((err) => {
            console.error('[prolink] metadata lookup failed:', err.message);
            const fallback = {
              trackId: resolvingTrackId,
              deviceId: resolvingDeviceId,
              slot: resolvingSlot,
              title: null,
              artist: null,
              album: null,
              durationMs: 0,
              beatGrid: null,
            };
            if (
              this._masterDeviceId === resolvingDeviceId &&
              this._masterTrackId === resolvingTrackId
            ) {
              this._track = fallback;
              if (this._onTrackChange) this._onTrackChange(fallback);
            }
          });
      }
    }

    // Tempo change → fire callback
    if (effectiveBpm > 0 && Math.abs(effectiveBpm - this._masterBpm) > 0.05) {
      this._masterBpm = effectiveBpm;
      if (this._onTempoChange) this._onTempoChange(effectiveBpm);
    }
    this._masterTrackBpm = trackBpm;
    this._masterPitch = pitchPct;
    this._masterBeatInMeasure = s.beatInMeasure || 0;

    // Capture frozen position on transition INTO a frozen state
    const wasFrozen = this._isFrozenState(this._masterPlayState);
    const isFrozen = this._isFrozenState(s.playState);
    if (!wasFrozen && isFrozen) {
      // Compute current position before we update _masterPlayState so the
      // getter takes the active path.
      this._frozenPositionMs = this.getPositionMs();
    }
    this._masterPlayState = s.playState;

    // Update beat anchor only when actually playing — pause/cue packets carry
    // the last-known beat but we don't want to advance from them.
    if (typeof s.beat === 'number' && s.beat > 0) {
      this._lastBeat = s.beat;
      this._lastBeatAtMs = Date.now();
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  _isFrozenState(playState) {
    if (!CDJStatus || !CDJStatus.PlayState) {
      // Numeric fallback if the enum import didn't pan out.
      // Paused = 5, Cued = 6, Loading = 2, Empty = 0
      return playState === 5 || playState === 6 || playState === 2 || playState === 0;
    }
    const PS = CDJStatus.PlayState;
    return (
      playState === PS.Paused ||
      playState === PS.Cued ||
      playState === PS.Loading ||
      playState === PS.Empty
    );
  }

  /**
   * Translate a beat number (1-indexed) to milliseconds within the track.
   * The beat grid is one entry per beat in order, with `offset` in ms.
   */
  _beatMsFromGrid(beatN) {
    const grid = this._beatGrid;
    if (!grid || !grid.length) {
      // No beatgrid yet → linear estimate from BPM
      const bpm = this._masterBpm > 0 ? this._masterBpm : (this._masterTrackBpm || 120);
      return Math.max(0, (beatN - 1) * (60000 / bpm));
    }
    // Clamp to grid bounds
    if (beatN <= 1) return grid[0].offset || 0;
    if (beatN >= grid.length) {
      const last = grid[grid.length - 1];
      // extrapolate past the end using the last beat's local BPM
      const bpm = last.bpm > 0 ? last.bpm : (this._masterBpm || 120);
      return last.offset + (beatN - grid.length) * (60000 / bpm);
    }
    // 1-indexed → array[beatN - 1]
    return grid[beatN - 1].offset;
  }

  _resetMaster() {
    this._masterDeviceId = null;
    this._masterTrackId = null;
    this._masterSlot = null;
    this._masterTrackType = null;
    this._masterBpm = 0;
    this._masterTrackBpm = 0;
    this._masterPitch = 0;
    this._masterBeatInMeasure = 0;
    this._masterPlayState = 0;
    this._lastBeat = null;
    this._lastBeatAtMs = 0;
    this._beatGrid = null;
    this._trackDurationMs = 0;
    this._frozenPositionMs = 0;
    this._lastComputedPositionMs = 0;
    this._stale = false;
    this._track = null;
  }

  async _resolveTrackMetadata(deviceId, slot, trackType, trackId) {
    if (!this._network || !this._network.db) {
      throw new Error('database service not available');
    }
    const db = this._network.db;
    const meta = await db.getMetadata({
      deviceId,
      trackSlot: slot,
      trackType: trackType,
      trackId,
    });
    if (!meta) return null;

    // Track.duration is in seconds in the rekordbox export
    const durationMs = (meta.duration || 0) * 1000;

    return {
      trackId,
      deviceId,
      slot,
      title: meta.title || null,
      artist: meta.artist && meta.artist.name ? meta.artist.name : null,
      album: meta.album && meta.album.name ? meta.album.name : null,
      durationMs,
      beatGrid: meta.beatGrid || null,
    };
  }

  _withTimeout(promise, ms, message) {
    let to;
    const timeout = new Promise((_, reject) => {
      to = setTimeout(() => reject(new Error(message)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(to));
  }
}

module.exports = ProLink;
