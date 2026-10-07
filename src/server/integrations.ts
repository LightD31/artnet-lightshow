import { transitionFor } from '../show/transition.ts';
import { state, getLiveState, getDmxSnapshot, getDmxUniverses, setExtrasProvider, setSequenceProvider, setSequenceRuns, reconcileFreeClock, voices, strobe } from './state.ts';
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
import { baseEffect, effectChanged, identify, setAudioSource, setEffectSource, setSequenceSource } from './engine.ts';
import { AudioFeatures, feedOf, resolveDetectors } from './audio-features.ts';
import { BIN_HZ } from '../shared/spectrum-bands.ts';
import { safety } from './safety.ts';
import { EffectLibrary } from './effect-library.ts';
import { PaletteStore } from './palette-store.ts';
import { PadStore, Pads, patternPlayer } from './pads.ts';
import { presetLookup } from './routes/voices.ts';
import { padTakeOf, sequenceBeatAhead, Sequencer } from './sequencer.ts';
import { SequenceStore } from './sequence-store.ts';
import { toHex } from '../shared/effects/palette.ts';
import { configFile } from './config-dir.ts';
import type { Server } from 'socket.io';
import type AutoShow from '../auto-show.ts';
import type { AnalysisCache } from '../analysis-cache.ts';
import type DeezerSource from '../deezer-source.ts';
import type MidiController from '../midi.ts';
import type NowPlayingSource from '../nowplaying-source.ts';
import type ProLink from '../prolink.ts';
import type LiveInput from '../live-input.ts';
import type { LiveReading } from '../live-input.ts';
import type { ProlinkTrack } from '../prolink.ts';
import type { AnalysisPriority } from '../analyzer-worker.ts';
import type SpotifyClient from '../spotify.ts';
import type { BeatGrid } from '../shared/beat-clock.ts';
import type { AutoPosition } from './auto-position.ts';
import type { DeezerState } from './validation.ts';
import type { NowPlaying } from '../types/playback.ts';
import type { AudioFrame } from '../shared/effects/audio-frame.ts';
import type { Detectors } from './audio-features.ts';
import type { EffectSpec } from '../shared/effects/types.ts';

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
  effectLibrary?: EffectLibrary | null;
  paletteStore?: PaletteStore | null;
  padStore?: PadStore | null;
  sequenceStore?: SequenceStore | null;
}

export type AutoSource = 'prolink' | 'hybrid' | 'spotify' | 'deezer' | 'nowplaying' | 'live' | 'timer';

interface SlotTrack {
  name: string;
  artist: string;
  album: string;
  albumArt: string | null;
  durationMs: number;
}

export interface PrefetchSlot {
  track: SlotTrack | null;
  status: string;
  message: string;
  cacheKey: string | null;
}

interface PlayingTrack {
  key: string | null;
  clock: () => number;
}

function reportAnalysisError(label: string, err: unknown): void {
  if (err && (err as { superseded?: boolean }).superseded) console.log(`[auto-show] ${label} dropped: ${messageOf(err)}`);
  else console.error(`${label}:`, messageOf(err));
}

function setupIntegrations({ io, midi, spotify, nowPlaying, deezerSource, prolink, autoShow, analysisCache = null,
  liveInput = null, effectLibrary = null, paletteStore = null, padStore = null, sequenceStore = null }: IntegrationDeps) {
  const library = {
    effects: effectLibrary ?? new EffectLibrary(configFile('effects.json')).load(),
    palettes: paletteStore ?? new PaletteStore(configFile('palettes.json')).load(),
  };
  const pads = new Pads({
    voices, store: padStore ?? new PadStore(configFile('pads.json')).load(), lookup: () => presetLookup(library),
    pattern: (id): ReturnType<SequenceStore['getPattern']> => sequence.store.getPattern(id),
    fixtureIds: () => state.fixtures.map((f) => f.id), beat: () => conductor.peek().beatPos, strobe,
    patternVoice: patternPlayer({
      voices, pattern: (id): ReturnType<SequenceStore['getPattern']> => sequence.store.getPattern(id), fixtureIds: () => state.fixtures.map((f) => f.id),
      resolve: (id) => library.effects.resolve(id),
    }),
  });
  midi.pads = {
    press: (bank, slot, owner, token) => pads.press(bank, slot, owner, token),
    renew: (_bank, _slot, owner, token) => voices.renew(owner, token),
    release: (bank, slot, owner, token) => { pads.release(bank, slot, owner, token); voices.release(owner, token); },
    strobeMaxMs: () => settings.get('safety.strobeMaxLatchSec') * 1000,
  };

  let sequenceNews: ReturnType<typeof setTimeout> | null = null;
  function broadcastSoon(): void {
    if (sequenceNews) return;
    sequenceNews = setTimeout(guarded('sequence-broadcast', () => { sequenceNews = null; broadcast(); }), 100);
    if (sequenceNews.unref) sequenceNews.unref();
  }
  const sequence = {
    store: sequenceStore ?? new SequenceStore(configFile('sequences.json')).load(),
    sequencer: new Sequencer({
      resolve: (id) => library.effects.resolve(id),
      palette: (id) => library.palettes.materialize(id)?.map(toHex) ?? null,
      apply: ({ paletteOverrideId, ...patch }) => {
        // A refusal here must not cost the frame its sequence.
        try {
          applyPatch(patch, { origin: 'sequence', paletteOverrideId });
        } catch (err) {
          console.warn(`[sequence] could not apply ${Object.keys(patch).join(', ')}: ${messageOf(err)}`);
        }
        broadcastSoon();
      },
      current: () => ({ masterDimmer: state.masterDimmer, bpm: state.bpm, paletteOverride: state.paletteOverride ? state.paletteOverride.map(toHex) : null, paletteOverrideId: state.paletteOverrideId }),
      musicMode: (mode) => {
        try {
          settings.update({ audio: { mode } });
        } catch (err) {
          console.warn(`[sequence] could not set the audio mode to ${mode}: ${messageOf(err)}`);
        }
      },
      admit: (spec) => safety.requireAcknowledged(spec),
      fixtureIds: () => state.fixtures.map((f) => f.id),
      pattern: (id): ReturnType<SequenceStore['getPattern']> => sequence.store.getPattern(id),
      pad: (bank, slot) => padTakeOf(pads.store.get(bank, slot), presetLookup(library)),
      beat: () => conductor.peek().beatPos,
      onRun: () => reconcileFreeClock(),
    }),
  };
  const toSequenceBeat = (beat: number) => {
    const at = sequence.sequencer.status();
    return sequenceBeatAhead(at.beat, beat - conductor.peek().beatPos, at.loop);
  };
  pads.insertPattern = (id, atBeat) => {
    sequence.sequencer.dropPattern(id, toSequenceBeat(atBeat), atBeat);
    broadcast();
  };
  pads.onHit = ({ bank, slot, startBeat, endBeat, lengthMs, once }) => {
    if (!sequence.sequencer.recording()) return;
    const lengthBeats = lengthMs === undefined ? undefined : (lengthMs * conductor.peek().bpm) / 60000;
    sequence.sequencer.onPadHit({
      bank, slot, startBeat: toSequenceBeat(startBeat), clockBeat: startBeat,
      ...(endBeat === undefined ? {} : { heldBeats: endBeat - startBeat }), ...(lengthBeats === undefined ? {} : { lengthBeats }), ...(once ? { once } : {}),
    });
    broadcast();
  };
  setSequenceSource((reading) => {
    pads.sweep();
    return sequence.sequencer.frame(reading);
  });
  setSequenceProvider(() => sequence.sequencer.status());
  setSequenceRuns(() => sequence.sequencer.runs());
  let spotifySlots: PrefetchSlot[] = [];

  let deezerSlots: PrefetchSlot[] = [];
  let lastDeezerSlotsSig = '';

  function emptySlot(reason = 'empty', message = 'Queue is empty'): PrefetchSlot {
    return { track: null, status: reason, message, cacheKey: null };
  }

  function spotifyNextView(): PrefetchSlot {
    return spotifySlots[0] || emptySlot('idle', '');
  }

  const sourceClock = new PlaybackClock();

  function observePlayback(playing: NowPlaying): void {
    const now = Date.now();
    sourceClock.observe(playing.progressMs, {
      isPlaying: playing.isPlaying,
      at: typeof playing.sampledAt === 'number' && Number.isFinite(playing.sampledAt) ? playing.sampledAt : now,
      now,
    });
  }

  const hybrid = new HybridSource();

  const warmer = new Warmer({ autoShow, onChange: () => broadcast() });

  let lastQueuePeekAt = 0;
  const QUEUE_PEEK_INTERVAL_MS = 15000;

  function getAutoPositionMs(): number {
    return sourceClock.positionMs();
  }

  let showDeck: number | null = null;
  function getProlinkPositionMs(): number {
    return showDeck === null ? prolink.getPositionMs() : prolink.getDeckPositionMs(showDeck);
  }

  function getHybridPositionMs(): number { return hybrid.getPositionMs(); }

  const prefetchDepth = () => Math.max(1, Math.min(5, state.autoPrefetchDepth || 1));

  const publisher = createPublisher(io);

  function broadcast(): void {
    if (typeof autoShow.setRig === 'function') {
      const rig = currentRig();
      autoShow.setRig({ hasPixels: rig.hasPixels, hasPanels: rig.hasPanels, lamps: rig.fixtures.length });
    }
    publisher.publishState(getLiveState());
    midi.sendFeedback();
  }

  function extras() {
    return {
      spotify: spotify.getStatus(),
      spotifyNext: spotifyNextView(),
      spotifyPrefetch: spotifySlots,
      nowPlaying: nowPlaying.getStatus(),
      hybrid: hybrid.getStatus(),
      activeSource: resolveAutoSource(),
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
      audio: liveAudio(),
      autoShow: autoShow.getClientState(),
      cues: cues.summaries(),
      effects: library.effects.summaries(),
      userPalettes: library.palettes.list(),
      pads: pads.view(),
      // The saved sequences and patterns by id and name, so one saved on another page reaches the pickers.
      sequences: sequence.store.summaries(),
      sequencePatterns: sequence.store.patternSummaries(),
      warm: warmer.status(),
      midi: { enabled: midi.enabled, ports: midi.listPorts() },
      identify: identify.status(),
    };
  }
  setExtrasProvider(extras);

  setHooks({
    broadcast,
    handEdit: (edit) => sequence.sequencer.handEdit(edit),
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
      const depth = prefetchDepth();
      if (spotifySlots.length > depth) {
        spotifySlots = spotifySlots.slice(0, depth);
      }
      broadcast();
      if (autoShow.running) prefetchNextFromQueue();
    },
  });

  // Prefer richer matching sources while retaining fallbacks when their clock or metadata disappears.
  function resolveAutoSource(): AutoSource {
    if (state.autoSource === 'prolink' && prolink.connected) return 'prolink';
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
    if (liveListening()) return 'live';
    return 'timer';
  }

  function liveListening(): boolean {
    return !!liveInput && liveInput.status().listening;
  }

  function usesSpotifyContent(source: AutoSource): boolean {
    return source === 'spotify' || source === 'hybrid';
  }

  let showWanted = false;

  function startAutoShow({ fromMs = 0 }: { fromMs?: number } = {}): AutoSource {
    const source = resolveAutoSource();
    showWanted = true;
    if (source === 'live') {
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
      const startTime = Date.now() - fromMs;
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

  // Suppress live-director patches while a timeline plays so the two cannot fight over the look.
  const liveDirector = liveInput ? new LiveDirector({
    applyPatch: (patch) => { if (!autoShow.running) applyPatch(patch); },
    patterns: PATTERNS,
    pixels: () => currentRig().hasPixels,
  }) : null;
  if (liveInput && liveDirector) liveInput.onEvent((e) => liveDirector.onEvent(e));

  function syncLiveDirector(): void {
    if (!liveDirector) return;
    const drive = showWanted && !autoShow.running && liveListening() && settings.get('live.director');
    if (drive && !liveDirector.active) liveDirector.start();
    else if (!drive && liveDirector.active) liveDirector.stop();
  }

  function detectors(): Detectors {
    const nowMs = performance.now();
    const fixtureIds = state.fixtures.map((f) => f.id);
    return resolveDetectors({
      base: baseEffect(), clips: sequence.sequencer.playing(fixtureIds), voices: voices.frames(nowMs), nowMs,
      beatPos: sequence.sequencer.lastBeat(),
      fixtureIds, ldjTrigger: settings.get('audio.ldjTrigger'),
      acknowledged: settings.get('safety.photosensitivityAcknowledged'),
    });
  }
  const audioFeatures = new AudioFeatures({
    master: () => settings.get('audio.master'),
    disco: () => detectors().disco,
    ldjTrigger: () => detectors().spl.trigger,
    binHz: BIN_HZ,
    onBands: () => queueMicrotask(guarded('audio bands', () => { if (liveInput) liveInput.refreshBands(); })),
  });
  if (liveInput) {
    liveInput.useBands(() => audioFeatures.bandList());
    // Guard both live listeners independently so failure in one cannot starve the other.
    const directorHears = liveDirector ? guarded('live director', (r: LiveReading) => liveDirector.onReading(r)) : null;
    const featuresHear = guarded('audio features', (r: LiveReading) => audioFeatures.onReading(r));
    liveInput.onReading((r) => {
      if (directorHears) directorHears(r);
      featuresHear(r);
    });
  }

  function heard(): AudioFrame | null {
    const streamNowMs = liveInput ? liveInput.streamNowMs() : null;
    return audioFeatures.heard(streamNowMs === null ? undefined : streamNowMs / 1000);
  }
  setAudioSource(heard);

  function heardSummary() {
    const frame = heard();
    return {
      listening: !!frame,
      levels: frame ? { ...frame.party } : null,
      spl: frame ? { db: frame.spl.db, level: frame.spl.level, beat: frame.spl.beat, section: frame.spl.section } : null,
    };
  }

  function audioSummary(heardNow = heardSummary()) {
    const d = detectors();
    return {
      ...settings.group('audio'),
      ...heardNow,
      detectors: {
        spl: d.spl,
        disco: { owner: d.disco.owner, bands: d.disco.bands, globals: d.disco.globals },
      },
    };
  }

  const HEARD_EVERY_MS = 900;
  let heardAt = -Infinity;
  let heardThen = heardSummary();
  function liveAudio() {
    const now = Date.now();
    if (now - heardAt >= HEARD_EVERY_MS) { heardAt = now; heardThen = heardSummary(); }
    return audioSummary(heardThen);
  }

  const lastTrack: Record<'spotify' | 'nowplaying' | 'deezer', NowPlaying | null> = { spotify: null, nowplaying: null, deezer: null };
  let pendingTrackKey: string | null = null;
  let lockGeneration = 0;

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
    conductor.setTrack({ key: playing.key, grid, positionMs: () => playing.clock() + autoShow.syncOffsetMs });
  }

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
    if (conductor.trackKey !== playing.key) conductor.clearTrack({ key: playing.key });
    pendingTrackKey = playing.key;
    if (autoShow.running || !analysisCache || !autoShow.isCached(playing.key)) return Promise.resolve();
    return analysisCache.load(playing.key)
      .then((analysis) => {
        if (generation !== lockGeneration) return;   // the track moved on meanwhile
        const grid = gridFromAnalysis(analysis);
        if (grid) lockTo(playing, grid);
      })
      .catch((err) => console.warn(`[conductor] could not load ${playing.key}: ${messageOf(err)}`));
  }

  autoShow.onAnalysisCached = (key, analysis) => {
    if (!key || key !== pendingTrackKey) return;
    const playing = playingTrack();
    const grid = gridFromAnalysis(analysis);
    if (playing && playing.key === key && grid) lockTo(playing, grid);
  };

  prolink.onTempoChange((bpm) => {
    if (!state.prolinkEnabled) return;
    const tempo = Math.round(bpm * 100) / 100;
    if (tempo >= 20 && tempo <= 300 && Math.abs(tempo - state.bpm) >= 0.05
      && conductor.setBpm(tempo, { manual: false })) {
      state.bpm = tempo;
      broadcast();
    }
  });
  prolink.onPeersChange((peers) => {
    console.log(`PRO DJ LINK devices: ${peers}`);
    broadcast();
  });
  prolink.onFollowChange(() => broadcast());

  function cdjSources(track: ProlinkTrack): { key: string; exact: boolean }[] {
    const out: { key: string; exact: boolean }[] = [];
    const exactKey = prolink.canFetchAudio(track) ? keyForProlinkTrack(track, { exact: true }) : null;
    if (exactKey) {
      autoShow.setExactAudio(exactKey, {
        fetch: async () => {
          const file = await prolink.fetchAudio(track);
          return file ? audioToTempWav(file.data, file.fileName) : null;
        },
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

  async function analyseCdjTrack(track: ProlinkTrack): Promise<void> {
    const sources = cdjSources(track);
    if (!sources.length) throw new Error('Track has no rekordbox metadata — cannot search');
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

  // Only the latest track preparation may start a show so a slow older request cannot take over.
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

  prolink.onAnyTrackLoaded((track) => {
    prefetchCdjTrack(track).catch((err) => console.warn(`[prolink] prefetch failed: ${messageOf(err)}`));
  });

  spotify.onPlaybackUpdate((playing) => {
    // Feed the hybrid source even when inactive so switching to it retains a warm clock.
    hybrid.observeContent(playing,
      typeof playing.sampledAt === 'number' && Number.isFinite(playing.sampledAt) ? playing.sampledAt : undefined);

    if (!usesSpotifyContent(resolveAutoSource())) return;
    observePlayback(playing);

    if (autoShow.running && Date.now() - lastQueuePeekAt >= QUEUE_PEEK_INTERVAL_MS) {
      lastQueuePeekAt = Date.now();
      prefetchNextFromQueue();
    }
  });

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

      const upcoming = queue.filter((t) => t && t.trackId).slice(0, depth);
      if (!upcoming.length) {
        spotifySlots = [emptySlot('empty', 'Queue is empty')];
        broadcast();
        return;
      }

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

      // Re-rank waiting prefetches before adding jobs so reshaped queues keep their nearest tracks first.
      autoShow.applyQueueOrder(newSlots.map((s) => s.cacheKey));

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
      await autoShow.downloadAndAnalyze(query, playing.durationMs / 1000, cacheKey || keyForQuery(query), playing.isrc);
      autoShow.start(clock);
      console.log(`Auto show restarted for new ${what} track`);
    } catch (err) {
      reportAnalysisError(`${what} auto analysis failed for new track`, err);
    }
    lockToPlayingTrack();
    broadcast();
  }

  spotify.onTrackChange(async (playing) => {
    console.log(`Spotify track changed: ${playing.artist} — ${playing.name}`);
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

  nowPlaying.onPlaybackUpdate((playing) => {
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

  function prefetchDeezerQueue(): void {
    if (resolveAutoSource() !== 'deezer') {
      if (deezerSlots.length) { deezerSlots = []; lastDeezerSlotsSig = ''; broadcast(); }
      return;
    }
    const depth = prefetchDepth();
    const upcoming = deezerSource.getQueue().slice(0, depth);

    // Derive queue status from current cache and jobs so reordered tracks cannot revert spuriously to prefetching.

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

    const sig = slots.map((s) => `${s.cacheKey}:${s.status}`).join('|');
    deezerSlots = slots;
    if (sig === lastDeezerSlotsSig) return;
    lastDeezerSlotsSig = sig;
    broadcast();
  }

  let lastPosition: Partial<AutoPosition> = {};
  const positionTimer = setInterval(guarded('auto-position', () => {
    const position = sampleAutoPosition(autoShow, lastPosition);
    if (position.running || JSON.stringify(position) !== JSON.stringify(lastPosition)) {
      io.emit('auto-position', position);
    }
    lastPosition = position;
  }), 100);
  if (positionTimer.unref) positionTimer.unref();

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

  const dmxFrameTimer = setInterval(guarded('dmx-frame', () => {
    if (!publisher.wants(ROOM.dmx)) { publisher.resetDmx(); return; }
    publisher.sendDmxFrame(encodeDmxFrame(getDmxUniverses()));
  }), 1000 / 30);
  if (dmxFrameTimer.unref) dmxFrameTimer.unref();

  const audioTimer = setInterval(guarded('audio-feed', () => {
    if (!publisher.wants(ROOM.audio)) { publisher.resetAudio(); return; }
    publisher.sendAudio(feedOf(heard()));
  }), 1000 / 30);
  if (audioTimer.unref) audioTimer.unref();

  const statusTimer = setInterval(guarded('status-broadcast', broadcast), 1000);
  if (statusTimer.unref) statusTimer.unref();

  setEffectSource((pattern) => library.effects.resolve(pattern));
  library.effects.setAdmission((id: string, spec: EffectSpec) => {
    if (id === state.pattern) safety.requireAcknowledged(spec);
  });
  library.effects.onChange(() => {
    effectChanged();
    broadcast();
  });
  library.palettes.onChange(() => broadcast());
  pads.store.onChange(() => broadcast());
  sequence.store.onChange(() => broadcast());

  return {
    broadcast,
    publisher,
    warmer,
    audio: { features: audioFeatures, summary: audioSummary, detectors },
    library,
    pads,
    sequence,
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
