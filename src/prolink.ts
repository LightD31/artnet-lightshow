/**
 * PRO DJ LINK: the CDJs and the mixer on the booth network, through the
 * `alphatheta-connect` package.
 *
 * Every player is tracked as a Deck (src/prolink-deck.ts), and the show
 * follows one of them — the deck the room is hearing:
 *
 *   - the tempo master, while it is playing and on air;
 *   - else the deck the show already follows, while it is;
 *   - else whichever deck has been playing on air the longest;
 *   - and when nothing is, it stays where it is.
 *
 * "On air" is the mixer's word, reported by each player: its channel is up
 * and heard. Without a DJM on the network no player reports it, and every
 * playing deck counts. A change of deck waits SWITCH_HOLD_MS, so a fader
 * flicked through a scratch does not throw the show from one track to the
 * other; a deck that is ejected or goes silent hands over at once.
 *
 * Callbacks, in the shape the other playback sources use:
 *
 *   - onTempoChange(bpm)          the followed deck's pitched tempo
 *   - onPeersChange(count)        devices on the network
 *   - onFollowChange(deck)        the followed deck changed, or its state did
 *   - onTrackChange(track, how)   the followed deck's track, once rekordbox
 *                                 has described it; `how.handoff` when it is
 *                                 a mix from another deck, with how long the
 *                                 two were heard together
 *   - onAnyTrackLoaded(track)     any deck's track, once per track, to prefetch
 *   - onLoadedTracksChange(decks) for the UI
 *
 * The package is optional: loaded through createRequire inside a try, so a
 * failed install (it builds a native SQLite module) leaves enable() rejecting
 * with a reason and the rest of the app working.
 */

import { createRequire } from 'node:module';

import Deck, { STALE_PACKET_MS } from './prolink-deck.ts';
import { listenForTiming } from './prolink-packets.ts';
import { messageOf } from './errors.ts';
import type { BeatGridEntry, CdjStatus } from './prolink-deck.ts';
import type { TimingPacket } from './prolink-packets.ts';

export type { BeatGridEntry } from './prolink-deck.ts';

// alphatheta-connect is optional, so it is loaded at run time and described
// here by the parts this module uses rather than imported for its types.

/** A track as rekordbox's export describes it. */
interface RekordboxTrack {
  title?: string;
  duration?: number;
  artist?: { name?: string } | null;
  album?: { name?: string } | null;
  beatGrid?: BeatGridEntry[] | null;
  filePath?: string;
  fileName?: string;
  analyzePath?: string;
}

/** rekordbox's phrase analysis of a track (the PSSI tag). */
export interface SongStructure {
  mood: 'high' | 'mid' | 'low';
  bank?: string;
  endBeat: number;
  phrases: { index: number; beat: number; kind: number; phraseType: string; fill?: number; fillBeat?: number }[];
}

interface Emitter {
  on(event: string, fn: (...args: never[]) => void): unknown;
  off(event: string, fn: (...args: never[]) => void): unknown;
}

interface TrackQuery { deviceId: number; trackSlot: number; trackType: number }

interface ProlinkNetwork {
  autoconfigFromPeers(): Promise<unknown>;
  connect(): void;
  disconnect(): unknown;
  close(): Promise<unknown>;
  statusEmitter?: Emitter | null;
  deviceManager?: (Emitter & { devices?: Map<unknown, unknown> }) | null;
  db?: {
    getMetadata(query: TrackQuery & { trackId: number }): Promise<RekordboxTrack | null>;
    getFile(query: TrackQuery & { track: RekordboxTrack }): Promise<Buffer | null>;
    getTrackAnalysis(query: TrackQuery & { track: RekordboxTrack }): Promise<{ songStructure?: SongStructure | null } | null>;
  } | null;
}

interface Logger {
  trace(msg: string, ...args: unknown[]): void;
  debug(msg: string, ...args: unknown[]): void;
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
}

interface AlphathetaModule {
  bringOnline(config?: { logger?: Logger }): Promise<ProlinkNetwork>;
}

/** A track loaded on a deck, as rekordbox describes it. */
export interface ProlinkTrack {
  trackId: number;
  /** The player whose media holds the track (not always the one playing it). */
  deviceId: number;
  slot: number;
  trackType?: number;
  title: string | null;
  artist: string | null;
  album?: string | null;
  durationMs: number;
  beatGrid?: BeatGridEntry[] | null;
  /** The audio file's name on the media, for its extension. */
  fileName?: string | null;
}

/** The deck the show follows, for the UI. */
export interface FollowedDeck {
  /** The player, CDJ-1 to CDJ-6. */
  deviceId: number;
  trackId: number | null;
  trackDeviceId: number | null;
  slot: number | null;
  bpm: number;
  trackBpm: number;
  pitch: number;
  beat: number | null;
  beatInMeasure: number;
  playState: number;
  isMaster: boolean;
  onAir: boolean;
  /** Following it through CDJ-3000 position packets. */
  absolute: boolean;
}

/** One player and its track, for the UI and the prefetch. */
export interface DeckView {
  playerId: number;
  /** null while rekordbox is being asked. */
  track: ProlinkTrack | null;
  playing: boolean;
  onAir: boolean;
  master: boolean;
  followed: boolean;
  bpm: number;
}

/** How the followed deck's track came to be the one playing. */
export interface TrackChange {
  /** A mix from another deck, rather than a first track or a new load. */
  handoff: boolean;
  fromPlayer: number | null;
  toPlayer: number;
  /** How long both decks were heard together before the show moved. */
  overlapMs: number;
}

const require = createRequire(import.meta.url);

let alphatheta: AlphathetaModule | null = null;
let loadError: string | null = null;
try {
  alphatheta = require('alphatheta-connect') as AlphathetaModule;
} catch (err) {
  loadError = messageOf(err);
  console.error('[prolink] failed to load alphatheta-connect:', loadError);
}

// How long a better deck has to stay better before the show moves to it.
const SWITCH_HOLD_MS = 750;
// Any player reporting on air, or the mixer saying which channels are, within
// this long means a DJM is judging what is heard.
const ON_AIR_MEMORY_MS = 10_000;
// rekordbox tracks kept for fetching their audio and phrases after the fact:
// the decks' and the few before them.
const RAW_TRACKS_KEPT = 32;

// The package's warnings and errors, once each a while; its chatter, never.
function makeLogger(): Logger {
  const seen = new Map<string, number>();
  const say = (level: string, msg: string, args: unknown[]) => {
    const text = [msg, ...args.map((a) => (a instanceof Error ? a.message : String(a)))].join(' ');
    const now = Date.now();
    const last = seen.get(text);
    if (last !== undefined && now - last < 30_000) return;
    if (seen.size > 200) seen.clear();
    seen.set(text, now);
    console.warn(`[prolink] ${level}: ${text}`);
  };
  return {
    trace: () => {},
    debug: () => {},
    info: () => {},
    warn: (msg, ...args) => say('warning', msg, args),
    error: (msg, ...args) => say('error', msg, args),
  };
}

class ProLink {
  declare _network: ProlinkNetwork | null;
  declare _timing: { close(): void } | null;
  declare _enabled: boolean;
  declare _connected: boolean;
  declare _lastError: string | null;
  declare _peers: number;
  declare _now: () => number;
  declare _decks: Map<number, Deck>;
  declare _followed: number | null;
  declare _candidate: { playerId: number; since: number } | null;
  declare _onAirSeenAt: number;
  declare _trackData: Map<number, ProlinkTrack | null>;
  declare _rawTracks: Map<string, RekordboxTrack>;
  declare _seenTrackIdentities: Set<string>;
  declare _reportedKey: string | null;
  declare _pendingChange: TrackChange | null;
  declare _reportedBpm: number;
  declare _onTempoChange: ((bpm: number) => void) | null;
  declare _onPeersChange: ((peers: number) => void) | null;
  declare _onFollowChange: ((deck: FollowedDeck | null) => void) | null;
  declare _onTrackChange: ((track: ProlinkTrack | null, change: TrackChange) => void) | null;
  declare _onAnyTrackLoaded: ((track: ProlinkTrack) => void) | null;
  declare _onLoadedTracksChange: ((decks: DeckView[]) => void) | null;
  declare _handlers: { status?: (s: CdjStatus) => void; onAir?: () => void; peers?: () => void };

  constructor() {
    this._network = null;
    this._timing = null;
    this._enabled = false;
    this._connected = false;
    this._lastError = null;
    this._peers = 0;
    // All on the monotonic clock: an NTP step in the wall clock must not
    // move the show.
    this._now = () => performance.now();
    this._decks = new Map();
    this._followed = null;
    this._candidate = null;
    this._onAirSeenAt = -Infinity;
    // Per player: its track once rekordbox has described it, null meanwhile.
    this._trackData = new Map();
    this._rawTracks = new Map();
    this._seenTrackIdentities = new Set();
    this._reportedKey = null;
    this._pendingChange = null;
    this._reportedBpm = 0;
    this._onTempoChange = null;
    this._onPeersChange = null;
    this._onFollowChange = null;
    this._onTrackChange = null;
    this._onAnyTrackLoaded = null;
    this._onLoadedTracksChange = null;
    this._handlers = {};
  }

  // ── Public getters ──────────────────────────────────────────────────────────

  get enabled(): boolean { return this._enabled; }
  get connected(): boolean { return this._connected; }
  get lastError(): string | null { return this._lastError; }
  /** The followed deck has stopped reporting. */
  get stale(): boolean {
    const deck = this._followedDeck();
    return !!deck && deck.isStale(this._now());
  }

  getNumPeers(): number { return this._peers; }
  getTempo(): number { return this._followedDeck()?.bpm || 0; }

  /** The deck the show follows, or null before any deck has a track. */
  getFollowed(): FollowedDeck | null {
    const d = this._followedDeck();
    if (!d) return null;
    return {
      deviceId: d.deviceId,
      trackId: d.trackId || null,
      trackDeviceId: d.hasTrack ? d.trackDeviceId : null,
      slot: d.hasTrack ? d.trackSlot : null,
      bpm: d.bpm,
      trackBpm: d.trackBpm,
      pitch: d.pitch,
      beat: d.lastBeat,
      beatInMeasure: d.beatInMeasure,
      playState: d.playState,
      isMaster: d.master,
      onAir: d.onAir,
      absolute: d.isAbsolute(this._now()),
    };
  }

  /** The followed deck's track, once rekordbox has described it. */
  getTrack(): ProlinkTrack | null {
    return this._followed === null ? null : this._trackData.get(this._followed) ?? null;
  }

  /** Every player with a track loaded, by player number. */
  getLoadedTracks(): DeckView[] {
    const out: DeckView[] = [];
    for (const d of this._decks.values()) {
      if (!d.hasTrack) continue;
      out.push({
        playerId: d.deviceId,
        track: this._trackData.get(d.deviceId) ?? null,
        playing: d.playing,
        onAir: d.onAir,
        master: d.master,
        followed: d.deviceId === this._followed,
        bpm: d.bpm,
      });
    }
    return out.sort((a, b) => a.playerId - b.playerId);
  }

  /**
   * Where the followed deck is, in beats, for the pattern clock (see
   * server/conductor.ts): `{ beatPos, bpm }`, or null unless it is playing and
   * still reporting.
   */
  getBeatReading(): { beatPos: number; bpm: number | null } | null {
    return this._followedDeck()?.beatReading(this._now()) ?? null;
  }

  /** Position in ms within the followed deck's track. */
  getPositionMs(): number {
    const d = this._followedDeck();
    if (!d || !d.hasTrack) return 0;
    const now = this._now();
    // A deck gone quiet holds where it got to rather than drifting on.
    if (d.isStale(now)) return d.positionMs(d.lastStatusAt + STALE_PACKET_MS);
    return d.positionMs(now);
  }

  _followedDeck(): Deck | null {
    return this._followed === null ? null : this._decks.get(this._followed) ?? null;
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  async enable(): Promise<void> {
    if (!alphatheta) {
      const err = new Error(`alphatheta-connect is not available (${loadError || 'not installed'}) — run npm install`);
      this._lastError = err.message;
      throw err;
    }
    if (this._enabled) return;

    this._enabled = true;
    this._lastError = null;

    try {
      const network = await alphatheta.bringOnline({ logger: makeLogger() });
      this._network = network;
      // Wait for any device to show up so we can determine the right NIC.
      // This will hang forever if no CDJs are present, so we timeout it.
      await this._withTimeout(network.autoconfigFromPeers(), 10000, 'autoconfig timeout (no devices found on the network)');
      network.connect();
      this._connected = true;

      const statusEmitter = network.statusEmitter;
      if (!statusEmitter) throw new Error('statusEmitter unavailable after connect()');
      this._handlers.status = (s: CdjStatus) => this._onStatus(s);
      this._handlers.onAir = () => { this._onAirSeenAt = this._now(); };
      statusEmitter.on('status', this._handlers.status);
      statusEmitter.on('onAir', this._handlers.onAir);

      // Beat and position packets, read beside the library's own socket. A
      // failure costs the fine timing, not the connection: status packets
      // still place each deck within its beat.
      try {
        this._timing = await listenForTiming((p) => this._onTiming(p));
      } catch (err) {
        console.warn(`[prolink] no beat packets (${messageOf(err)}); following status packets only`);
      }

      const dm = network.deviceManager;
      if (dm) {
        const updatePeers = () => {
          const next = dm.devices ? dm.devices.size : 0;
          if (next !== this._peers) {
            this._peers = next;
            if (this._onPeersChange) this._onPeersChange(this._peers);
          }
        };
        this._handlers.peers = updatePeers;
        dm.on('connected', updatePeers);
        dm.on('disconnected', updatePeers);
        updatePeers();
      }

      console.log('[prolink] connected to PRO DJ LINK network');
    } catch (err) {
      this._lastError = messageOf(err);
      this._connected = false;
      this._enabled = false;
      await this._closeNetwork();
      console.error('[prolink] enable failed:', messageOf(err));
      throw err;
    }
  }

  async disable(): Promise<void> {
    if (!this._enabled && !this._connected) return;
    this._enabled = false;
    this._connected = false;
    try {
      await this._closeNetwork();
    } finally {
      this._decks.clear();
      this._trackData.clear();
      this._rawTracks.clear();
      this._seenTrackIdentities.clear();
      this._followed = null;
      this._candidate = null;
      this._reportedKey = null;
      this._pendingChange = null;
      this._reportedBpm = 0;
      this._onAirSeenAt = -Infinity;
      this._peers = 0;
      console.log('[prolink] disconnected');
    }
  }

  async _closeNetwork(): Promise<void> {
    const network = this._network;
    this._network = null;
    if (this._timing) { this._timing.close(); this._timing = null; }
    if (!network) return;
    try {
      const se = network.statusEmitter;
      if (se && this._handlers.status) se.off('status', this._handlers.status);
      if (se && this._handlers.onAir) se.off('onAir', this._handlers.onAir);
      const dm = network.deviceManager;
      if (dm && this._handlers.peers) {
        dm.off('connected', this._handlers.peers);
        dm.off('disconnected', this._handlers.peers);
      }
    } catch (err) {
      console.error('[prolink] disable cleanup error:', messageOf(err));
    }
    this._handlers = {};
    // disconnect() stops announcing and drops the database connections; it
    // throws for a network never configured (autoconfig timed out). close()
    // releases the sockets either way, so a retry can bind them again.
    try { network.disconnect(); } catch { /* never configured */ }
    try { await network.close(); } catch { /* already closed */ }
  }

  destroy(): void {
    // Fire-and-forget; don't await on shutdown.
    this.disable().catch(() => {});
  }

  // ── Listeners ───────────────────────────────────────────────────────────────

  onTempoChange(fn: ProLink['_onTempoChange']): void               { this._onTempoChange          = fn; }
  onPeersChange(fn: ProLink['_onPeersChange']): void               { this._onPeersChange          = fn; }
  onFollowChange(fn: ProLink['_onFollowChange']): void             { this._onFollowChange         = fn; }
  onTrackChange(fn: ProLink['_onTrackChange']): void               { this._onTrackChange          = fn; }
  onAnyTrackLoaded(fn: ProLink['_onAnyTrackLoaded']): void         { this._onAnyTrackLoaded       = fn; }
  onLoadedTracksChange(fn: ProLink['_onLoadedTracksChange']): void { this._onLoadedTracksChange   = fn; }

  // ── Packets ─────────────────────────────────────────────────────────────────

  _deck(playerId: number): Deck {
    let deck = this._decks.get(playerId);
    if (!deck) {
      deck = new Deck(playerId);
      this._decks.set(playerId, deck);
    }
    return deck;
  }

  _onStatus(s: CdjStatus | null | undefined): void {
    if (!s || !s.deviceId) return;
    const now = this._now();
    const deck = this._deck(s.deviceId);
    const { trackChanged } = deck.status(s, now);
    if (s.isOnAir) this._onAirSeenAt = now;

    if (trackChanged) {
      if (deck.hasTrack) {
        // A placeholder straight away, so the UI shows the deck loading.
        this._trackData.set(deck.deviceId, null);
        this._resolveDeckTrack(deck);
      } else {
        this._trackData.delete(deck.deviceId);
      }
      if (this._onLoadedTracksChange) this._onLoadedTracksChange(this.getLoadedTracks());
    }

    this._select(now);
    if (deck.deviceId === this._followed) this._reportTempo();
  }

  _onTiming(p: TimingPacket): void {
    const deck = this._decks.get(p.deviceId);
    // A deck is known by its status packets first: they name its track.
    if (!deck || !deck.hasTrack) return;
    const now = this._now();
    if (p.kind === 'beat') deck.beatPacket(p, now);
    else deck.positionPacket(p, now);
  }

  /** Ask rekordbox about a deck's new track, and file the answer if it is still loaded. */
  _resolveDeckTrack(deck: Deck): void {
    const identity = deck.identity as string;
    const playerId = deck.deviceId;
    const { trackDeviceId, trackSlot, trackType, trackId } = deck;
    const stillLoaded = () => this._decks.get(playerId)?.identity === identity;
    this._resolveTrackMetadata(trackDeviceId, trackSlot, trackType, trackId)
      .catch((err) => {
        console.warn(`[prolink] no rekordbox metadata for CDJ-${playerId}'s track: ${messageOf(err)}`);
        return null;
      })
      .then((resolved) => {
        const track: ProlinkTrack = resolved
          || { trackId, deviceId: trackDeviceId, slot: trackSlot, trackType, title: null, artist: null, album: null, durationMs: 0, beatGrid: null };
        if (stillLoaded()) {
          this._trackData.set(playerId, track);
          if (Array.isArray(track.beatGrid) && track.beatGrid.length) deck.grid = track.beatGrid;
          if (this._onLoadedTracksChange) this._onLoadedTracksChange(this.getLoadedTracks());
          this._reportTrack();
        }
        if (!this._seenTrackIdentities.has(identity)) {
          this._seenTrackIdentities.add(identity);
          if (this._onAnyTrackLoaded) this._onAnyTrackLoaded(track);
        }
      });
  }

  // ── Which deck the show follows ─────────────────────────────────────────────

  _select(now: number): void {
    const onAirKnown = now - this._onAirSeenAt < ON_AIR_MEMORY_MS;
    const live = [...this._decks.values()].filter((d) => d.hasTrack && !d.isStale(now));
    const audible = (d: Deck) => d.playing && (!onAirKnown || d.onAir);
    for (const d of this._decks.values()) {
      if (live.includes(d) && audible(d)) {
        if (d.audibleSince === null) d.audibleSince = now;
        d.lastAudibleAt = now;
      } else d.audibleSince = null;
    }

    const current = this._followedDeck();
    const currentLive = !!current && live.includes(current);
    const master = live.find((d) => d.master) || null;
    let want: Deck | null;
    if (master && audible(master)) want = master;
    else if (current && currentLive && audible(current)) want = current;
    else {
      const heard = live.filter(audible).sort((a, b) => (a.audibleSince as number) - (b.audibleSince as number));
      want = heard[0] || (currentLive ? current : null) || master || live[0] || null;
    }

    if (!want || want === current) {
      this._candidate = null;
      return;
    }
    // A deck ejected or gone quiet hands over at once; a better deck has to
    // stay better for a moment first.
    if (currentLive) {
      if (!this._candidate || this._candidate.playerId !== want.deviceId) {
        this._candidate = { playerId: want.deviceId, since: now };
        return;
      }
      if (now - this._candidate.since < SWITCH_HOLD_MS) return;
    }
    this._follow(want, current && currentLive ? current : null);
  }

  _follow(next: Deck, previous: Deck | null): void {
    this._candidate = null;
    this._followed = next.deviceId;
    // From when the incoming deck was first heard to when the outgoing one
    // last was.
    const overlapMs = previous && previous.lastAudibleAt !== null && next.audibleSince !== null
      ? previous.lastAudibleAt - next.audibleSince
      : 0;
    this._pendingChange = {
      handoff: !!previous && previous.playing && next.playing,
      fromPlayer: previous ? previous.deviceId : null,
      toPlayer: next.deviceId,
      overlapMs: Math.max(0, overlapMs),
    };
    console.log(`[prolink] following CDJ-${next.deviceId}${previous ? ` (was CDJ-${previous.deviceId})` : ''}`);
    if (this._onFollowChange) this._onFollowChange(this.getFollowed());
    if (this._onLoadedTracksChange) this._onLoadedTracksChange(this.getLoadedTracks());
    this._reportTempo();
    this._reportTrack();
  }

  /** Tell the show about the followed deck's track, once per deck and track. */
  _reportTrack(): void {
    const deck = this._followedDeck();
    if (!deck || !deck.hasTrack) return;
    const track = this._trackData.get(deck.deviceId);
    if (!track) return;
    const key = `${deck.deviceId}|${deck.identity}`;
    if (key === this._reportedKey) return;
    this._reportedKey = key;
    const change = this._pendingChange && this._pendingChange.toPlayer === deck.deviceId
      ? this._pendingChange
      : { handoff: false, fromPlayer: null, toPlayer: deck.deviceId, overlapMs: 0 };
    this._pendingChange = null;
    if (this._onTrackChange) this._onTrackChange(track, change);
  }

  _reportTempo(): void {
    const bpm = this._followedDeck()?.bpm || 0;
    if (bpm > 0 && Math.abs(bpm - this._reportedBpm) > 0.05) {
      this._reportedBpm = bpm;
      if (this._onTempoChange) this._onTempoChange(bpm);
    }
  }

  // ── rekordbox ───────────────────────────────────────────────────────────────

  async _resolveTrackMetadata(deviceId: number, slot: number, trackType: number, trackId: number): Promise<ProlinkTrack | null> {
    const db = this._network && this._network.db;
    if (!db) throw new Error('database service not available');
    const meta = await db.getMetadata({ deviceId, trackSlot: slot, trackType, trackId });
    if (!meta) return null;
    this._keepRaw(`${deviceId}:${slot}:${trackId}`, meta);
    return {
      trackId,
      deviceId,
      slot,
      trackType,
      title: meta.title || null,
      artist: meta.artist && meta.artist.name ? meta.artist.name : null,
      album: meta.album && meta.album.name ? meta.album.name : null,
      // Seconds in the export.
      durationMs: (meta.duration || 0) * 1000,
      beatGrid: meta.beatGrid || null,
      fileName: meta.fileName || null,
    };
  }

  _keepRaw(identity: string, meta: RekordboxTrack): void {
    this._rawTracks.delete(identity);
    this._rawTracks.set(identity, meta);
    while (this._rawTracks.size > RAW_TRACKS_KEPT) {
      const oldest = this._rawTracks.keys().next().value as string;
      this._rawTracks.delete(oldest);
    }
  }

  _rawFor(track: ProlinkTrack): { raw: RekordboxTrack; query: TrackQuery } | null {
    const raw = this._rawTracks.get(`${track.deviceId}:${track.slot}:${track.trackId}`);
    if (!raw) return null;
    return { raw, query: { deviceId: track.deviceId, trackSlot: track.slot, trackType: track.trackType ?? 1 } };
  }

  /**
   * The track's own audio file, straight off the USB stick or SD card in the
   * player, over the network's NFS — the exact recording the DJ plays, so the
   * analysis lines up with the deck to the millisecond. Null when the track
   * is not on player media (rekordbox over the link, a CD) or not reachable.
   */
  async fetchAudio(track: ProlinkTrack): Promise<{ data: Buffer; fileName: string } | null> {
    const db = this._network && this._network.db;
    const found = this._rawFor(track);
    if (!db || !found || !found.raw.filePath) return null;
    const data = await db.getFile({ ...found.query, track: found.raw });
    if (!data || !data.length) return null;
    const fileName = found.raw.fileName || found.raw.filePath.split('/').pop() || 'track';
    return { data: Buffer.from(data), fileName };
  }

  /** rekordbox's phrase analysis of the track, when it made one. */
  async fetchSongStructure(track: ProlinkTrack): Promise<SongStructure | null> {
    const db = this._network && this._network.db;
    const found = this._rawFor(track);
    if (!db || !found || !found.raw.analyzePath) return null;
    const analysis = await db.getTrackAnalysis({ ...found.query, track: found.raw });
    const structure = analysis && analysis.songStructure;
    return structure && Array.isArray(structure.phrases) && structure.phrases.length ? structure : null;
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
