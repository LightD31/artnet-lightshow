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
import { pulseTrack } from './show/pulse.ts';
import { SetMemory } from './show/set-memory.ts';
import type { SetArc, TrackMemory } from './show/set-memory.ts';
import type { ShowOverlay } from './show/overlay.ts';
import { guarded } from './server/guard.ts';
import { resolveIsrc, splitQuery } from './isrc.ts';
import { gridFromAnalysis } from './shared/beat-clock.ts';
import * as ytdlp from './ytdlp.ts';
import * as tools from './tools.ts';
import { messageOf, cancelledError, isCancelled } from './errors.ts';
import type { AnalysisCache, CacheMeta } from './analysis-cache.ts';
import type { AnalysisPriority } from './analyzer-worker.ts';
import type { BeatGrid } from './shared/beat-clock.ts';
import type { PatternDescriptor } from './show/director.ts';
import type { Intent } from './show/intents.ts';
import type { EnergyData, PatchData, TimelineEvent } from './show/render.ts';
import type { Analysis } from './show/score.ts';
import type { PulseTrack } from './show/pulse.ts';
import type { PulseReading } from './types/rig.ts';

export type AutoShowStatus = 'idle' | 'downloading' | 'analyzing' | 'ready' | 'playing';

export interface ShowTrack {
  name?: string;
  artist?: string;
  [key: string]: unknown;
}

interface NamedPreset {
  name?: string;
  id?: string;
}

const EXACT_AUDIO_KEPT = 32;

export interface ExactAudio {
  fetch: () => Promise<string | null>;
  refine?: (analysis: Analysis) => Promise<Analysis> | Analysis;
}

export interface PrefetchResult {
  skipped: boolean;
  reason?: string;
  error?: string;
}

type ReplayedPatch = PatchData & { masterDimmer?: number; masterBlackout?: boolean; anchorMs?: number };

function downloadTimeoutMs(): number {
  return settings.get('analysis.downloadTimeoutMs');
}

function supersededError(): Error & { superseded: true } {
  return Object.assign(new Error('superseded by a newer current track'), { superseded: true as const });
}

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
  declare autoSyncMs: number;
  declare _getPositionMs: (() => number) | null;
  declare _loopTimer: ReturnType<typeof setInterval> | null;
  declare _lastEventIdx: number;
  declare _startFadeMs: number;
  declare _lastPositionMs: number | undefined;
  declare _status: AutoShowStatus;
  declare _energyTimer: ReturnType<typeof setTimeout> | null;
  declare _inFlight: Map<string, Promise<Analysis>>;
  declare _exactAudio: Map<string, ExactAudio>;
  declare _currentJob: symbol | null;
  declare _currentKey: string | null;
  declare _cancelledKeys: Set<string>;
  declare _lastError: { message: string; at: number } | null;
  declare startPending: symbol | null;
  declare _grid: BeatGrid | null;
  declare _pixels: boolean;
  declare _panels: boolean;
  declare _lamps: number | null;
  declare _pulse: PulseTrack | null;
  declare _memory: SetMemory;
  declare _planMemory: Omit<TrackMemory, 'key' | 'at'> | null;
  declare _arc: SetArc | null;
  declare _overlay: { key: string | null; overlay: ShowOverlay | null } | null;
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
    this._worker.prewarm();
    const blackoutIdx = Array.isArray(colorPresets)
      ? colorPresets.findIndex(p => p && (p.name === 'Blackout' || p.id === 'blackout'))
      : -1;
    this._blackoutIdx = blackoutIdx >= 0 ? blackoutIdx : 12;
    this.analysis = null;
    this.timeline = [];
    this.timelineRevision = randomUUID();
    this.running = false;
    this.track = null;
    this.palette = null;         // [idx, idx, …] — locked palette for current song (2, 3, or 4 colours)
    this.paletteName = null;     // human-readable palette name (e.g. 'cyber', 'sunset')
    this.paletteSize = 'auto';
    this.intensity = 50;         // 0–100 energy slider — scales accent density, drops, strobes
    // Start from the persisted sync offset so playback agrees with the operator’s displayed setting.
    this.syncOffsetMs = settings.group('auto').syncOffsetMs ?? 0;
    this.autoSyncMs = 0;
    this._getPositionMs = null;
    this._loopTimer = null;
    this._lastEventIdx = -1;
    this._startFadeMs = 0;
    this._status = 'idle';
    this._energyTimer = null;
    this._inFlight = new Map(); // cacheKey -> Promise<analysis>
    this._exactAudio = new Map();
    this._currentJob = null;
    this._currentKey = null;
    this._cancelledKeys = new Set();
    this._lastError = null;
    this.startPending = null;
    this._grid = null;
    this._pixels = false;
    this._panels = false;
    this._lamps = null;
    this._pulse = null;
    this._memory = new SetMemory();
    this._planMemory = null;
    this._arc = null;
    this._overlay = null;
    this.analysisKey = null;
    this._frameDriven = false;
    this.onAnalysisCached = null;
  }

  useFrameClock(): void {
    this._frameDriven = true;
    if (this._loopTimer) { clearInterval(this._loopTimer); this._loopTimer = null; }
  }

  tick(): void { this._tick(); }

  beatSource(): { grid: BeatGrid; positionMs: number; anchorMs: number | null } | null {
    if (!this.running || !this._grid || !this._getPositionMs) return null;
    const positionMs = this.getPositionMs();
    if (!Number.isFinite(positionMs)) return null;
    return { grid: this._grid, positionMs, anchorMs: this._sceneAnchorMs(positionMs) };
  }

  pulse(): PulseReading | null {
    if (!this.running || !this._pulse || !this._getPositionMs) return null;
    const positionMs = this.getPositionMs();
    return Number.isFinite(positionMs) ? this._pulse.at(positionMs) : null;
  }

  _sceneAnchorMs(positionMs: number): number | null {
    let index = this._anchorIndex;
    if (!index || index.timeline !== this.timeline || index.length !== this.timeline.length) {
      const times: number[] = [];
      for (const ev of this.timeline) {
        if (ev.action === 'patch' && ev.data
          && (ev.data.pattern !== undefined || ev.data.pixelPattern !== undefined
            || ev.data.panelPattern !== undefined || ev.data.beatDivision !== undefined)) times.push(ev.timeMs);
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

  beatGrid(): BeatGrid | null { return this._grid; }

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

  isCached(cacheKey: string | null | undefined): boolean {
    return !!(cacheKey && this._cache && this._cache.has(cacheKey));
  }

  isPrefetching(cacheKey: string | null | undefined): boolean {
    return !!(cacheKey && this._inFlight.has(cacheKey));
  }

  getPositionMs(): number {
    if (!this._getPositionMs) return 0;
    return this._getPositionMs() + this.syncOffsetMs + this.autoSyncMs;
  }

  // Re-seek after large corrections so timeline events are restored across skipped positions.
  adjustAutoSync(deltaMs: number): void {
    if (!Number.isFinite(deltaMs)) return;
    this.autoSyncMs = Math.max(-SYNC_OFFSET_LIMIT_MS, Math.min(SYNC_OFFSET_LIMIT_MS, this.autoSyncMs + deltaMs));
  }

  setSyncOffsetMs(ms: unknown): void {
    const n = Math.round(Number(ms));
    if (!Number.isFinite(n)) return;
    const clamped = Math.max(-SYNC_OFFSET_LIMIT_MS, Math.min(SYNC_OFFSET_LIMIT_MS, n));
    if (clamped === this.syncOffsetMs) return;
    this.syncOffsetMs = clamped;
    this._reseek();
  }

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
    delete restored.fadeMs;
    if (this._startFadeMs > 0) restored.fadeMs = this._startFadeMs;
    this._startFadeMs = 0;
    const anchorMs = this._sceneAnchorMs(posMs);
    if (anchorMs !== null) restored.anchorMs = anchorMs;
    else if (lastPatchMs !== undefined) restored.anchorMs = lastPatchMs;
    // Restore the whole scene after a seek so legacy pattern and colour shows cannot retain stale output.
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

  async _loadFromCache(cacheKey: string | null, isCurrent: () => boolean = () => true): Promise<boolean> {
    if (!cacheKey || !this._cache) return false;
    const cached = await this._cache.load(cacheKey);
    if (!cached) return false;
    if (!isCurrent()) throw supersededError();
    console.log(`[auto-show] analysis cache hit: ${cacheKey}`);
    console.log(`[auto-show] Models used (cached ${cacheKey}): ${formatModelUsage(cached)}`);
    this.analysis = cached;
    this.analysisKey = cacheKey;
    this.buildTimeline();
    this._status = 'ready';
    return true;
  }

  async resume(cacheKey: string, track: ShowTrack | null): Promise<boolean> {
    this.track = track;
    try {
      return await this._loadFromCache(cacheKey);
    } catch (_) {
      return false;
    }
  }

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

  pauseAnalysis(reason: string): void {
    if (this._worker) this._worker.pause(reason);
  }

  resumeAnalysis(): void {
    if (this._worker) this._worker.resume();
  }

  restartWorker(reason: string, opts: { whenIdle?: boolean } = {}): void {
    if (this._worker) this._worker.restart(reason, opts);
  }

  applyQueueOrder(cacheKeys: readonly (string | null)[]): void {
    if (this._worker) this._worker.setQueueOrder(cacheKeys);
  }

  destroy(): void {
    this.stop();
    if (this._worker) this._worker.shutdown();
  }

  async analyze(source: string, cacheKey: string | null = null): Promise<Analysis | null> {
    const token = Symbol(cacheKey || source);
    this._beginJob(token, cacheKey);
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
      this._jobFailed(isCurrent, err);
      throw err;
    }
  }

  setExactAudio(cacheKey: string, source: ExactAudio): void {
    this._exactAudio.delete(cacheKey);
    this._exactAudio.set(cacheKey, source);
    while (this._exactAudio.size > EXACT_AUDIO_KEPT) {
      this._exactAudio.delete(this._exactAudio.keys().next().value as string);
    }
  }

  async _fetchAnalysis(query: string, targetDurationSec: number | null, cacheKey: string | null,
    meta: CacheMeta | undefined, isrc: string | null, onPhase: ((phase: string) => void) | null,
    priority: AnalysisPriority, queuePos?: number | null): Promise<Analysis> {
    let audioPath: string | null = null;
    try {
      const exact = cacheKey ? this._exactAudio.get(cacheKey) : undefined;
      if (exact) {
        audioPath = await exact.fetch();
        if (!audioPath) throw new Error('the track\'s own audio file could not be fetched');
        targetDurationSec = null;
      } else {
        audioPath = await this._downloadAudio(query, targetDurationSec, isrc);
      }
      if (cacheKey && this._cancelledKeys.delete(cacheKey)) throw cancelledError();
      if (onPhase) onPhase('analyzing');
      let analysis = await this._runAnalyzer(audioPath, targetDurationSec, priority, cacheKey, queuePos);
      if (exact && exact.refine) {
        try {
          analysis = await exact.refine(analysis);
        } catch (err) {
          console.warn(`[auto-show] kept the analysis as it was for ${cacheKey}: ${messageOf(err)}`);
        }
      }
      if (cacheKey && this._cache) {
        await this._cache.save(cacheKey, analysis, meta || {});
        this._noteCached(cacheKey, analysis);
      }
      return analysis;
    } finally {
      if (audioPath) { try { fs.unlinkSync(audioPath); } catch (_) {} }
    }
  }

  _fetchShared(query: string, targetDurationSec: number | null, cacheKey: string | null,
    meta: CacheMeta | undefined, isrc: string | null, onPhase: ((phase: string) => void) | null,
    priority: AnalysisPriority, queuePos?: number | null): Promise<Analysis> {
    if (cacheKey && this._inFlight.has(cacheKey)) {
      if (priority !== 'normal' && this._worker) this._worker.promote(cacheKey, priority);
      return this._inFlight.get(cacheKey) as Promise<Analysis>;
    }
    if (cacheKey) this._cancelledKeys.delete(cacheKey);
    const promise = this._fetchAnalysis(query, targetDurationSec, cacheKey, meta, isrc, onPhase, priority, queuePos);
    if (cacheKey) {
      this._inFlight.set(cacheKey, promise);
      const cleanup = () => { this._inFlight.delete(cacheKey); this._cancelledKeys.delete(cacheKey); };
      promise.then(cleanup, cleanup);
    }
    return promise;
  }

  async awaitInFlight(cacheKey: string, priority: AnalysisPriority = 'current'): Promise<void> {
    const pending = this._inFlight.get(cacheKey);
    if (!pending) return;
    if (this._worker) this._worker.promote(cacheKey, priority);
    await pending.catch(() => {});
  }

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

  async downloadAndAnalyze(query: string, targetDurationSec: number | null = null, cacheKey: string | null = null,
    isrc: string | null = null): Promise<{ analysis: Analysis | null; cached: boolean }> {
    const token = Symbol(cacheKey || query);
    this._beginJob(token, cacheKey);
    const isCurrent = () => this._currentJob === token;

    if (await this._loadFromCache(cacheKey, isCurrent)) {
      return { analysis: this.analysis, cached: true };
    }

    const joining = !!cacheKey && this._inFlight.has(cacheKey);
    this._status = joining ? 'analyzing' : 'downloading';

    try {
      const analysis = await this._fetchShared(
        query, targetDurationSec, cacheKey,
        { track: this.track }, isrc,
        (phase) => { if (phase === 'analyzing' && isCurrent()) this._status = 'analyzing'; },
        'current',
      );
      if (!isCurrent()) throw supersededError();
      this.analysis = analysis;
      this.analysisKey = cacheKey;
      this.buildTimeline();
      this._status = 'ready';
      return { analysis, cached: joining };
    } catch (err) {
      this._jobFailed(isCurrent, err);
      throw err;
    }
  }

  _beginJob(token: symbol, cacheKey: string | null): void {
    this._currentJob = token;
    this._currentKey = cacheKey;
    this._lastError = null;
  }

  _jobFailed(isCurrent: () => boolean, err: unknown): void {
    if (!isCurrent()) return;
    this._status = 'idle';
    this._currentKey = null;
    this.startPending = null;
    if (!isCancelled(err) && !(err && typeof err === 'object' && (err as { superseded?: unknown }).superseded)) {
      this._lastError = { message: messageOf(err), at: Date.now() };
    }
  }

  cancelAnalysis(): boolean {
    if (this._status !== 'analyzing' && this._status !== 'downloading') return false;
    const key = this._currentKey;
    this._currentJob = null;
    this._currentKey = null;
    this.startPending = null;
    this._status = this.analysis ? 'ready' : 'idle';
    if (key) {
      this._cancelledKeys.add(key);
      if (this._worker) this._worker.cancel(key);
    }
    return true;
  }

  async _downloadAudio(query: string, targetDurationSec: number | null = null, isrc: string | null = null): Promise<string> {
    const isUrl = /^https?:\/\//.test(query);

    if (!isrc && !isUrl && deezer.isAvailable()) {
      const parts = splitQuery(query);
      if (parts) {
        isrc = await resolveIsrc({ ...parts, durationSec: targetDurationSec });
        if (isrc) console.log(`[isrc] "${query}" → ${isrc}`);
      }
    }

    if (isrc && !isUrl && deezer.isAvailable()) {
      try {
        return await deezer.downloadByIsrc(query, isrc);
      } catch (err) {
        console.warn(`[deezer] Failed for "${query}" (ISRC: ${isrc}): ${messageOf(err)} — falling back to yt-dlp`);
      }
    }

    const found = await ytdlp.find();
    const ff = await tools.ffmpeg();
    const runtime = {
      command: found ? found.command : 'yt-dlp',
      args: [
        ...ytdlp.runtimeArgs(found ? found.version : null),
        ...(ff && ff.from === 'environment' ? ['--ffmpeg-location', ff.command] : []),
      ],
    };
    const target = typeof targetDurationSec === 'number' && Number.isFinite(targetDurationSec) && targetDurationSec > 0
      ? targetDurationSec : null;
    if (target !== null && !isUrl) {
      try {
        return await this._ytDlpExec(query, target, runtime);
      } catch (err) {
        if (/output file not found/i.test(messageOf(err))) {
          console.warn(`[yt-dlp] No result matched ${Math.round(target)}s ±5s, retrying without duration filter`);
          return this._ytDlpExec(query, null, runtime);
        }
        throw err;
      }
    }
    return this._ytDlpExec(query, null, runtime);
  }

  _ytDlpExec(query: string, targetDurationSec: number | null,
    runtime: { command: string; args: string[] } = { command: 'yt-dlp', args: [] }): Promise<string> {
    return new Promise((resolve, reject) => {
      const basename = `auto-dl-${randomUUID()}`;
      const outputTemplate = path.join(os.tmpdir(), `${basename}.%(ext)s`);
      const expectedWav = path.join(os.tmpdir(), `${basename}.wav`);

      const isUrl = /^https?:\/\//.test(query);
      const duration = typeof targetDurationSec === 'number' && Number.isFinite(targetDurationSec) && targetDurationSec > 0
        ? targetDurationSec : null;
      const useFilter = !isUrl && duration !== null;
      const source = isUrl ? query : (useFilter ? `ytsearch5:${query}` : `ytsearch1:${query}`);

      const args = [
        '-x',
        '--audio-format', 'wav',
        '--audio-quality', '0',
        '--no-playlist',
        '--no-warnings',
        ...runtime.args,
      ];

      if (useFilter) {
        const tolerance = 5; // seconds
        const minDur = Math.max(1, Math.floor(duration - tolerance));
        const maxDur = Math.ceil(duration + tolerance);
        args.push('--match-filter', `duration >= ${minDur} & duration <= ${maxDur}`);
        args.push('--max-downloads', '1');
      }

      args.push('-o', outputTemplate, source);

      console.log(`[yt-dlp] Downloading: ${query}${useFilter ? ` (target ${Math.round(duration)}s ±5s)` : ''}`);
      const proc = spawn(runtime.command, args, {
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
      if (typeof timer.unref === 'function') timer.unref();

      proc.on('error', (err) => {
        clearTimeout(timer);
        reject(new Error(
          'yt-dlp not found. Set up the analysis environment (Sources → Analysis), which installs it, or install it: '
          + `pip install "yt-dlp[default]"  (or download from https://github.com/yt-dlp/yt-dlp)\n${err.message}`
        ));
      });

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
            + '(raise the download timeout under Sources → Analysis)'
          ));
        }
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

  buildTimeline(): void {
    if (!this.analysis) return;

    const director = new ShowDirector({
      patterns: this._patterns,
      colorPresets: this._colorPresets,
      paletteSize: this.paletteSize,
      intensity: this.intensity,
      blackoutIndex: this._blackoutIdx,
      pixels: this._pixels,
      panels: this._panels,
      lamps: this._lamps,
      history: settings.group('auto').setMemory === false ? null : this._memory.history(this._memoryKey()),
      overlay: this.overlay(),
    });

    this._grid = gridFromAnalysis(this.analysis);
    this._pulse = pulseTrack(this.analysis.pulse);
    const plan = director.plan(this.analysis);
    this.palette = plan.palette;
    this.paletteName = plan.paletteName;
    this.resolvedPaletteSize = plan.paletteSize;
    this._planMemory = plan.memory;
    this._arc = plan.context.arc;
    this.intents = plan.intents;
    this.timeline = renderIntents(plan.intents, { blackoutIndex: this._blackoutIdx });
    this.timelineRevision = randomUUID();
    if (this.running) this._reseek();
  }

  start(getPositionMs: () => number, { fadeMs = 0 }: { fadeMs?: number } = {}): void {
    if (!this.timeline.length) return;
    if (this.running) return;
    this._getPositionMs = getPositionMs;
    this._startFadeMs = Math.max(0, Math.min(10000, Math.round(Number(fadeMs) || 0)));
    this.autoSyncMs = 0;
    this.running = true;
    this._lastEventIdx = -1;
    this._lastPositionMs = undefined;
    this._status = 'playing';
    if (this._planMemory) this._memory.record({ key: this._memoryKey(), ...this._planMemory });
    this._reseek();
    this._tick();
    if (!this._frameDriven) this._loopTimer = setInterval(guarded('auto-show', () => this._tick()), 20);
  }

  stop(): void {
    this.running = false;
    this._startFadeMs = 0;
    this._status = this.analysis ? 'ready' : 'idle';
    if (this._loopTimer) { clearInterval(this._loopTimer); this._loopTimer = null; }
    this._cancelEnergyTimer();
    this._applyPatch({
      energyOverride: null, showDynamics: null, split: null, pixelPattern: null, panelPattern: null, pixelMap: 'stage',
    });
  }

  reset(): void {
    this.stop();
    this.analysis = null;
    this.analysisKey = null;
    this._grid = null;
    this._pulse = null;
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
        const { masterDimmer: _dimmer, masterBlackout: _blackout, ...rest } = (ev.data || {}) as ReplayedPatch;
        const patch: ReplayedPatch = rest;
        if ('energyOverride' in patch) this._cancelEnergyTimer();
        patch.anchorMs = ev.timeMs;
        this._applyPatch(patch);
        break;
      }
      case 'energy': {
        const duration = ev.data.durationMs || 200;
        this._applyPatch({ energyOverride: ev.data.id });
        this._cancelEnergyTimer();
        this._energyTimer = setTimeout(() => {
          this._energyTimer = null;
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

  setPaletteSize(n: unknown): void {
    const size = n === 'auto' ? 'auto' : n === 2 ? 2 : n === 3 ? 3 : 4;
    if (size === this.paletteSize) return;
    this.paletteSize = size;
    if (this.analysis) {
      this.buildTimeline();
    }
  }

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

  setRig({ hasPixels = false, hasPanels = false, lamps = null }:
    { hasPixels?: boolean; hasPanels?: boolean; lamps?: number | null } = {}): void {
    const pixels = !!hasPixels;
    const panels = pixels && !!hasPanels;
    const count = Number.isFinite(lamps) ? lamps : null;
    const kit = (n: number | null) => n === null || n >= 3;
    if (pixels === this._pixels && panels === this._panels && kit(count) === kit(this._lamps)) {
      this._lamps = count;
      return;
    }
    this._pixels = pixels;
    this._panels = panels;
    this._lamps = count;
    if (this.analysis) this.buildTimeline();
  }

  overlay(): ShowOverlay | null {
    const key = this.analysisKey;
    if (!this._overlay || this._overlay.key !== key) {
      this._overlay = { key, overlay: key && this._cache ? this._cache.overlay(key) : null };
    }
    return this._overlay.overlay;
  }

  setOverlay(overlay: ShowOverlay | null): void {
    const key = this.analysisKey;
    if (key && this._cache) this._cache.setOverlay(key, overlay);
    this._overlay = { key, overlay };
    if (this.analysis) this.buildTimeline();
  }

  _memoryKey(): string {
    const t = this.track;
    return this.analysisKey || (t ? `${t.artist}|${t.name}` : 'track');
  }

  _buildupAccel(build: { start: number; end: number }, a: Analysis, baseBpm: number): ReturnType<typeof measureBuildup> {
    return measureBuildup(build, a, baseBpm);
  }

  getTimelineData() {
    if (!this.analysis) return null;
    const a = this.analysis;
    const timeline = this.timeline.map((ev) => {
      const data = ev.data as Partial<PatchData & EnergyData> | undefined;
      return {
      timeMs: ev.timeMs,
      action: ev.action,
      id: data && data.id,
      pattern: data && data.pattern,
      pixelPattern: data && data.pixelPattern,
      panelPattern: data && data.panelPattern,
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
      error: this._lastError,
      startPending: !!this.startPending,
      track: this.track,
      palette: this.palette,
      paletteName: this.paletteName,
      paletteSize: this.resolvedPaletteSize || this.paletteSize,
      paletteSizeMode: this.paletteSize === 'auto' ? 'auto' : 'manual',
      intensity: this.intensity,
      syncOffsetMs: this.syncOffsetMs,
      autoSyncMs: Math.round(this.autoSyncMs),
      pixels: this._pixels,
      panels: this._panels,
      analysisKey: this.analysisKey,
      overlay: this.analysis ? this.overlay() : null,
      set: {
        memory: settings.group('auto').setMemory !== false,
        tracks: this._memory.size,
        arc: this._arc ? this._arc.reason : null,
      },
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

Object.defineProperty(AutoShow, 'PYTHON_EXE', { get: () => pythonEnv.pythonExe() });

export default AutoShow;
