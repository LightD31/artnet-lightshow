import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { settings } from './server/settings.ts';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import * as deezer from './deezer.ts';
import AnalyzerWorker from './analyzer-worker.ts';
import { describeModelUsage, formatModelUsage } from './model-usage.ts';
import * as pythonEnv from './python-env.ts';
import { SYNC_OFFSET_LIMIT_MS } from './server/presets.ts';
import { ShowDirector, measureBuildup } from './show/director.ts';
import { renderIntents } from './show/render.ts';
import { guarded } from './server/guard.ts';
import { resolveIsrc, splitQuery } from './isrc.ts';
import { gridFromAnalysis } from './shared/beat-clock.ts';
import * as ytdlp from './ytdlp.ts';
import { messageOf } from './errors.ts';
import type { AnalysisCache, CacheMeta } from './analysis-cache.ts';
import type { AnalysisPriority } from './analyzer-worker.ts';
import type { BeatGrid } from './shared/beat-clock.ts';
import type { PatternDescriptor } from './show/director.ts';
import type { Intent } from './show/intents.ts';
import type { EnergyData, PatchData, TimelineEvent } from './show/render.ts';
import type { Analysis } from './show/score.ts';

export type AutoShowStatus = 'idle' | 'downloading' | 'analyzing' | 'ready' | 'playing';

/** The track the show is for, as the playback source named it. */
export interface ShowTrack {
  name?: string;
  artist?: string;
  [key: string]: unknown;
}

/** A colour preset, as far as finding the blackout goes. */
interface NamedPreset {
  name?: string;
  id?: string;
}

// Exact-audio sources remembered, newest last: the tracks on the decks and a
// few before them.
const EXACT_AUDIO_KEPT = 32;

/** What prefetch() did. */
export interface PrefetchResult {
  skipped: boolean;
  reason?: string;
  error?: string;
}

/** A timeline patch as it is replayed: the renderer's fields, and the scheduled time. */
type ReplayedPatch = PatchData & { masterDimmer?: number; masterBlackout?: boolean; anchorMs?: number };

// A download that never finishes is indistinguishable from one that never
// started: the track change waits on this promise, so an unresponsive network
// or a yt-dlp stuck on an extractor would leave the show on the previous
// track's timeline with no error and no recovery. The analyzer worker already
// bounds its own stage; this bounds the download.
function downloadTimeoutMs(): number {
  return settings.get('analysis.downloadTimeoutMs');
}

/** The show moved on to another track before this analysis finished. */
function supersededError(): Error & { superseded: true } {
  return Object.assign(new Error('superseded by a newer current track'), { superseded: true as const });
}

// The look vocabulary — palette banks, genre styles, pattern pools — lives in
// src/show/look.js, and the decisions that use it live in src/show/director.js.
// This file owns fetching audio, driving the analyser and playing a timeline
// back in sync; it deliberately no longer owns any opinion about what the show
// should look like.

/**
 * Auto-show engine: runs librosa analysis on audio, generates a timeline
 * of light-show events, and plays them back in sync with Spotify.
 *
 * IMPORTANT: The auto-show NEVER touches `masterDimmer`. That slider belongs
 * to the operator. Intensity is instead expressed through pattern choice,
 * strobe speed, brief energy overrides, and pattern tempo.
 *
 * Lifecycle:
 *   1. analyze(source)   – run analysis on a file or URL → analysis JSON
 *   2. buildTimeline()   – convert analysis into timed light events
 *   3. start(getPositionMs) – begin playback loop
 *   4. stop()            – halt playback
 */
class AutoShow {
  declare _applyPatch: (patch: object) => unknown;
  declare _colorPresets: readonly NamedPreset[];
  declare _patterns: readonly PatternDescriptor[];
  declare _cache: AnalysisCache | null;
  declare _worker: AnalyzerWorker;
  declare _blackoutIdx: number;
  declare analysis: Analysis | null;
  declare timeline: TimelineEvent[];
  declare timelineRevision: string;
  declare running: boolean;
  declare track: ShowTrack | null;
  declare palette: number[] | null;
  declare paletteName: string | null;
  declare paletteSize: number | 'auto';
  declare resolvedPaletteSize: number | undefined;
  declare intents: Intent[] | undefined;
  declare intensity: number;
  declare syncOffsetMs: number;
  declare _getPositionMs: (() => number) | null;
  declare _loopTimer: ReturnType<typeof setInterval> | null;
  declare _lastEventIdx: number;
  declare _lastPositionMs: number | undefined;
  declare _status: AutoShowStatus;
  declare _energyTimer: ReturnType<typeof setTimeout> | null;
  declare _inFlight: Map<string, Promise<Analysis>>;
  declare _exactAudio: Map<string, () => Promise<string | null>>;
  declare _currentJob: symbol | null;
  declare _grid: BeatGrid | null;
  declare _pixels: boolean;
  declare analysisKey: string | null;
  declare _frameDriven: boolean;
  declare _anchorIndex: { timeline: TimelineEvent[]; length: number; times: number[] } | undefined;
  declare onAnalysisCached: ((cacheKey: string, analysis: Analysis) => void) | null;

  declare static PYTHON_EXE: string;

  constructor(applyPatch: (patch: object) => unknown, colorPresets: readonly NamedPreset[],
    patterns: readonly PatternDescriptor[], cache: AnalysisCache | null = null) {
    this._applyPatch = applyPatch;
    this._colorPresets = colorPresets;
    this._patterns = patterns;
    this._cache = cache;
    this._worker = new AnalyzerWorker(
      pythonEnv.pythonExe, path.join(import.meta.dirname, 'analyze.py'),
    );
    // Spin up the Python process immediately so its imports + PANNs preload
    // happen during server startup, hidden behind the user opening the UI
    // and connecting Spotify. Without this, the first analyze() pays the
    // full ~10s cold-start cost.
    this._worker.prewarm();
    // Look up the Blackout sentinel by name so we don't break when new
    // presets are appended. Falls back to index 12 (its historical slot) if
    // the caller passed a dumb fixture without names.
    const blackoutIdx = Array.isArray(colorPresets)
      ? colorPresets.findIndex(p => p && (p.name === 'Blackout' || p.id === 'blackout'))
      : -1;
    this._blackoutIdx = blackoutIdx >= 0 ? blackoutIdx : 12;
    this.analysis = null;
    this.timeline = [];
    // Track metadata and event count can stay unchanged after a replan. An
    // opaque revision also prevents collisions when the server restarts.
    this.timelineRevision = randomUUID();
    this.running = false;
    this.track = null;
    this.palette = null;         // [idx, idx, …] — locked palette for current song (2, 3, or 4 colours)
    this.paletteName = null;     // human-readable palette name (e.g. 'cyber', 'sunset')
    // 2 | 3 | 4 — picks between the DUOS / TRIADS / TETRADS banks — or 'auto'
    // to let the director choose one per track from the music.
    this.paletteSize = 'auto';
    this.intensity = 50;         // 0–100 energy slider — scales accent density, drops, strobes
    // Seeded from the store, not from zero: the offset is persisted (see
    // settings.js `auto`), and state.js reads the same key, so starting at 0
    // here would leave the show and the number on the operator's screen
    // disagreeing until the first nudge.
    this.syncOffsetMs = settings.group('auto').syncOffsetMs ?? 0;
    this._getPositionMs = null;
    this._loopTimer = null;
    this._lastEventIdx = -1;
    this._status = 'idle';
    this._energyTimer = null;
    // Shared in-flight work map so concurrent callers for the same cacheKey
    // (e.g. a prefetch that's still running when the track changes) join the
    // same download/analyze job instead of racing it.
    this._inFlight = new Map(); // cacheKey -> Promise<analysis>
    // Where a track's own audio file comes from, by cacheKey (setExactAudio).
    this._exactAudio = new Map();
    // Identifies the newest current-track job. Anything older that finishes
    // late is for a song that has already been left behind and must not touch
    // the running show.
    this._currentJob = null;
    // The analysed beat grid of the loaded track, which the pattern clock
    // locks to while the show runs (see server/conductor.js).
    this._grid = null;
    // Whether the rig has LED bars. The director reaches for the pictures drawn
    // across cells only when it does (see setRig).
    this._pixels = false;
    // The cache key the loaded analysis was read or written under, so the
    // pattern clock can reuse the grid already in memory for that track.
    this.analysisKey = null;
    // When the server's render loop drives the cursor (useFrameClock), there is
    // no timer of its own.
    this._frameDriven = false;
    // Told `(key, analysis)` for every analysis this instance writes to the
    // cache, so the pattern clock can lock to a track whose analysis has just
    // arrived.
    this.onAnalysisCached = null;
  }

  /**
   * Let the render loop drive the cursor. Each frame calls tick() before it
   * renders, so a cue fires on the frame it is due — the 20 ms poll of its own
   * added up to a frame of lateness, different every time.
   */
  useFrameClock(): void {
    this._frameDriven = true;
    if (this._loopTimer) { clearInterval(this._loopTimer); this._loopTimer = null; }
  }

  /** Fire whatever is due by now. Called once per frame by the render loop. */
  tick(): void { this._tick(); }

  /**
   * What the pattern clock locks to while the show runs: the track's beat grid
   * and where the show is in it. Null when stopped or when the analysis has no
   * grid.
   */
  beatSource(): { grid: BeatGrid; positionMs: number; anchorMs: number | null } | null {
    if (!this.running || !this._grid || !this._getPositionMs) return null;
    const positionMs = this.getPositionMs();
    if (!Number.isFinite(positionMs)) return null;
    return { grid: this._grid, positionMs, anchorMs: this._sceneAnchorMs(positionMs) };
  }

  /**
   * The track time of the scene the pattern at `positionMs` belongs to: the
   * last event at or before it that set the pattern or its division, or null.
   * After a seek the pattern clock counts from there, so arriving by a seek
   * lands on the step that playing through would have.
   */
  _sceneAnchorMs(positionMs: number): number | null {
    let index = this._anchorIndex;
    if (!index || index.timeline !== this.timeline || index.length !== this.timeline.length) {
      const times: number[] = [];
      for (const ev of this.timeline) {
        if (ev.action === 'patch' && ev.data
          && (ev.data.pattern !== undefined || ev.data.beatDivision !== undefined)) times.push(ev.timeMs);
      }
      index = { timeline: this.timeline, length: this.timeline.length, times };
      this._anchorIndex = index;
    }
    const { times } = index;
    let lo = 0;
    let hi = times.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (times[mid] <= positionMs) lo = mid + 1; else hi = mid;
    }
    return lo ? times[lo - 1] : null;
  }

  /** The loaded track's beat grid, or null. */
  beatGrid(): BeatGrid | null { return this._grid; }

  /** The beat grid already in memory for a cache key, or null. */
  gridFor(cacheKey: string | null | undefined): BeatGrid | null {
    return cacheKey && cacheKey === this.analysisKey ? this._grid : null;
  }

  _noteCached(cacheKey: string | null, analysis: Analysis): void {
    if (cacheKey && typeof this.onAnalysisCached === 'function') {
      try { this.onAnalysisCached(cacheKey, analysis); } catch (err) {
        console.warn(`[auto-show] onAnalysisCached: ${messageOf(err)}`);
      }
    }
  }

  get status(): AutoShowStatus { return this._status; }

  /** True when this cacheKey's analysis is already on disk (cheap check). */
  isCached(cacheKey: string | null | undefined): boolean {
    return !!(cacheKey && this._cache && this._cache.has(cacheKey));
  }

  /** True when a download/analyze for this cacheKey is currently running. */
  isPrefetching(cacheKey: string | null | undefined): boolean {
    return !!(cacheKey && this._inFlight.has(cacheKey));
  }

  /**
   * Where the show is being played from, in ms — the position the source
   * reports, shifted by the operator's sync offset. 0 when not playing.
   *
   * Everything that drives or seeks the timeline reads this rather than the
   * raw source, so one number lines the whole show up with the room.
   */
  getPositionMs(): number {
    if (!this._getPositionMs) return 0;
    return this._getPositionMs() + this.syncOffsetMs;
  }

  /**
   * Shift the whole show against the music, in milliseconds.
   *
   * There is always latency between the audio the room hears and the light
   * that answers it, and none of it is under this program's control: the
   * player buffers, Spotify's position API is polled and quantised, Art-Net
   * crosses a network, the fixture has its own processing delay, and the PA
   * itself is metres away from the audience. The sum is a fixed error for a
   * given rig, but it is different for every rig — so it is a calibration, not
   * something that can be derived.
   *
   * Positive means the lights run *ahead* of the reported position, which is
   * what you want when the rig feels late. Negative holds them back.
   *
   * Applying it moves the playback cursor, so re-seek: nudging forward would
   * otherwise machine-gun every event between the old position and the new one.
   */
  setSyncOffsetMs(ms: unknown): void {
    const n = Math.round(Number(ms));
    if (!Number.isFinite(n)) return;
    const clamped = Math.max(-SYNC_OFFSET_LIMIT_MS, Math.min(SYNC_OFFSET_LIMIT_MS, n));
    if (clamped === this.syncOffsetMs) return;
    this.syncOffsetMs = clamped;
    this._reseek();
  }

  /**
   * Restore the current scene without replaying past bursts.
   *
   * Rebuilding or re-timing the timeline under a running show leaves the
   * cursor pointing into the old one; without this the next tick replays every
   * past event at once, which on a live rig is a burst of energy overrides.
   */
  _reseek(): void {
    if (!this.running || !this._getPositionMs) {
      this._lastEventIdx = -1;
      return;
    }
    const posMs = this.getPositionMs();
    if (!Number.isFinite(posMs)) return;
    let last = -1;
    let lastPatchMs: number | undefined;
    const restored: ReplayedPatch = { energyOverride: null, showDynamics: null };
    for (let i = 0; i < this.timeline.length; i++) {
      if (this.timeline[i].timeMs > posMs) break;
      const ev = this.timeline[i];
      if (ev.action === 'patch') lastPatchMs = ev.timeMs;
      if (ev.action === 'patch') {
        if (ev.data?.showDynamics && restored.showDynamics) {
          restored.showDynamics = { ...restored.showDynamics, ...ev.data.showDynamics };
          const { showDynamics: _dynamics, ...rest } = ev.data;
          Object.assign(restored, rest);
        } else Object.assign(restored, ev.data);
      }
      last = i;
    }
    delete restored.masterDimmer;
    delete restored.masterBlackout;
    // A seek lands on the scene; it does not fade into it from wherever the
    // rig happened to be.
    delete restored.fadeMs;
    // The restored pattern counts its steps from the beat its scene was
    // scheduled on, so a seek lands on the same step playing through would.
    // Without a pattern to anchor, it still says it came from the timeline.
    const anchorMs = this._sceneAnchorMs(posMs);
    if (anchorMs !== null) restored.anchorMs = anchorMs;
    else if (lastPatchMs !== undefined) restored.anchorMs = lastPatchMs;
    // A seek must restore the complete current scene for every timeline. The
    // old expressive-only guard left legacy pattern/colour shows visually
    // stale after a pause, offset nudge, or live replan.
    restored.energyOverride = null;
    if (last < 0) {
      this._cancelEnergyTimer();
      this._lastPositionMs = posMs;
      this._lastEventIdx = -1;
      return;
    }
    this._cancelEnergyTimer();
    try {
      this._applyPatch(restored);
    } catch (err) {
      console.error(`[auto-show] could not restore scene: ${messageOf(err)}`);
    }
    this._lastPositionMs = posMs;
    this._lastEventIdx = last;
  }

  // ── 1. Analysis ─────────────────────────────────────────────────────────────

  /**
   * Load a previously-analyzed result from the cache without touching audio.
   * Returns true on hit, false on miss.
   */
  async _loadFromCache(cacheKey: string | null, isCurrent: () => boolean = () => true): Promise<boolean> {
    if (!cacheKey || !this._cache) return false;
    // Asynchronous: a document is megabytes, and a synchronous read of it on
    // a track change stalled the render loop at exactly the moment the room
    // was listening hardest.
    const cached = await this._cache.load(cacheKey);
    if (!cached) return false;
    // The read yielded, and the track may have changed meanwhile. A late hit
    // must not replace the show that is now current.
    if (!isCurrent()) throw supersededError();
    console.log(`[auto-show] analysis cache hit: ${cacheKey}`);
    console.log(`[auto-show] Models used (cached ${cacheKey}): ${formatModelUsage(cached)}`);
    this.analysis = cached;
    this.analysisKey = cacheKey;
    this.buildTimeline();
    this._status = 'ready';
    return true;
  }

  /**
   * State-free runner: send the audio to the persistent analyzer worker and
   * return the parsed analysis JSON. Does not touch instance state (so it's
   * safe to call from prefetch while a show is already running).
   *
   * If `targetDurationSec` is provided, the analyzer will trim beatless
   * padding from the head/tail of the audio until the length matches — used
   * when yt-dlp can't find a candidate within its ±5s filter and has to
   * fall back to an unfiltered search that may include long intros/outros.
   */
  _runAnalyzer(source: string, targetDurationSec: number | null = null, priority: AnalysisPriority = 'normal',
    tag: string | null = null, queuePos: number | null = null): Promise<Analysis> {
    const tgt = typeof targetDurationSec === 'number' && Number.isFinite(targetDurationSec) && targetDurationSec > 0
      ? targetDurationSec : null;
    const band = priority === 'normal' ? '' : ` (${priority})`;
    console.log(`[analyzer] Analyzing${band}: ${path.basename(source)}${tgt ? ` (target ${Math.round(tgt)}s)` : ''}`);
    return this._worker.analyze(source, tgt, { priority, tag, queuePos }).then((result) => {
      console.log(`[analyzer] Models used (${path.basename(source)}): ${formatModelUsage(result)}`);
      return result;
    });
  }

  /**
   * Tear down the persistent analyzer subprocess. Called on server shutdown.
   * Safe to call multiple times.
   */
  /** Recycle the analyzer process — used when the interpreter changes. */
  restartWorker(reason: string): void {
    if (this._worker) this._worker.restart(reason);
  }

  /**
   * Tell the analyzer the playback queue's current shape, as cache keys in
   * queue order. Prefetches already waiting are re-ranked to match, so a track
   * that has moved up is analysed before the ones behind it and one that has
   * dropped out stops holding up the tracks that are still coming.
   */
  applyQueueOrder(cacheKeys: readonly (string | null)[]): void {
    if (this._worker) this._worker.setQueueOrder(cacheKeys);
  }

  destroy(): void {
    this.stop();
    if (this._worker) this._worker.shutdown();
  }

  /**
   * Analyse a file the operator handed us and load it as the show. Same
   * standing as `downloadAndAnalyze`: whatever is about to play in the room
   * outranks background prefetches, and a newer one supersedes this.
   */
  async analyze(source: string, cacheKey: string | null = null): Promise<Analysis | null> {
    const token = Symbol(cacheKey || source);
    this._currentJob = token;
    const isCurrent = () => this._currentJob === token;

    if (await this._loadFromCache(cacheKey, isCurrent)) return this.analysis;
    this._status = 'analyzing';
    try {
      const result = await this._runAnalyzer(source, null, 'current', cacheKey);
      if (!isCurrent()) throw supersededError();
      this.analysis = result;
      this.analysisKey = cacheKey;
      this.buildTimeline();
      this._status = 'ready';
      if (cacheKey && this._cache) {
        await this._cache.save(cacheKey, result, { track: this.track });
        this._noteCached(cacheKey, result);
      }
      return result;
    } catch (err) {
      if (isCurrent()) this._status = 'idle';
      throw err;
    }
  }

  /**
   * Say where the exact audio for `cacheKey` comes from: `fetch()` resolves to
   * a temp audio file this module then owns (and deletes), or null when it
   * cannot be had. An analysis under that key is then made from that file and
   * nothing else — no search by name, no trimming to a length — and fails if
   * the file cannot be fetched, so the caller can fall back to a key of its
   * own for a search.
   */
  setExactAudio(cacheKey: string, fetch: () => Promise<string | null>): void {
    this._exactAudio.delete(cacheKey);
    this._exactAudio.set(cacheKey, fetch);
    while (this._exactAudio.size > EXACT_AUDIO_KEPT) {
      this._exactAudio.delete(this._exactAudio.keys().next().value as string);
    }
  }

  /**
   * Shared work helper: download audio, run the analyzer, write to cache,
   * clean up the temp file. Returns the raw analysis JSON.
   *
   * Does NOT touch instance state — `downloadAndAnalyze` and `prefetch` both
   * go through this, and the one that needs to mutate instance state does so
   * on its own side of the in-flight boundary.
   */
  async _fetchAnalysis(query: string, targetDurationSec: number | null, cacheKey: string | null,
    meta: CacheMeta | undefined, isrc: string | null, onPhase: ((phase: string) => void) | null,
    priority: AnalysisPriority, queuePos?: number | null): Promise<Analysis> {
    let audioPath: string | null = null;
    try {
      const exact = cacheKey ? this._exactAudio.get(cacheKey) : undefined;
      if (exact) {
        audioPath = await exact();
        if (!audioPath) throw new Error('the track\'s own audio file could not be fetched');
        // The file is the track: nothing to trim it to.
        targetDurationSec = null;
      } else {
        audioPath = await this._downloadAudio(query, targetDurationSec, isrc);
      }
      if (onPhase) onPhase('analyzing');
      // Always pass the target duration to the analyzer when we have one —
      // it will no-op when the downloaded length is already within the ±2s
      // tolerance, and trim beatless padding when the yt-dlp fallback grabs
      // a longer version. The cacheKey doubles as the worker-queue tag so
      // a later high-priority join can find and bump this entry.
      const analysis = await this._runAnalyzer(audioPath, targetDurationSec, priority, cacheKey, queuePos);
      if (cacheKey && this._cache) {
        await this._cache.save(cacheKey, analysis, meta || {});
        this._noteCached(cacheKey, analysis);
      }
      return analysis;
    } finally {
      if (audioPath) { try { fs.unlinkSync(audioPath); } catch (_) {} }
    }
  }

  /**
   * Kick off (or join) a fetch for `cacheKey`. If the same key is already
   * being fetched, returns the existing in-flight promise so concurrent
   * callers share one download/analyze job. `onPhase` is only honoured for
   * the originator — joiners can't retroactively hook into phase changes
   * the in-flight call already passed through. `priority` only applies to
   * the originator's worker-queue position; joiners ride the existing job's
   * priority (whatever it was when first submitted).
   */
  _fetchShared(query: string, targetDurationSec: number | null, cacheKey: string | null,
    meta: CacheMeta | undefined, isrc: string | null, onPhase: ((phase: string) => void) | null,
    priority: AnalysisPriority, queuePos?: number | null): Promise<Analysis> {
    if (cacheKey && this._inFlight.has(cacheKey)) {
      // Joining an existing fetch — if we're now urgent (downloadAndAnalyze
      // for the current track) but the original submission was a background
      // prefetch, promote the worker queue entry so it doesn't sit behind
      // other prefetches. A prefetch that is already running stays running:
      // it is the very work we need, just started early.
      if (priority !== 'normal' && this._worker) this._worker.promote(cacheKey, priority);
      return this._inFlight.get(cacheKey) as Promise<Analysis>;
    }
    const promise = this._fetchAnalysis(query, targetDurationSec, cacheKey, meta, isrc, onPhase, priority, queuePos);
    if (cacheKey) {
      this._inFlight.set(cacheKey, promise);
      const cleanup = () => this._inFlight.delete(cacheKey);
      promise.then(cleanup, cleanup);
    }
    return promise;
  }

  /**
   * Download + analyze a track and write it to the cache WITHOUT mutating
   * the running show's state (analysis / timeline / status). Used to warm the
   * cache for a queued-up track while the current one is still playing, so
   * track changes flip instantly to a cache hit.
   *
   * `queuePos` is the track's place in the playback queue, 0 being the next
   * song up: the analyzer serves the upcoming tracks in that order, so a
   * deeper slot never delays a nearer one.
   *
   * Returns { skipped: boolean, reason?: string, error?: string }.
   */
  async prefetch(query: string, targetDurationSec: number | null, cacheKey: string | null, meta: CacheMeta = {},
    isrc: string | null = null, priority: AnalysisPriority = 'normal', queuePos: number | null = null): Promise<PrefetchResult> {
    if (!cacheKey || !this._cache) return { skipped: true, reason: 'no-cache' };
    if (this._cache.has(cacheKey)) return { skipped: true, reason: 'already-cached' };
    if (this._inFlight.has(cacheKey)) return { skipped: true, reason: 'in-flight' };

    try {
      console.log(`[auto-show] prefetching${priority === 'normal' ? '' : ` (${priority})`}: ${query}`);
      await this._fetchShared(query, targetDurationSec, cacheKey, meta, isrc, null, priority, queuePos);
      console.log(`[auto-show] prefetched and cached: ${cacheKey}`);
      return { skipped: false };
    } catch (err) {
      console.warn(`[auto-show] prefetch failed for ${cacheKey}: ${messageOf(err)}`);
      return { skipped: false, error: messageOf(err) };
    }
  }

  /**
   * Analyse the song that is playing right now and load it as the show.
   *
   * Each call supersedes the one before it: only one song plays at a time, so
   * a job still running when the track changes is working on a track the room
   * has already left behind. It loses the analyser to the new one, and if it
   * finishes anyway its result is dropped rather than replacing the running
   * show with the previous track's timeline. Rejects with `err.superseded`
   * set in that case — the caller should not start a show from it.
   */
  async downloadAndAnalyze(query: string, targetDurationSec: number | null = null, cacheKey: string | null = null,
    isrc: string | null = null): Promise<{ analysis: Analysis | null; cached: boolean }> {
    const token = Symbol(cacheKey || query);
    this._currentJob = token;
    const isCurrent = () => this._currentJob === token;

    // Cache hit → skip the download entirely.
    if (await this._loadFromCache(cacheKey, isCurrent)) {
      return { analysis: this.analysis, cached: true };
    }

    // If a prefetch for this key is already running, join it instead of
    // kicking off a parallel yt-dlp/analyzer job for the same track.
    const joining = !!cacheKey && this._inFlight.has(cacheKey);
    this._status = joining ? 'analyzing' : 'downloading';

    try {
      const analysis = await this._fetchShared(
        query, targetDurationSec, cacheKey,
        { track: this.track }, isrc,
        // Flip the badge to ANALYZING once the WAV is on disk — librosa
        // alone takes 30-90s on a 3-5min track, and leaving "DOWNLOADING"
        // up that whole time reads as a hang.
        (phase) => { if (phase === 'analyzing' && isCurrent()) this._status = 'analyzing'; },
        // The song the room is hearing — outranks every prefetch, and
        // interrupts one that is already running rather than waiting it out.
        'current',
      );
      if (!isCurrent()) throw supersededError();
      this.analysis = analysis;
      this.analysisKey = cacheKey;
      this.buildTimeline();
      this._status = 'ready';
      return { analysis, cached: joining };
    } catch (err) {
      if (isCurrent()) this._status = 'idle';
      throw err;
    }
  }

  /**
   * Download audio for analysis. When an ISRC is provided and Deezer is
   * configured, downloads the exact studio track from Deezer — guaranteed
   * audio-only and correct duration. Falls back to yt-dlp when Deezer is
   * unavailable, the ISRC lookup fails, or the source is a direct URL.
   */
  async _downloadAudio(query: string, targetDurationSec: number | null = null, isrc: string | null = null): Promise<string> {
    const isUrl = /^https?:\/\//.test(query);

    // A track can arrive without an ISRC: the OS media session and PRO DJ LINK
    // never carry one, and Spotify's February 2026 changes drop it for some
    // apps. With Deezer set up, one looked up by name and length still gets
    // the exact recording rather than a search hit.
    if (!isrc && !isUrl && deezer.isAvailable()) {
      const parts = splitQuery(query);
      if (parts) {
        isrc = await resolveIsrc({ ...parts, durationSec: targetDurationSec });
        if (isrc) console.log(`[isrc] "${query}" → ${isrc}`);
      }
    }

    // Try Deezer first when we have an ISRC and Deezer is initialized
    if (isrc && !isUrl && deezer.isAvailable()) {
      try {
        return await deezer.downloadByIsrc(query, isrc);
      } catch (err) {
        console.warn(`[deezer] Failed for "${query}" (ISRC: ${isrc}): ${messageOf(err)} — falling back to yt-dlp`);
      }
    }

    // Fallback: yt-dlp
    const runtime = ytdlp.runtimeArgs(await ytdlp.version());
    const target = typeof targetDurationSec === 'number' && Number.isFinite(targetDurationSec) && targetDurationSec > 0
      ? targetDurationSec : null;
    if (target !== null && !isUrl) {
      try {
        return await this._ytDlpExec(query, target, runtime);
      } catch (err) {
        // No video passed the duration filter — retry without it.
        if (/output file not found/i.test(messageOf(err))) {
          console.warn(`[yt-dlp] No result matched ${Math.round(target)}s ±5s, retrying without duration filter`);
          return this._ytDlpExec(query, null, runtime);
        }
        throw err;
      }
    }
    return this._ytDlpExec(query, null, runtime);
  }

  _ytDlpExec(query: string, targetDurationSec: number | null, runtimeArgs: string[] = []): Promise<string> {
    return new Promise((resolve, reject) => {
      // Random, not a timestamp: prefetches are started several to a tick,
      // and two downloads sharing a name overwrote each other — one track's
      // audio then got analysed and cached under another track's key.
      const basename = `auto-dl-${randomUUID()}`;
      const outputTemplate = path.join(os.tmpdir(), `${basename}.%(ext)s`);
      const expectedWav = path.join(os.tmpdir(), `${basename}.wav`);

      const isUrl = /^https?:\/\//.test(query);
      const duration = typeof targetDurationSec === 'number' && Number.isFinite(targetDurationSec) && targetDurationSec > 0
        ? targetDurationSec : null;
      const useFilter = !isUrl && duration !== null;
      // With a duration filter we widen the search so yt-dlp has more candidates
      // to skim through before giving up.
      const source = isUrl ? query : (useFilter ? `ytsearch5:${query}` : `ytsearch1:${query}`);

      const args = [
        '-x',
        '--audio-format', 'wav',
        '--audio-quality', '0',
        '--no-playlist',
        '--no-warnings',
        ...runtimeArgs,
      ];

      if (useFilter) {
        const tolerance = 5; // seconds
        const minDur = Math.max(1, Math.floor(duration - tolerance));
        const maxDur = Math.ceil(duration + tolerance);
        args.push('--match-filter', `duration >= ${minDur} & duration <= ${maxDur}`);
        // Stop after the first candidate that passes the filter.
        args.push('--max-downloads', '1');
      }

      args.push('-o', outputTemplate, source);

      console.log(`[yt-dlp] Downloading: ${query}${useFilter ? ` (target ${Math.round(duration)}s ±5s)` : ''}`);
      const proc = spawn('yt-dlp', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let timedOut = false;
      proc.stdout.on('data', (d: Buffer) => { stdout += d; });
      proc.stderr.on('data', (d: Buffer) => { stderr += d; });

      const timer = setTimeout(() => {
        timedOut = true;
        proc.kill('SIGKILL');
      }, downloadTimeoutMs());
      // Don't let a pending download keep the process alive at shutdown.
      if (typeof timer.unref === 'function') timer.unref();

      proc.on('error', (err) => {
        clearTimeout(timer);
        reject(new Error(
          `yt-dlp not found. Install it: pip install yt-dlp  (or download from https://github.com/yt-dlp/yt-dlp)\n${err.message}`
        ));
      });

      // What a failed or killed run left behind: a partial download, a
      // half-converted file. Nothing else will ever remove them.
      const discardPartials = () => {
        try {
          for (const f of fs.readdirSync(os.tmpdir())) {
            if (f.startsWith(basename)) fs.rmSync(path.join(os.tmpdir(), f), { force: true });
          }
        } catch (_) { /* best effort */ }
      };

      proc.on('close', (code) => {
        clearTimeout(timer);
        if (timedOut) {
          discardPartials();
          return reject(new Error(
            `yt-dlp timed out after ${Math.round(downloadTimeoutMs() / 1000)}s `
            + '(raise the download timeout in the settings page)'
          ));
        }
        // yt-dlp exits 101 when --max-downloads is reached — that's the normal
        // success path for a filtered search, so treat it the same as 0.
        if (code !== 0 && code !== 101) {
          discardPartials();
          return reject(new Error(`yt-dlp failed (exit ${code}): ${stderr || stdout}`));
        }

        if (fs.existsSync(expectedWav)) {
          console.log(`[yt-dlp] Downloaded: ${expectedWav}`);
          return resolve(expectedWav);
        }

        const tmpDir = os.tmpdir();
        const candidates = fs.readdirSync(tmpDir).filter(f => f.startsWith(basename));
        if (candidates.length > 0) {
          const found = path.join(tmpDir, candidates[0]);
          console.log(`[yt-dlp] Downloaded: ${found}`);
          return resolve(found);
        }

        reject(new Error('yt-dlp completed but output file not found'));
      });
    });
  }

  // ── 2. Timeline generation ──────────────────────────────────────────────────

  /**
   * Build a timeline of { timeMs, action, data } events from the analysis.
   *
   * Event types:
   *   'patch'  – change pattern / colours / strobe. Never contains masterDimmer.
   *   'energy' – brief energy override (blinder, strobe burst). Auto-clears.
   */
  /**
   * Turn the analysis into a timeline of rig events.
   *
   * The work happens in three layers, each with its own module:
   *
   *   src/show/musical-events.js   analysis document -> musical events
   *   src/show/director.js         musical events    -> lighting intents
   *   src/show/render.js           lighting intents  -> Art-Net patches
   *
   * This method only wires them together and keeps the results the rest of the
   * class needs (the timeline, the locked palette and its name). Everything
   * about *why* the show does what it does lives in the director; everything
   * about what a patch field is called lives in the renderer.
   */
  buildTimeline(): void {
    if (!this.analysis) return;

    const director = new ShowDirector({
      patterns: this._patterns,
      colorPresets: this._colorPresets,
      paletteSize: this.paletteSize,
      intensity: this.intensity,
      blackoutIndex: this._blackoutIdx,
      pixels: this._pixels,
    });

    this._grid = gridFromAnalysis(this.analysis);
    const plan = director.plan(this.analysis);
    this.palette = plan.palette;
    this.paletteName = plan.paletteName;
    // What the director settled on. Identical to `paletteSize` unless that is
    // 'auto', and it is what the client shows — an operator looking at the rig
    // needs to know it is on three colours, not that something chose three.
    this.resolvedPaletteSize = plan.paletteSize;
    this.intents = plan.intents;
    this.timeline = renderIntents(plan.intents, { blackoutIndex: this._blackoutIdx });
    this.timelineRevision = randomUUID();
    if (this.running) this._reseek();
  }

  // ── 3. Playback ─────────────────────────────────────────────────────────────

  start(getPositionMs: () => number): void {
    if (!this.timeline.length) return;
    // A second client or a retried request must not reset the cursor, replay
    // events, or leave an extra playback interval that stop() cannot clear.
    if (this.running) return;
    this._getPositionMs = getPositionMs;
    this.running = true;
    this._lastEventIdx = -1;
    this._lastPositionMs = undefined;
    this._status = 'playing';
    // Start from the current source position. Historical patches establish
    // the look; energy events are deliberately represented as cleared state.
    this._reseek();
    this._tick();
    if (!this._frameDriven) this._loopTimer = setInterval(guarded('auto-show', () => this._tick()), 20);
  }

  stop(): void {
    this.running = false;
    this._status = this.analysis ? 'ready' : 'idle';
    if (this._loopTimer) { clearInterval(this._loopTimer); this._loopTimer = null; }
    this._cancelEnergyTimer();
    // Clear any lingering energy override so we don't leave the rig stuck
    this._applyPatch({ energyOverride: null, showDynamics: null, split: null });
  }

  reset(): void {
    this.stop();
    this.analysis = null;
    this.analysisKey = null;
    this._grid = null;
    this.timeline = [];
    this.timelineRevision = randomUUID();
    this.track = null;
    this.palette = null;
    this.paletteName = null;
    this._lastEventIdx = -1;
    this._status = 'idle';
  }

  _tick(): void {
    if (!this.running || !this._getPositionMs) return;
    const posMs = this.getPositionMs();
    if (!Number.isFinite(posMs)) return;
    const last = this._lastPositionMs;
    if (last !== undefined && Number.isFinite(last) && (posMs < last - 100 || posMs > last + 1500)) {
      this._reseek();
      return;
    }
    this._lastPositionMs = posMs;

    for (let i = this._lastEventIdx + 1; i < this.timeline.length; i++) {
      const ev = this.timeline[i];
      if (ev.timeMs > posMs) break;

      // One bad event must not take the rig down. This runs from a timer, so
      // anything thrown here is an uncaught exception that ends the process —
      // and it ends it mid-set, with the lights stuck on whatever they were
      // last told. A rejected patch is worth a loud log and a skipped event;
      // it is not worth the show. The cursor still advances, so a single
      // malformed event cannot wedge the timeline either.
      try {
        this._fireEvent(ev);
      } catch (err) {
        console.error(
          `[auto-show] event ${i} at ${ev.timeMs}ms (${ev.action}) rejected: ${messageOf(err)}`,
          ev.data,
        );
      }
      this._lastEventIdx = i;
    }
  }

  _fireEvent(ev: TimelineEvent): void {
    switch (ev.action) {
      case 'patch': {
        // Master controls belong to the operator, including for old timelines.
        const { masterDimmer: _dimmer, masterBlackout: _blackout, ...rest } = (ev.data || {}) as ReplayedPatch;
        const patch: ReplayedPatch = rest;
        if ('energyOverride' in patch) this._cancelEnergyTimer();
        // The track time it was scheduled for. A scene counts its pattern's
        // steps from that beat, not from the frame that happened to fire it,
        // and a tempo mark from the show is not the operator taking the
        // tempo back from a track (see server/patch.js).
        patch.anchorMs = ev.timeMs;
        this._applyPatch(patch);
        break;
      }
      case 'energy': {
        const duration = ev.data.durationMs || 200;
        this._cancelEnergyTimer();
        this._applyPatch({ energyOverride: ev.data.id });
        this._energyTimer = setTimeout(() => {
          this._energyTimer = null;
          // Its own timer, so it needs its own guard — a throw here would be
          // just as fatal as one in _tick, and it would also leave the rig
          // stuck holding the energy override it was about to clear.
          try {
            if (this.running) {
              this._applyPatch({ energyOverride: null });
            }
          } catch (err) {
            console.error(`[auto-show] could not clear energy override: ${messageOf(err)}`);
          }
        }, duration);
        break;
      }
    }
  }

  _cancelEnergyTimer(): void {
    if (this._energyTimer !== null) clearTimeout(this._energyTimer);
    this._energyTimer = null;
  }

  // ── Mapping helpers ─────────────────────────────────────────────────────────

  /**
   * Swap the palette size live. Rebuilds the timeline from the current analysis
   * so the new palette takes effect on the next tick without re-analysing the
   * audio. No-op when paletteSize is already n.
   *
   * Allowed values: 2 | 3 | 4, or `'auto'` to hand the choice back to the
   * director, which sizes the palette from how many distinct passages the track
   * has and how much colour separation the music supports. An explicit choice
   * always wins — this is a setting an operator makes while looking at the rig,
   * and nothing measured should overrule that.
   */
  setPaletteSize(n: unknown): void {
    const size = n === 'auto' ? 'auto' : n === 2 ? 2 : n === 3 ? 3 : 4;
    if (size === this.paletteSize) return;
    this.paletteSize = size;
    if (this.analysis) {
      this.buildTimeline();
    }
  }

  /**
   * Set the energy intensity (0-100). Rebuilds the timeline so accent density,
   * drop effects and beat-division scaling adjust on the fly.
   */
  setIntensity(n: unknown): void {
    const numeric = Number(n);
    if (!Number.isFinite(numeric)) return;
    const val = Math.max(0, Math.min(100, Math.round(numeric)));
    if (val === this.intensity) return;
    this.intensity = val;
    if (this.analysis) {
      this.buildTimeline();
    }
  }

  /**
   * Tell the show what the rig is. A patch that gains or loses its LED bars
   * replans the track, as a palette or intensity change does, so the looks
   * that draw across cells come and go with the bars.
   */
  setRig({ hasPixels = false }: { hasPixels?: boolean } = {}): void {
    const pixels = !!hasPixels;
    if (pixels === this._pixels) return;
    this._pixels = pixels;
    if (this.analysis) this.buildTimeline();
  }

  /** See src/show/director.js — measured build-up acceleration. */
  _buildupAccel(build: { start: number; end: number }, a: Analysis, baseBpm: number): ReturnType<typeof measureBuildup> {
    return measureBuildup(build, a, baseBpm);
  }

  // ── Serialization for client ────────────────────────────────────────────────

  /**
   * Full payload for the UI timeline visualizer. Only the fields the client
   * actually renders — keeps the response light.
   */
  getTimelineData() {
    if (!this.analysis) return null;
    const a = this.analysis;
    // Slim timeline: drop internal markers, keep only what the UI draws.
    const timeline = this.timeline.map((ev) => {
      const data = ev.data as Partial<PatchData & EnergyData> | undefined;
      return {
      timeMs: ev.timeMs,
      action: ev.action,
      id: data && data.id,
      pattern: data && data.pattern,
      colorA: data && data.colorA,
      durationMs: data && data.durationMs,
      source: ev.source,
      kind: ev.kind,
      data: ev.data,
      };
    });
    return {
      revision: this.timelineRevision,
      duration: a.duration,
      bpm: a.bpm,
      tempoCurve: a.tempoCurve || [],
      tempoStability: a.tempoStability,
      beatSource: a.beatSource,
      key: a.key,
      scale: a.scale,
      keyStrength: a.keyStrength,
      mood: a.mood || null,
      genre: a.genre || null,
      beats: a.beats || [],
      beatStrengths: a.beatStrengths || [],
      downbeats: a.downbeats || [],
      meter: a.meter || 4,
      downbeatConfidence: a.downbeatConfidence,
      segments: a.segments || [],
      drops: a.drops || [],
      buildups: a.buildups || [],
      energyCurve: a.energyCurve || [],
      bassCurve: a.bassCurve || [],
      kickCurve: a.kickCurve || [],
      highCurve: a.highCurve || [],
      timeline,
    };
  }

  getClientState() {
    return {
      status: this._status,
      running: this.running,
      track: this.track,
      palette: this.palette,
      paletteName: this.paletteName,
      paletteSize: this.resolvedPaletteSize || this.paletteSize,
      paletteSizeMode: this.paletteSize === 'auto' ? 'auto' : 'manual',
      intensity: this.intensity,
      syncOffsetMs: this.syncOffsetMs,
      // Planned for a rig with LED bars: its looks may draw across cells.
      pixels: this._pixels,
      analysis: this.analysis ? {
        models: describeModelUsage(this.analysis),
        duration: this.analysis.duration,
        bpm: this.analysis.bpm,
        tempoStability: this.analysis.tempoStability,
        beatSource: this.analysis.beatSource,
        key: this.analysis.key,
        scale: this.analysis.scale,
        keyStrength: this.analysis.keyStrength,
        mood: this.analysis.mood || null,
        genre: this.analysis.genre || null,
        meter: this.analysis.meter,
        downbeatCount: this.analysis.downbeats?.length || 0,
        downbeatConfidence: this.analysis.downbeatConfidence,
        segmentCount: this.analysis.segments?.length || 0,
        beatCount: this.analysis.beats?.length || 0,
        onsetCount: this.analysis.onsets?.length || 0,
        dropCount: this.analysis.drops?.length || 0,
        buildupCount: this.analysis.buildups?.length || 0,
      } : null,
      timelineLength: this.timeline.length,
      timelineRevision: this.timelineRevision,
    };
  }
}

// Kept as a getter: callers (the startup banner, scripts/bench-worker.js) read
// it after the settings store has loaded, and it must reflect a configured
// interpreter rather than a value frozen at load time.
Object.defineProperty(AutoShow, 'PYTHON_EXE', { get: () => pythonEnv.pythonExe() });

export default AutoShow;
