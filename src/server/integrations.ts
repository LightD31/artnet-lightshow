import { transitionFor } from '../show/transition.ts';
import { state, getLiveState, getDmxSnapshot, getDmxUniverses, setExtrasProvider } from './state.ts';
import { createPublisher, ROOM } from './protocol.ts';
import { encodeDmxFrame } from '../shared/dmx-frame.ts';
import { setHooks, applyPatch } from './patch.ts';
import { conductor } from './conductor.ts';
import { currentRig } from './rig.ts';
import { guarded } from './guard.ts';
import PlaybackClock from '../playback-clock.ts';
import { cues } from './cues.ts';
import { Warmer } from './warm.ts';
import { keyForSpotify, keyForQuery, keyForProlinkTrack } from '../analysis-cache.ts';
import HybridSource from '../hybrid-source.ts';
import { sampleAutoPosition } from './auto-position.ts';
import { gridFromAnalysis } from '../shared/beat-clock.ts';
import { messageOf } from '../errors.ts';
import { audioToTempWav } from '../audio-file.ts';
import { applyRekordbox } from '../rekordbox-analysis.ts';
import { AutoSync } from '../auto-sync.ts';
import LiveDirector from '../show/live-director.ts';
import { PATTERNS } from './presets.ts';
import { settings } from './settings.ts';
import type { Server } from 'socket.io';
import type AutoShow from '../auto-show.ts';
import type { AnalysisCache } from '../analysis-cache.ts';
import type DeezerSource from '../deezer-source.ts';
import type MidiController from '../midi.ts';
import type NowPlayingSource from '../nowplaying-source.ts';
import type ProLink from '../prolink.ts';
import type LiveInput from '../live-input.ts';
import type { ProlinkTrack } from '../prolink.ts';
import type { AnalysisPriority } from '../analyzer-worker.ts';
import type SpotifyClient from '../spotify.ts';
import type { BeatGrid } from '../shared/beat-clock.ts';
import type { AutoPosition } from './auto-position.ts';
import type { DeezerState } from './validation.ts';
import type { NowPlaying } from '../types/playback.ts';

/** Everything the integrations wire together. */
export interface IntegrationDeps {
  io: Server;
  midi: MidiController;
  spotify: SpotifyClient;
  nowPlaying: NowPlayingSource;
  deezerSource: DeezerSource;
  prolink: ProLink;
  autoShow: AutoShow;
  analysisCache?: AnalysisCache | null;
  liveInput?: LiveInput | null;
}

/** Which source the auto show follows. */
export type AutoSource = 'prolink' | 'hybrid' | 'spotify' | 'deezer' | 'nowplaying' | 'live' | 'timer';

/** A queued track, as a prefetch slot shows it. */
interface SlotTrack {
  name: string;
  artist: string;
  album: string;
  albumArt: string | null;
  durationMs: number;
}

/** One upcoming track and how its analysis is coming along. */
export interface PrefetchSlot {
  track: SlotTrack | null;
  status: string;
  message: string;
  cacheKey: string | null;
}

/** The track playing now: its cache key and the clock its show follows. */
interface PlayingTrack {
  key: string | null;
  clock: () => number;
}

// A track change that lands while the previous track is still being analysed
// hands the analyser to the new song and abandons the old job. That is the
// priority rule working, not a failure — say so without crying error.
function reportAnalysisError(label: string, err: unknown): void {
  if (err && (err as { superseded?: boolean }).superseded) console.log(`[auto-show] ${label} dropped: ${messageOf(err)}`);
  else console.error(`${label}:`, messageOf(err));
}

// Wires the auxiliary subsystems (MIDI feedback, Spotify, now-playing, PRO DJ
// LINK, auto-show) into the engine + state. Returns the integration handle that
// routes.js / sockets.js call back into.
function setupIntegrations({ io, midi, spotify, nowPlaying, deezerSource, prolink, autoShow, analysisCache = null,
  liveInput = null }: IntegrationDeps) {
  // Slot statuses, one per upcoming track up to state.autoPrefetchDepth.
  // slots[0] is the immediate next track (back-compat with the old
  // spotifyNext shape — that field still mirrors slots[0]).
  // Statuses: idle | prefetching | ready | queued | error | empty | unavailable
  let spotifySlots: PrefetchSlot[] = [];

  // Deezer prefetch slots (same shape/UI as spotifySlots), fed from the
  // extension's queue. lastDeezerQueueSig avoids rebuilding (and flickering
  // statuses) on every 1 Hz update when the queue hasn't actually changed.
  let deezerSlots: PrefetchSlot[] = [];
  let lastDeezerSlotsSig = '';

  function emptySlot(reason = 'empty', message = 'Queue is empty'): PrefetchSlot {
    return { track: null, status: reason, message, cacheKey: null };
  }

  function spotifyNextView(): PrefetchSlot {
    // Back-compat: callers (and the old UI) read `spotifyNext.track / .status /
    // .message / .cacheKey` directly. Keep that working by mirroring slot 0.
    return spotifySlots[0] || emptySlot('idle', '');
  }

  // The position the single-source modes (Spotify alone, the OS media
  // session, the Deezer extension) play the show against. It used to be the
  // last report plus the time since it arrived, re-anchored on every report —
  // so each report's error moved the show, and a report a little behind the
  // last one moved it backwards, which re-seeks the timeline and restarts the
  // pattern. The clock absorbs small errors into its speed instead and only
  // snaps on a real jump (a seek, a new track); see playback-clock.js.
  const sourceClock = new PlaybackClock();

  /** Fold one playback report from the active single source into the clock. */
  function observePlayback(playing: NowPlaying): void {
    const now = Date.now();
    sourceClock.observe(playing.progressMs, {
      isPlaying: playing.isPlaying,
      at: typeof playing.sampledAt === 'number' && Number.isFinite(playing.sampledAt) ? playing.sampledAt : now,
      now,
    });
  }

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

  function getAutoPositionMs(): number {
    return sourceClock.positionMs();
  }

  // The deck the running show's track is on. The show plays on that deck's
  // clock rather than on whichever deck is followed now: through a mix, the
  // outgoing track's show carries on while the incoming one is made ready.
  let showDeck: number | null = null;
  function getProlinkPositionMs(): number {
    return showDeck === null ? prolink.getPositionMs() : prolink.getDeckPositionMs(showDeck);
  }

  function getHybridPositionMs(): number { return hybrid.getPositionMs(); }

  // How many upcoming tracks to prefetch. Validated to 1..5 on the way in; the
  // clamp stays for a state object that did not come through validation.
  const prefetchDepth = () => Math.max(1, Math.min(5, state.autoPrefetchDepth || 1));

  // Each protocol's form of every change (protocol.ts): the whole live state
  // for the settings page and Companion, the keys that changed for the live
  // page.
  const publisher = createPublisher(io);

  function broadcast(): void {
    // Every edit to the patch ends in a broadcast, which makes this the one
    // place the show hears whether the rig has LED bars to draw on.
    if (typeof autoShow.setRig === 'function') {
      const rig = currentRig();
      autoShow.setRig({ hasPixels: rig.hasPixels, lamps: rig.fixtures.length });
    }
    publisher.publishState(getLiveState());
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
      // The operator has the show on — which a track change, loading the next
      // analysis, or playing by ear all keep true while no timeline runs.
      showOn: showWanted,
      deezer: deezerSource.getStatus(),
      deezerPrefetch: deezerSlots,
      prolink: {
        enabled: state.prolinkEnabled,
        connected: prolink.connected,
        peers: prolink.getNumPeers(),
        followed: prolink.getFollowed(),
        track: prolink.getTrack(),
        loadedTracks: prolink.getLoadedTracks(),
        bpm: prolink.getTempo(),
        stale: prolink.stale,
        lastError: prolink.lastError,
      },
      live: liveInput ? { ...liveInput.status(), director: liveDirector ? liveDirector.status() : null } : null,
      autoShow: autoShow.getClientState(),
      // Summaries, not the stored looks: a hundred full cues would ride every
      // broadcast, and the buttons only need a name and a swatch.
      cues: cues.summaries(),
      warm: warmer.status(),
      midi: { enabled: midi.enabled, ports: midi.listPorts() },
    };
  }
  setExtrasProvider(extras);

  // Hook the patch module so it can react to higher-level concerns.
  setHooks({
    broadcast,
    prolinkEnable: () => {
      prolink.enable().catch((err) => {
        console.error('PRO DJ LINK enable failed:', messageOf(err));
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
      const depth = prefetchDepth();
      if (spotifySlots.length > depth) {
        spotifySlots = spotifySlots.slice(0, depth);
      }
      broadcast();
      if (autoShow.running) prefetchNextFromQueue();
    },
  });

  // Pick the active source for auto-show playback. Explicit user choice wins,
  // then 'auto' falls through to:
  //   prolink > hybrid > spotify > deezer > nowplaying > live > timer
  //
  // Hybrid outranks plain Spotify whenever the OS media session is also live,
  // because it is the same source of content with a better clock and an
  // automatic fallback to exactly the Spotify behaviour when the session stops
  // matching — there is no state in which it is the worse of the two.
  //
  // Deezer (extension) outranks generic SMTC: when Deezer plays in the browser
  // both see it, but the extension carries ISRC + queue, so it should win.
  function resolveAutoSource(): AutoSource {
    if (state.autoSource === 'prolink' && prolink.connected) return 'prolink';
    // Hybrid asks only for Spotify: without the OS session it degrades to the
    // Spotify clock rather than refusing to run, which is what the operator
    // picking it would want on a machine where SMTC is unavailable.
    if (state.autoSource === 'hybrid' && spotify.authenticated) return 'hybrid';
    if (state.autoSource === 'spotify' && spotify.authenticated) return 'spotify';
    if (state.autoSource === 'deezer' && deezerSource.authenticated) return 'deezer';
    if (state.autoSource === 'nowplaying' && nowPlaying.authenticated) return 'nowplaying';
    if (state.autoSource === 'live' && liveListening()) return 'live';
    if (state.autoSource === 'timer') return 'timer';
    if (prolink.connected && prolink.getFollowed()) return 'prolink';
    if (spotify.authenticated && nowPlaying.authenticated) return 'hybrid';
    if (spotify.authenticated) return 'spotify';
    if (deezerSource.authenticated) return 'deezer';
    if (nowPlaying.authenticated) return 'nowplaying';
    // Something is heard but nothing names it: play by ear rather than
    // against a stopwatch.
    if (liveListening()) return 'live';
    return 'timer';
  }

  function liveListening(): boolean {
    return !!liveInput && liveInput.status().listening;
  }

  /** Sources that take their content and their queue from Spotify. */
  function usesSpotifyContent(source: AutoSource): boolean {
    return source === 'spotify' || source === 'hybrid';
  }

  // Whether the operator has the auto show on. It stays on across a track
  // change, while the show itself stops to load the next track's analysis.
  let showWanted = false;

  function startAutoShow(): AutoSource {
    const source = resolveAutoSource();
    showWanted = true;
    if (source === 'live') {
      // No timeline to play: the live director answers what is heard.
      syncLiveDirector();
      return source;
    }
    if (source === 'prolink') {
      showDeck = prolink.getFollowed()?.deviceId ?? null;
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
    syncLiveDirector();
    return source;
  }

  function stopAutoShow(): void {
    showWanted = false;
    autoShow.stop();
    syncLiveDirector();
  }

  // ─── Playing by ear ─────────────────────────────────────────────────────
  // With the auto show on and no timeline running — the source is `live`, or
  // the next track is still being analysed — the live director answers what
  // the live input hears. Its patches never reach the rig while a timeline
  // runs, so the second it takes to notice one has started cannot fight it.
  const liveDirector = liveInput ? new LiveDirector({
    applyPatch: (patch) => { if (!autoShow.running) applyPatch(patch); },
    patterns: PATTERNS,
    pixels: () => currentRig().hasPixels,
  }) : null;
  if (liveInput && liveDirector) {
    liveInput.onReading((r) => liveDirector.onReading(r));
    liveInput.onEvent((e) => liveDirector.onEvent(e));
  }

  function syncLiveDirector(): void {
    if (!liveDirector) return;
    const drive = showWanted && !autoShow.running && liveListening() && settings.get('live.director');
    if (drive && !liveDirector.active) liveDirector.start();
    else if (!drive && liveDirector.active) liveDirector.stop();
  }

  // ─── The pattern clock's track lock ─────────────────────────────────────
  // With the auto show off, manual patterns still lock to the music whenever
  // the song playing has a cached analysis: the conductor's `track` source
  // (see conductor.js). A running show outranks it, and a CDJ is followed
  // through its own grid instead, so this only ever names the track that the
  // playback source says is on and the clock that source is played from.

  // The last track each source reported, whether or not it was active then.
  const lastTrack: Record<'spotify' | 'nowplaying' | 'deezer', NowPlaying | null> = { spotify: null, nowplaying: null, deezer: null };
  // The track that is playing but not yet analysed, locked to once it is.
  let pendingTrackKey: string | null = null;
  let lockGeneration = 0;

  /** The playing track's cache key and clock, for the active source. */
  function playingTrack(): PlayingTrack | null {
    const source = resolveAutoSource();
    if (usesSpotifyContent(source) && lastTrack.spotify) {
      const p = lastTrack.spotify;
      return {
        key: keyForSpotify(p.trackId) || keyForQuery(`${p.artist} - ${p.name}`),
        clock: source === 'hybrid' ? getHybridPositionMs : getAutoPositionMs,
      };
    }
    if ((source === 'nowplaying' || source === 'deezer') && lastTrack[source]) {
      const p = lastTrack[source] as NowPlaying;
      return { key: keyForQuery(`${p.artist} - ${p.name}`), clock: getAutoPositionMs };
    }
    return null;
  }

  function lockTo(playing: PlayingTrack, grid: BeatGrid): void {
    pendingTrackKey = null;
    // The same position the auto show would play from, offset and all.
    conductor.setTrack({ key: playing.key, grid, positionMs: () => playing.clock() + autoShow.syncOffsetMs });
  }

  /**
   * Point the track lock at whatever is playing now. The grid comes from the
   * auto show when it already has this track in memory, else from the cache;
   * a track with no analysis yet is remembered and locked to when one lands.
   */
  function lockToPlayingTrack(): Promise<void> {
    const generation = ++lockGeneration;
    const playing = playingTrack();
    if (!playing || !playing.key) {
      pendingTrackKey = null;
      conductor.clearTrack();
      return Promise.resolve();
    }
    const inMemory = autoShow.gridFor(playing.key);
    if (inMemory) {
      lockTo(playing, inMemory);
      return Promise.resolve();
    }
    // Let go of the last song straight away: its beats read against this
    // song's position would be a beat grid for the wrong music.
    if (conductor.trackKey !== playing.key) conductor.clearTrack({ key: playing.key });
    pendingTrackKey = playing.key;
    // A running show loads the new song itself (restartShowFor) and locks from
    // memory once it has; reading the same megabytes here too would parse them
    // twice on the thread the render loop shares.
    if (autoShow.running || !analysisCache || !autoShow.isCached(playing.key)) return Promise.resolve();
    return analysisCache.load(playing.key)
      .then((analysis) => {
        if (generation !== lockGeneration) return;   // the track moved on meanwhile
        const grid = gridFromAnalysis(analysis);
        if (grid) lockTo(playing, grid);
      })
      .catch((err) => console.warn(`[conductor] could not load ${playing.key}: ${messageOf(err)}`));
  }

  // A prefetch, a warm or an analyse request that finishes for the song that
  // is on locks the patterns to it there and then.
  autoShow.onAnalysisCached = (key, analysis) => {
    if (!key || key !== pendingTrackKey) return;
    const playing = playingTrack();
    const grid = gridFromAnalysis(analysis);
    if (playing && playing.key === key && grid) lockTo(playing, grid);
  };

  // ─── Prolink callbacks ──────────────────────────────────────────────────
  prolink.onTempoChange((bpm) => {
    if (!state.prolinkEnabled) return;
    // Kept to a hundredth, not rounded: a deck pitched to 127.6 BPM is not at
    // 128, and a whole-number clock ran off its beat within a phrase. While
    // the deck is playing the clock follows its beats directly (conductor.js);
    // this is the tempo it keeps if the deck stops reporting.
    const tempo = Math.round(bpm * 100) / 100;
    if (tempo >= 20 && tempo <= 300 && Math.abs(tempo - state.bpm) >= 0.05) {
      state.bpm = tempo;
      conductor.setBpm(tempo, { manual: false });
      broadcast();
    }
  });
  prolink.onPeersChange((peers) => {
    console.log(`PRO DJ LINK devices: ${peers}`);
    broadcast();
  });
  prolink.onFollowChange(() => broadcast());
  // ─── CDJ tracks ─────────────────────────────────────────────────────────
  // A CDJ track is analysed from its own file, fetched off the player over
  // the network, whenever the player can hand it over: the analysis then lines
  // up with the deck, and with rekordbox's grid and phrases, to the
  // millisecond. A search by name is the fallback, under a key of its own.

  /** The analyses a CDJ track can have, best first. */
  function cdjSources(track: ProlinkTrack): { key: string; exact: boolean }[] {
    const out: { key: string; exact: boolean }[] = [];
    const exactKey = prolink.canFetchAudio(track) ? keyForProlinkTrack(track, { exact: true }) : null;
    if (exactKey) {
      autoShow.setExactAudio(exactKey, {
        fetch: async () => {
          const file = await prolink.fetchAudio(track);
          return file ? audioToTempWav(file.data, file.fileName) : null;
        },
        // rekordbox's grid and phrases, for this very file.
        refine: async (analysis) => applyRekordbox(analysis, {
          beatGrid: track.beatGrid,
          songStructure: await prolink.fetchSongStructure(track).catch((err) => {
            console.warn(`[prolink] no phrases for "${cdjQuery(track)}": ${messageOf(err)}`);
            return null;
          }),
        }),
      });
      out.push({ key: exactKey, exact: true });
    }
    const searchKey = track.title && track.artist ? keyForProlinkTrack(track) : null;
    if (searchKey) out.push({ key: searchKey, exact: false });
    return out;
  }


  const cdjQuery = (track: ProlinkTrack) => (track.title && track.artist ? `${track.artist} - ${track.title}` : `CDJ track ${track.trackId}`);
  const cdjDurationSec = (track: ProlinkTrack) => (track.durationMs ? track.durationMs / 1000 : null);

  /** Load a CDJ track's analysis as the show: its own file's, else a search's. */
  async function analyseCdjTrack(track: ProlinkTrack): Promise<void> {
    const sources = cdjSources(track);
    if (!sources.length) throw new Error('Track has no rekordbox metadata — cannot search');
    // An analysis already made plays now: making the exact one takes a
    // minute, and the prefetch has it ready by the next time the track loads.
    const ready = sources.find((s) => autoShow.isCached(s.key));
    let lastErr: unknown = null;
    for (const source of ready ? [ready] : sources) {
      try {
        await autoShow.downloadAndAnalyze(cdjQuery(track), source.exact ? null : cdjDurationSec(track), source.key);
        return;
      } catch (err) {
        if ((err as { superseded?: boolean }).superseded) throw err;
        lastErr = err;
        if (source.exact) console.warn(`[prolink] could not analyse the track's own file (${messageOf(err)}); searching for it instead`);
      }
    }
    throw lastErr;
  }

  /**
   * Analyse a CDJ track ahead of time — its own file, else a search — without
   * touching the running show. `current` for the track a mix is moving to:
   * it waits for an analysis already under way, and moves it to the front.
   */
  async function prefetchCdjTrack(track: ProlinkTrack, priority: AnalysisPriority = 'normal'): Promise<void> {
    const meta = { title: track.title || undefined, artist: track.artist || undefined };
    for (const source of cdjSources(track)) {
      if (autoShow.isCached(source.key)) return;
      const r = await autoShow.prefetch(cdjQuery(track), source.exact ? null : cdjDurationSec(track), source.key, meta, null, priority);
      if (r.skipped && r.reason === 'in-flight' && priority === 'current') {
        await autoShow.awaitInFlight(source.key, priority);
        if (autoShow.isCached(source.key)) return;
        continue;
      }
      if (r.skipped) return;
      if (!r.error) {
        console.log(`[prolink] prefetched ${source.exact ? 'from the player' : 'by search'}: ${cdjQuery(track)}`);
        return;
      }
      console.warn(`[prolink] prefetch ${source.exact ? 'from the player' : 'by search'} failed for "${cdjQuery(track)}": ${r.error}`);
    }
  }

  // Only the newest track change may start a show. One still making its
  // track ready has stopped the show, and a newer one must still take over.
  let cdjGeneration = 0;
  let cdjChanging = 0;

  prolink.onTrackChange(async (track, change) => {
    if (!track) return;
    console.log(`PRO DJ LINK track changed: ${track.artist || '?'} — ${track.title || '?'}`
      + (change?.handoff ? ` (mixed in from CDJ-${change.fromPlayer})` : ''));
    broadcast();
    if (!autoShow.running && !cdjChanging) return;
    if (resolveAutoSource() !== 'prolink') return;

    const generation = ++cdjGeneration;
    const isCurrent = () => generation === cdjGeneration;
    const toPlayer = change?.toPlayer ?? prolink.getFollowed()?.deviceId ?? null;
    const setTrack = () => {
      autoShow.track = {
        name: track.title || `Track ${track.trackId}`,
        artist: track.artist || 'PRO DJ LINK',
        album: track.album || '',
        albumArt: null,
        durationMs: track.durationMs || 0,
      };
    };
    cdjChanging++;
    try {
      // In a mix the outgoing show plays on, on its own deck, while the
      // incoming track's analysis is made; a new track on the same deck has
      // nothing left to play on.
      const outgoingPlays = !!change?.handoff && showDeck !== null && showDeck !== toPlayer;
      if (outgoingPlays) {
        await prefetchCdjTrack(track, 'current');
        if (!isCurrent()) return;
      }
      autoShow.stop();
      setTrack();
      broadcast();
      await analyseCdjTrack(track);
      if (!isCurrent()) return;
      showDeck = toPlayer;
      // How the lights follow the mix: a cut after a cut, else a blend timed
      // to the incoming track — onto its drop, or its next phrase
      // (show/transition.ts).
      const { fadeMs, reason } = transitionFor({
        analysis: autoShow.analysis, positionMs: getProlinkPositionMs(), bpm: prolink.getTempo(), change,
      });
      autoShow.start(getProlinkPositionMs, { fadeMs });
      console.log(`Auto show restarted for new CDJ track${fadeMs ? `, crossfading over ${(fadeMs / 1000).toFixed(1)} s (${reason})` : ` (${reason})`}`);
    } catch (err) {
      if ((err as { superseded?: boolean }).superseded) return;
      reportAnalysisError('PRO DJ LINK auto analysis failed', err);
    } finally {
      cdjChanging--;
    }
    broadcast();
  });
  prolink.onLoadedTracksChange(() => broadcast());

  // ─── Live input ─────────────────────────────────────────────────────────
  // Its status rides the broadcast: on every change, and once a second while
  // it listens, for the tempo and the level meter.
  // A known track's show is lined up with what it hears (auto-sync.ts),
  // except on a CDJ, whose position is exact, and by ear or on the timer,
  // which have no track.
  const autoSync = liveInput ? new AutoSync({
    show: autoShow,
    live: liveInput,
    enabled: () => settings.get('live.autoSync') && !['prolink', 'live', 'timer'].includes(resolveAutoSource()),
  }) : null;
  if (liveInput) {
    liveInput.onStatus(() => broadcast());
    const liveTimer = setInterval(guarded('live input', () => {
      syncLiveDirector();
      if (!liveInput.running) return;
      if (autoSync) autoSync.tick();
      broadcast();
    }), 1000);
    liveTimer.unref();
  }

  // Analyse every track loaded on any CDJ ahead of time. Fires once per track
  // (deviceId:slot:trackId) per session.
  prolink.onAnyTrackLoaded((track) => {
    prefetchCdjTrack(track).catch((err) => console.warn(`[prolink] prefetch failed: ${messageOf(err)}`));
  });

  // ─── Spotify polling ────────────────────────────────────────────────────
  spotify.onPlaybackUpdate((playing) => {
    // Fed to the hybrid source unconditionally, whichever source is active, so
    // that switching to it mid-show does not start from a cold clock. It only
    // ever *reads* Spotify's position when the OS session cannot supply one.
    hybrid.observeContent(playing,
      typeof playing.sampledAt === 'number' && Number.isFinite(playing.sampledAt) ? playing.sampledAt : undefined);

    if (!usesSpotifyContent(resolveAutoSource())) return;
    observePlayback(playing);

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
  async function prefetchNextFromQueue(): Promise<void> {
    if (!spotify.authenticated) return;
    lastQueuePeekAt = Date.now();
    const depth = prefetchDepth();

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
              slot.message = messageOf(err);
              broadcast();
            }
            console.warn(`[prefetch] unexpected error: ${messageOf(err)}`);
          });
      }
    } catch (err) {
      spotifySlots = [{ track: null, status: 'error', message: messageOf(err), cacheKey: null }];
      broadcast();
      console.warn(`[prefetch] queue lookup failed: ${messageOf(err)}`);
    }
  }

  /**
   * A new track on a source that is driving a running show: stop, analyse the
   * new track (or load it from cache), and start again on the given clock.
   *
   * Shared by every source that reports tracks rather than handing over audio.
   * What differs between them — whether they are the active source, the cache
   * key, which clock the show follows — is decided by the caller.
   */
  async function restartShowFor(playing: NowPlaying,
    { cacheKey, clock, what }: { cacheKey?: string | null; clock: () => number; what: string }): Promise<void> {
    autoShow.stop();
    autoShow.track = {
      name: playing.name, artist: playing.artist, album: playing.album,
      albumArt: playing.albumArt, durationMs: playing.durationMs,
    };
    broadcast();
    try {
      const query = `${playing.artist} - ${playing.name}`;
      // An ISRC means the exact audio through src/deezer.js; without one, or
      // when that fails, yt-dlp searches for the query.
      await autoShow.downloadAndAnalyze(query, playing.durationMs / 1000, cacheKey || keyForQuery(query), playing.isrc);
      autoShow.start(clock);
      console.log(`Auto show restarted for new ${what} track`);
    } catch (err) {
      reportAnalysisError(`${what} auto analysis failed for new track`, err);
    }
    // The show has the new song in memory now; lock to it for when it stops.
    lockToPlayingTrack();
    broadcast();
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
    lastTrack.spotify = playing;
    const source = resolveAutoSource();
    if (!usesSpotifyContent(source)) return;
    lockToPlayingTrack();
    if (autoShow.running) {
      await restartShowFor(playing, {
        cacheKey: keyForSpotify(playing.trackId),
        clock: source === 'hybrid' ? getHybridPositionMs : getAutoPositionMs,
        what: 'Spotify',
      });
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
    observePlayback(playing);
  });

  nowPlaying.onTrackChange(async (playing) => {
    console.log(`Now playing changed: ${playing.artist} — ${playing.name}`);
    lastTrack.nowplaying = playing;
    if (resolveAutoSource() !== 'nowplaying') return;
    lockToPlayingTrack();
    if (!autoShow.running) return;
    await restartShowFor(playing, { clock: getAutoPositionMs, what: 'now-playing' });
  });

  // ─── Deezer (browser extension) ─────────────────────────────────────────
  deezerSource.onPlaybackUpdate((playing) => {
    if (resolveAutoSource() !== 'deezer') return;
    observePlayback(playing);
  });

  deezerSource.onTrackChange(async (playing) => {
    console.log(`Deezer track changed: ${playing.artist} — ${playing.name}`);
    lastTrack.deezer = playing;
    if (resolveAutoSource() !== 'deezer') return;
    lockToPlayingTrack();
    if (!autoShow.running) return;
    await restartShowFor(playing, { clock: getAutoPositionMs, what: 'Deezer' });
  });

  // Build prefetch slots for the upcoming Deezer queue (the extension can see
  // it; SMTC can't) and warm the analysis cache, mirroring the Spotify "up
  // next" list. Only when Deezer is the active source, so we don't burn the
  // analyzer while another source drives the show. autoShow.prefetch dedupes on
  // cache + in-flight, so re-running is cheap.
  function prefetchDeezerQueue(): void {
    if (resolveAutoSource() !== 'deezer') {
      if (deezerSlots.length) { deezerSlots = []; lastDeezerSlotsSig = ''; broadcast(); }
      return;
    }
    const depth = prefetchDepth();
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

    const slots = upcoming.map((t, queuePos): PrefetchSlot => {
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
  let lastPosition: Partial<AutoPosition> = {};
  const positionTimer = setInterval(guarded('auto-position', () => {
    const position = sampleAutoPosition(autoShow, lastPosition);
    if (position.running || JSON.stringify(position) !== JSON.stringify(lastPosition)) {
      io.emit('auto-position', position);
    }
    lastPosition = position;
  }), 100);
  if (positionTimer.unref) positionTimer.unref();

  // DMX values on their own high-rate channel. This is the only field that
  // genuinely changes every frame; sending it alone keeps the 10 Hz payload at
  // ~100 bytes instead of ~7 KB, and lets the client re-render just the DMX
  // views instead of the whole tree. Only for protocol 1 pages, and only
  // built while one is connected.
  let lastDmxJson = '';
  const dmxTimer = setInterval(guarded('dmx-broadcast', () => {
    if (!publisher.wants(ROOM.v1)) { lastDmxJson = ''; return; }
    const snapshot = getDmxSnapshot();
    const json = JSON.stringify(snapshot);
    if (json === lastDmxJson) return;      // blackout / idle rig: nothing to send
    lastDmxJson = json;
    io.to(ROOM.v1).emit('dmx', snapshot);
  }), 100);
  if (dmxTimer.unref) dmxTimer.unref();

  // And as bytes, thirty times a second, to the protocol 2 pages that have
  // asked for it — the monitor open, a preview showing live output.
  const dmxFrameTimer = setInterval(guarded('dmx-frame', () => {
    if (!publisher.wants(ROOM.dmx)) { publisher.resetDmx(); return; }
    publisher.sendDmxFrame(encodeDmxFrame(getDmxUniverses()));
  }), 1000 / 30);
  if (dmxFrameTimer.unref) dmxFrameTimer.unref();

  // Some status fields drift without any explicit event — `authenticated` on
  // the now-playing and Deezer sources expires on a staleness timer, and
  // Spotify's poll updates status without calling broadcast(). A low-rate
  // dirty-checked sweep picks those up; broadcast() covers everything else the
  // moment it changes.
  const statusTimer = setInterval(guarded('status-broadcast', broadcast), 1000);
  if (statusTimer.unref) statusTimer.unref();

  return {
    broadcast,
    publisher,
    warmer,
    hybrid,
    prefetchNextFromQueue,
    clearSpotifyNext: () => {
      spotifySlots = [{ track: null, status: 'unavailable', message: 'Spotify disconnected', cacheKey: null }];
    },
    startAutoShow,
    stopAutoShow,
    resolveAutoSource,
    analyseCdjTrack,
    lockToPlayingTrack,
    // Called by the Deezer browser extension (via routes) with the web player's
    // current track + upcoming queue.
    onDeezerState(payload: DeezerState | null | undefined) {
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

export {
  setupIntegrations,
};
