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
 * number in each status packet) plus the track's beat grid (offsets in ms).
 * Between status packets the position runs on the monotonic clock at the
 * deck's pitch; each packet only corrects it back inside the beat it reports,
 * so pitch / nudge / seek are followed without the position ever restarting
 * a beat it is already partway through (see _reanchor).
 *
 * The package is CommonJS (verified at install time), so it is loaded with a
 * plain require() through createRequire — synchronously, and inside a try, so
 * that it stays optional. If the require fails (wrong Node version, package corrupt) the
 * wrapper degrades gracefully: enable() rejects, the rest of the app keeps
 * working.
 */

import { createRequire } from 'node:module';

import { makeGrid, beatPositionAt } from './shared/beat-clock.ts';
import { messageOf } from './errors.ts';
import type { BeatGrid } from './shared/beat-clock.ts';

// prolink-connect is optional, so it is loaded at run time and described here
// by the parts this module uses rather than imported for its types.

/** One CDJ status packet. */
interface CdjStatus {
  deviceId: number;
  trackId: number;
  trackDeviceId: number;
  trackSlot: number;
  trackType: number;
  isMaster: boolean;
  trackBPM: number | null;
  effectivePitch: number;
  beatInMeasure: number;
  playState: number;
  beat: number | null;
}

/** One beat of rekordbox's grid. */
export interface BeatGridEntry {
  offset: number;
  count?: number;
  bpm: number;
}

interface TrackMetadata {
  title?: string;
  duration?: number;
  artist?: { name?: string } | null;
  album?: { name?: string } | null;
  beatGrid?: BeatGridEntry[] | null;
}

interface Emitter {
  on(event: string, fn: (...args: never[]) => void): unknown;
  off(event: string, fn: (...args: never[]) => void): unknown;
}

interface ProlinkNetwork {
  autoconfigFromPeers(): Promise<unknown>;
  connect(): void;
  disconnect?(): Promise<unknown>;
  statusEmitter?: Emitter | null;
  deviceManager?: (Emitter & { devices?: Map<unknown, unknown> }) | null;
  db?: {
    getMetadata(query: { deviceId: number; trackSlot: number; trackType: number; trackId: number }):
      Promise<TrackMetadata | null>;
  } | null;
}

interface ProlinkModule {
  bringOnline(): Promise<ProlinkNetwork>;
  CDJStatus?: { PlayState?: Record<string, number> };
}

/** A track loaded on a deck, as rekordbox describes it. */
export interface ProlinkTrack {
  trackId: number;
  deviceId: number;
  slot: number;
  title: string | null;
  artist: string | null;
  album?: string | null;
  durationMs: number;
  beatGrid?: BeatGridEntry[] | null;
}

/** The master deck, for the UI. */
export interface ProlinkMaster {
  deviceId: number;
  trackId: number | null;
  slot: number | null;
  bpm: number;
  trackBpm: number;
  pitch: number;
  beat: number | null;
  beatInMeasure: number;
  playState: number;
}

/** Where the master deck's position runs from. */
interface Anchor {
  posMs: number;
  at: number;
  rate: number;
}

const require = createRequire(import.meta.url);

let prolink: ProlinkModule | null = null;
let CDJStatus: ProlinkModule['CDJStatus'] | null = null;
try {
  const loaded = require('prolink-connect') as ProlinkModule;
  prolink = loaded;
  CDJStatus = loaded.CDJStatus; // PlayState enum lives here
} catch (err) {
  console.error('[prolink] failed to load prolink-connect:', messageOf(err));
}

const STALE_PACKET_MS = 5000;

class ProLink {
  declare _network: ProlinkNetwork | null;
  declare _enabled: boolean;
  declare _connected: boolean;
  declare _lastError: string | null;
  declare _peers: number;
  declare _masterDeviceId: number | null;
  declare _masterTrackId: number | null;
  declare _masterSlot: number | null;
  declare _masterTrackType: number | null;
  declare _masterBpm: number;
  declare _masterTrackBpm: number;
  declare _masterPitch: number;
  declare _masterBeatInMeasure: number;
  declare _masterPlayState: number;
  declare _now: () => number;
  declare _lastBeat: number | null;
  declare _anchor: Anchor | null;
  declare _lastMasterPacketAt: number;
  declare _beatGrid: BeatGridEntry[] | null;
  declare _clockGridFor: BeatGridEntry[] | null;
  declare _clockGridCache: BeatGrid | null;
  declare _trackDurationMs: number;
  declare _frozenPositionMs: number;
  declare _lastComputedPositionMs: number;
  declare _stale: boolean;
  declare _track: ProlinkTrack | null;
  declare _playerTracks: Map<number, string>;
  declare _playerTrackData: Map<number, ProlinkTrack | null>;
  declare _seenTrackIdentities: Set<string>;
  declare _onTempoChange: ((bpm: number) => void) | null;
  declare _onPeersChange: ((peers: number) => void) | null;
  declare _onMasterChange: ((master: ProlinkMaster | null) => void) | null;
  declare _onTrackChange: ((track: ProlinkTrack | null) => void) | null;
  declare _onAnyTrackLoaded: ((track: ProlinkTrack) => void) | null;
  declare _onLoadedTracksChange: ((tracks: { playerId: number; track: ProlinkTrack | null }[]) => void) | null;
  declare _statusHandler: ((s: CdjStatus) => void) | null;
  declare _connectedHandler: (() => void) | null;
  declare _disconnectedHandler: (() => void) | null;

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

    // Position tracking, all on the monotonic clock: an NTP step in the wall
    // clock must not move the show.
    this._now = () => performance.now();
    this._lastBeat = null;        // beat counter from latest packet
    this._anchor = null;          // { posMs, at, rate } — see _reanchor
    this._lastMasterPacketAt = 0; // when the master last reported
    this._beatGrid = null;        // Array<{offset_ms, count, bpm}>, one entry per beat
    this._clockGridFor = null;    // the _beatGrid _clockGridCache was built from
    this._clockGridCache = null;
    this._trackDurationMs = 0;
    this._frozenPositionMs = 0;
    this._lastComputedPositionMs = 0;
    this._stale = false;

    // Resolved metadata for the current master track
    this._track = null;           // { trackId, deviceId, slot, title, artist, album, durationMs }

    // All-player track tracking (for prefetch + UI)
    // _playerTracks:     Map<playerId, identity string> — last known track per CDJ
    // _playerTrackData:  Map<playerId, track|null>      — resolved metadata per CDJ (null = loading)
    // _seenTrackIdentities: Set<identity string> — tracks we've already fired onAnyTrackLoaded for
    this._playerTracks = new Map();
    this._playerTrackData = new Map();
    this._seenTrackIdentities = new Set();

    // Listeners
    this._onTempoChange = null;
    this._onPeersChange = null;
    this._onMasterChange = null;
    this._onTrackChange = null;
    this._onAnyTrackLoaded = null;
    this._onLoadedTracksChange = null;
  }

  // ── Public getters ──────────────────────────────────────────────────────────

  get enabled(): boolean { return this._enabled; }
  get connected(): boolean { return this._connected; }
  get lastError(): string | null { return this._lastError; }
  get stale(): boolean { return this._stale; }

  getNumPeers(): number { return this._peers; }
  getTempo(): number { return this._masterBpm || 0; }

  getMaster(): ProlinkMaster | null {
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

  getTrack(): ProlinkTrack | null { return this._track; }

  /**
   * Where the master deck is, in beats, for the pattern clock (see
   * server/conductor.js): `{ beatPos, bpm }`, or null unless a deck is playing
   * and still reporting.
   *
   * The smoothed position is read through rekordbox's own beat grid, so the
   * steps land on the beats the DJ sees on the deck; without a grid yet it is
   * counted at the track's tempo. `bpm` is the pitched tempo the room hears.
   */
  getBeatReading(): { beatPos: number; bpm: number | null } | null {
    if (!this._masterTrackId || !this._anchor) return null;
    if (this._isFrozenState(this._masterPlayState)) return null;
    const posMs = this.getPositionMs();
    if (this._stale || !Number.isFinite(posMs)) return null;
    const grid = this._clockGrid();
    let beatPos: number;
    if (grid) {
      beatPos = beatPositionAt(grid, posMs);
    } else {
      const trackBpm = this._masterTrackBpm > 0 ? this._masterTrackBpm : this._masterBpm;
      if (!(trackBpm > 0)) return null;
      beatPos = (posMs / 60000) * trackBpm;
    }
    if (!Number.isFinite(beatPos)) return null;
    return { beatPos, bpm: this._masterBpm > 0 ? this._masterBpm : null };
  }

  /** rekordbox's grid in the shape beat-clock reads, built once per track. */
  _clockGrid(): BeatGrid | null {
    const source = this._beatGrid;
    if (!Array.isArray(source) || source.length < 2) return null;
    if (this._clockGridFor !== source) {
      this._clockGridFor = source;
      this._clockGridCache = makeGrid(source.map((b) => Number(b && b.offset) / 1000));
    }
    return this._clockGridCache;
  }

  /**
   * Returns an array of { playerId, track } for every CDJ that currently has a
   * track loaded, sorted by playerId. `track` is null while metadata is still
   * being resolved from rekordbox.
   */
  getLoadedTracks(): { playerId: number; track: ProlinkTrack | null }[] {
    const result: { playerId: number; track: ProlinkTrack | null }[] = [];
    for (const [playerId, track] of this._playerTrackData) {
      result.push({ playerId, track });
    }
    result.sort((a, b) => a.playerId - b.playerId);
    return result;
  }

  /** Position in ms within the loaded master track. 0 when nothing is playing. */
  getPositionMs(): number {
    if (!this._masterTrackId) return 0;
    const now = this._now();

    // Stale-packet cutoff: the master may have gone away. Freeze, don't drift.
    // Judged on the master's own packets — another deck still reporting says
    // nothing about whether the one the show follows is.
    if (this._lastMasterPacketAt && now - this._lastMasterPacketAt > STALE_PACKET_MS) {
      this._stale = true;
      return this._lastComputedPositionMs || 0;
    }
    this._stale = false;

    // Paused / Cued → frozen at the moment of the transition
    if (this._isFrozenState(this._masterPlayState)) {
      return this._frozenPositionMs;
    }

    if (!this._anchor) return 0;
    const pos = this._anchor.posMs + (now - this._anchor.at) * this._anchor.rate;
    this._lastComputedPositionMs = pos;
    return pos;
  }

  /**
   * Fold one status packet's beat number into the running position.
   *
   * A status packet arrives about five times a second and names the beat the
   * deck is in, not where in it. The old code took the packet's *arrival* as
   * the start of that beat, so every packet snapped the position back to the
   * top of the beat: a sawtooth the size of a packet interval, five times a
   * second, each one far enough backwards to make the show re-seek and
   * restart its pattern.
   *
   * Instead the position keeps running at the deck's own speed (track tempo ×
   * pitch) and a packet only corrects it:
   *
   *   - still inside the reported beat: left alone — the normal case;
   *   - within a beat of it: pulled back to its nearer edge, which removes
   *     drift without restarting anything;
   *   - further off (a seek, a loop, a new track, the first packet): placed at
   *     the reported beat, plus half the time since the previous packet when
   *     the beat has only just changed — the boundary fell somewhere in that
   *     gap, and its middle is the unbiased guess.
   */
  _reanchor({ beat, beatChanged, now, previousPacketAt, rate }: {
    beat: number;
    beatChanged: boolean;
    now: number;
    previousPacketAt: number;
    rate: number;
  }): Anchor {
    const lo = this._beatMsFromGrid(beat);
    const hi = this._beatMsFromGrid(beat + 1);
    const span = Math.max(1, hi - lo);
    const predicted = this._anchor
      ? this._anchor.posMs + (now - this._anchor.at) * this._anchor.rate
      : null;

    let posMs: number;
    if (predicted != null && predicted >= lo - span && predicted <= hi + span) {
      posMs = Math.min(Math.max(predicted, lo), hi);
    } else {
      const sinceBoundary = beatChanged && previousPacketAt
        ? Math.min(span, ((now - previousPacketAt) / 2) * rate)
        : 0;
      posMs = lo + sinceBoundary;
    }
    return { posMs, at: now, rate };
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  async enable(): Promise<void> {
    if (!prolink) {
      const err = new Error('prolink-connect not available — check Node version (need >= 20)');
      this._lastError = err.message;
      throw err;
    }
    if (this._enabled) return;

    this._enabled = true;
    this._lastError = null;

    try {
      const network = await prolink.bringOnline();
      this._network = network;
      // Wait for any device to show up so we can determine the right NIC.
      // This will hang forever if no CDJs are present, so we timeout it.
      await this._withTimeout(network.autoconfigFromPeers(), 10000, 'autoconfig timeout (no devices found on the network)');
      network.connect();
      this._connected = true;

      // Status updates
      const statusEmitter = network.statusEmitter;
      if (!statusEmitter) {
        throw new Error('statusEmitter unavailable after connect()');
      }
      const statusHandler = (s: CdjStatus) => this._onStatus(s);
      this._statusHandler = statusHandler;
      statusEmitter.on('status', statusHandler);

      // Device list updates → peer count
      const dm = network.deviceManager;
      if (dm) {
        const updatePeers = () => {
          const next = dm.devices ? dm.devices.size : 0;
          if (next !== this._peers) {
            this._peers = next;
            if (this._onPeersChange) this._onPeersChange(this._peers);
          }
        };
        const connectedHandler = () => updatePeers();
        const disconnectedHandler = () => updatePeers();
        this._connectedHandler = connectedHandler;
        this._disconnectedHandler = disconnectedHandler;
        dm.on('connected', connectedHandler);
        dm.on('disconnected', disconnectedHandler);
        updatePeers();
      }

      console.log('[prolink] connected to PRO DJ LINK network');
    } catch (err) {
      this._lastError = messageOf(err);
      this._connected = false;
      this._enabled = false;
      // Attempt cleanup so a retry can rebind sockets
      try { if (this._network && this._network.disconnect) await this._network.disconnect(); } catch (_) {}
      this._network = null;
      console.error('[prolink] enable failed:', messageOf(err));
      throw err;
    }
  }

  async disable(): Promise<void> {
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
      console.error('[prolink] disable cleanup error:', messageOf(err));
    } finally {
      this._network = null;
      this._statusHandler = null;
      this._connectedHandler = null;
      this._disconnectedHandler = null;
      this._resetMaster();
      this._playerTracks.clear();
      this._playerTrackData.clear();
      this._seenTrackIdentities.clear();
      this._peers = 0;
      console.log('[prolink] disconnected');
    }
  }

  destroy(): void {
    // Fire-and-forget; don't await on shutdown.
    this.disable().catch(() => {});
  }

  // ── Listeners ───────────────────────────────────────────────────────────────

  onTempoChange(fn: ProLink['_onTempoChange']): void               { this._onTempoChange          = fn; }
  onPeersChange(fn: ProLink['_onPeersChange']): void               { this._onPeersChange          = fn; }
  onMasterChange(fn: ProLink['_onMasterChange']): void             { this._onMasterChange         = fn; }
  onTrackChange(fn: ProLink['_onTrackChange']): void               { this._onTrackChange          = fn; }
  onAnyTrackLoaded(fn: ProLink['_onAnyTrackLoaded']): void         { this._onAnyTrackLoaded       = fn; }
  onLoadedTracksChange(fn: ProLink['_onLoadedTracksChange']): void { this._onLoadedTracksChange   = fn; }

  // ── Status packet handler ───────────────────────────────────────────────────

  _onStatus(s: CdjStatus | null | undefined): void {
    if (!s) return;

    // ── Track all players: detect load / eject on any CDJ ────────────────────
    // s.deviceId is the player (CDJ 1-4) that sent this packet.
    // A track identity is (trackDeviceId, trackSlot, trackId) — same tuple used
    // by rekordbox and by keyForProlinkTrack in the cache.
    {
      const playerId = s.deviceId;
      if (playerId) {
        const tId = s.trackId;
        if (!tId || tId === 0) {
          // Eject — remove this player from the loaded-tracks map.
          if (this._playerTracks.has(playerId)) {
            this._playerTracks.delete(playerId);
            this._playerTrackData.delete(playerId);
            if (this._onLoadedTracksChange) this._onLoadedTracksChange(this.getLoadedTracks());
          }
        } else {
          const identity = `${s.trackDeviceId}:${s.trackSlot}:${tId}`;
          const prev = this._playerTracks.get(playerId);
          if (prev !== identity) {
            this._playerTracks.set(playerId, identity);
            // Show a loading placeholder immediately so the UI updates right away.
            this._playerTrackData.set(playerId, null);
            if (this._onLoadedTracksChange) this._onLoadedTracksChange(this.getLoadedTracks());

            const devId = s.trackDeviceId;
            const slot  = s.trackSlot;
            const tType = s.trackType;

            // Resolve rekordbox metadata, then update the per-player entry.
            this._resolveTrackMetadata(devId, slot, tType, tId)
              .then((track) => {
                // Only update if this player still has the same track.
                if (this._playerTracks.get(playerId) === identity) {
                  this._playerTrackData.set(playerId, track);
                  if (this._onLoadedTracksChange) this._onLoadedTracksChange(this.getLoadedTracks());
                }
                // Fire prefetch callback once per unique track identity.
                if (track && !this._seenTrackIdentities.has(identity)) {
                  this._seenTrackIdentities.add(identity);
                  if (this._onAnyTrackLoaded) this._onAnyTrackLoaded(track);
                }
              })
              .catch(() => {
                const fallback: ProlinkTrack = { trackId: tId, deviceId: devId, slot, title: null, artist: null, durationMs: 0 };
                if (this._playerTracks.get(playerId) === identity) {
                  this._playerTrackData.set(playerId, fallback);
                  if (this._onLoadedTracksChange) this._onLoadedTracksChange(this.getLoadedTracks());
                }
                if (!this._seenTrackIdentities.has(identity)) {
                  this._seenTrackIdentities.add(identity);
                  if (this._onAnyTrackLoaded) this._onAnyTrackLoaded(fallback);
                }
              });
          }
        }
      }
    }

    // Only the master drives our state. Ignore packets from non-master devices.
    if (!s.isMaster) return;
    const now = this._now();
    const previousPacketAt = this._lastMasterPacketAt;
    this._lastMasterPacketAt = now;

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
            console.error('[prolink] metadata lookup failed:', messageOf(err));
            const fallback: ProlinkTrack = {
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
    // Resuming: carry on from where the deck stopped, not from where the
    // anchor would have run to had it never paused.
    if (wasFrozen && !isFrozen && this._anchor) {
      this._anchor = { ...this._anchor, posMs: this._frozenPositionMs, at: now };
    }
    this._masterPlayState = s.playState;

    const beat = s.beat;
    const hasBeat = typeof beat === 'number' && beat > 0;
    if (hasBeat && isFrozen) {
      // A cue jump while paused moves the deck without playing it.
      if (beat !== this._lastBeat) this._frozenPositionMs = this._beatMsFromGrid(beat);
      this._lastBeat = beat;
    } else if (hasBeat) {
      const rate = 1 + pitchPct / 100;
      this._anchor = this._reanchor({
        beat, beatChanged: beat !== this._lastBeat, now, previousPacketAt, rate,
      });
      this._lastBeat = beat;
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  _isFrozenState(playState: number): boolean {
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
  _beatMsFromGrid(beatN: number): number {
    const grid = this._beatGrid;
    if (!grid || !grid.length) {
      // No beatgrid yet → linear estimate from BPM. The track's own tempo, not
      // the pitched one: this is a position in the track, which pitch does
      // not stretch — it only changes how fast the deck moves through it.
      const bpm = this._masterTrackBpm > 0 ? this._masterTrackBpm : (this._masterBpm || 120);
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

  _resetMaster(): void {
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
    this._anchor = null;
    this._beatGrid = null;
    this._trackDurationMs = 0;
    this._frozenPositionMs = 0;
    this._lastComputedPositionMs = 0;
    this._stale = false;
    this._track = null;
  }

  async _resolveTrackMetadata(deviceId: number, slot: number, trackType: number, trackId: number): Promise<ProlinkTrack | null> {
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

  _withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
    let to: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      to = setTimeout(() => reject(new Error(message)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(to));
  }
}

export default ProLink;