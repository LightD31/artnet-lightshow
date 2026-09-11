'use strict';

const { spawn } = require('child_process');
const { settings } = require('./server/settings');
const path = require('path');
const fs = require('fs');
const os = require('os');
const deezer = require('./deezer');
const AnalyzerWorker = require('./analyzer-worker');
const { describeModelUsage, formatModelUsage } = require('./model-usage');
const pythonEnv = require('./python-env');
const { SYNC_OFFSET_LIMIT_MS } = require('./server/presets');
const { ShowDirector, measureBuildup } = require('./show/director');
const { renderIntents } = require('./show/render');

// A download that never finishes is indistinguishable from one that never
// started: the track change waits on this promise, so an unresponsive network
// or a yt-dlp stuck on an extractor would leave the show on the previous
// track's timeline with no error and no recovery. The analyzer worker already
// bounds its own stage; this bounds the download.
function downloadTimeoutMs() {
  return settings.get('analysis.downloadTimeoutMs');
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
  constructor(applyPatch, colorPresets, patterns, cache = null) {
    this._applyPatch = applyPatch;
    this._colorPresets = colorPresets;
    this._patterns = patterns;
    this._cache = cache;
    this._worker = new AnalyzerWorker(
      pythonEnv.pythonExe, path.join(__dirname, 'analyze.py'),
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
    this._activeEnergyClearAt = 0; // guard against overlapping energy overrides
    // Shared in-flight work map so concurrent callers for the same cacheKey
    // (e.g. a prefetch that's still running when the track changes) join the
    // same download/analyze job instead of racing it.
    this._inFlight = new Map(); // cacheKey -> Promise<analysis>
  }

  get status() { return this._status; }

  /** True when this cacheKey's analysis is already on disk (cheap check). */
  isCached(cacheKey) {
    return !!(cacheKey && this._cache && this._cache.has(cacheKey));
  }

  /** True when a download/analyze for this cacheKey is currently running. */
  isPrefetching(cacheKey) {
    return !!(cacheKey && this._inFlight.has(cacheKey));
  }

  /**
   * Where the show is being played from, in ms — the position the source
   * reports, shifted by the operator's sync offset. 0 when not playing.
   *
   * Everything that drives or seeks the timeline reads this rather than the
   * raw source, so one number lines the whole show up with the room.
   */
  getPositionMs() {
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
  setSyncOffsetMs(ms) {
    const n = Math.round(Number(ms));
    if (!Number.isFinite(n)) return;
    const clamped = Math.max(-SYNC_OFFSET_LIMIT_MS, Math.min(SYNC_OFFSET_LIMIT_MS, n));
    if (clamped === this.syncOffsetMs) return;
    this.syncOffsetMs = clamped;
    this._reseek();
  }

  /**
   * Park the playback cursor at the current position without firing anything.
   *
   * Rebuilding or re-timing the timeline under a running show leaves the
   * cursor pointing into the old one; without this the next tick replays every
   * past event at once, which on a live rig is a burst of energy overrides.
   */
  _reseek() {
    if (!this.running || !this._getPositionMs) {
      this._lastEventIdx = -1;
      return;
    }
    const posMs = this.getPositionMs();
    let last = -1;
    const restored = { energyOverride: null, showDynamics: null };
    for (let i = 0; i < this.timeline.length; i++) {
      if (this.timeline[i].timeMs > posMs) break;
      const ev = this.timeline[i];
      if (ev.action === 'patch') {
        if (ev.data.showDynamics && restored.showDynamics) {
          restored.showDynamics = { ...restored.showDynamics, ...ev.data.showDynamics };
          const { showDynamics: _dynamics, ...rest } = ev.data;
          Object.assign(restored, rest);
        } else Object.assign(restored, ev.data);
      }
      last = i;
    }
    delete restored.masterDimmer;
    restored.energyOverride = null;
    if (this.timeline.some(e => e.data?.showDynamics)) this._applyPatch(restored);
    this._lastPositionMs = posMs;
    this._lastEventIdx = last;
  }

  // ── 1. Analysis ─────────────────────────────────────────────────────────────

  /**
   * Load a previously-analyzed result from the cache without touching audio.
   * Returns true on hit, false on miss.
   */
  _loadFromCache(cacheKey) {
    if (!cacheKey || !this._cache) return false;
    const cached = this._cache.get(cacheKey);
    if (!cached) return false;
    console.log(`[auto-show] analysis cache hit: ${cacheKey}`);
    console.log(`[auto-show] Models used (cached ${cacheKey}): ${formatModelUsage(cached)}`);
    this.analysis = cached;
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
  _runAnalyzer(source, targetDurationSec = null, priority = 'normal', tag = null) {
    const tgt = Number.isFinite(targetDurationSec) && targetDurationSec > 0
      ? targetDurationSec : null;
    console.log(`[analyzer] Analyzing${priority === 'high' ? ' (high)' : ''}: ${path.basename(source)}${tgt ? ` (target ${Math.round(tgt)}s)` : ''}`);
    return this._worker.analyze(source, tgt, { priority, tag }).then((result) => {
      console.log(`[analyzer] Models used (${path.basename(source)}): ${formatModelUsage(result)}`);
      return result;
    });
  }

  /**
   * Tear down the persistent analyzer subprocess. Called on server shutdown.
   * Safe to call multiple times.
   */
  /** Recycle the analyzer process — used when the interpreter changes. */
  restartWorker(reason) {
    if (this._worker) this._worker.restart(reason);
  }

  destroy() {
    this.stop();
    if (this._worker) this._worker.shutdown();
  }

  async analyze(source, cacheKey = null) {
    if (this._loadFromCache(cacheKey)) return this.analysis;
    this._status = 'analyzing';
    try {
      const result = await this._runAnalyzer(source);
      this.analysis = result;
      this.buildTimeline();
      this._status = 'ready';
      if (cacheKey && this._cache) {
        this._cache.set(cacheKey, result, { track: this.track });
      }
      return result;
    } catch (err) {
      this._status = 'idle';
      throw err;
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
  async _fetchAnalysis(query, targetDurationSec, cacheKey, meta, isrc, onPhase, priority) {
    let audioPath = null;
    try {
      audioPath = await this._downloadAudio(query, targetDurationSec, isrc);
      if (onPhase) onPhase('analyzing');
      // Always pass the target duration to the analyzer when we have one —
      // it will no-op when the downloaded length is already within the ±2s
      // tolerance, and trim beatless padding when the yt-dlp fallback grabs
      // a longer version. The cacheKey doubles as the worker-queue tag so
      // a later high-priority join can find and bump this entry.
      const analysis = await this._runAnalyzer(audioPath, targetDurationSec, priority, cacheKey);
      if (cacheKey && this._cache) {
        this._cache.set(cacheKey, analysis, meta || {});
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
  _fetchShared(query, targetDurationSec, cacheKey, meta, isrc, onPhase, priority) {
    if (cacheKey && this._inFlight.has(cacheKey)) {
      // Joining an existing fetch — if we're now urgent (downloadAndAnalyze
      // for the current track) but the original submission was a background
      // prefetch, promote the worker queue entry so it doesn't sit behind
      // other normal-priority prefetches.
      if (priority === 'high' && this._worker) this._worker.bumpToHigh(cacheKey);
      return this._inFlight.get(cacheKey);
    }
    const promise = this._fetchAnalysis(query, targetDurationSec, cacheKey, meta, isrc, onPhase, priority);
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
   * Returns { skipped: boolean, reason?: string, error?: string }.
   */
  async prefetch(query, targetDurationSec, cacheKey, meta = {}, isrc = null, priority = 'normal') {
    if (!cacheKey || !this._cache) return { skipped: true, reason: 'no-cache' };
    if (this._cache.get(cacheKey)) return { skipped: true, reason: 'already-cached' };
    if (this._inFlight.has(cacheKey)) return { skipped: true, reason: 'in-flight' };

    try {
      console.log(`[auto-show] prefetching${priority === 'high' ? ' (high)' : ''}: ${query}`);
      await this._fetchShared(query, targetDurationSec, cacheKey, meta, isrc, null, priority);
      console.log(`[auto-show] prefetched and cached: ${cacheKey}`);
      return { skipped: false };
    } catch (err) {
      console.warn(`[auto-show] prefetch failed for ${cacheKey}: ${err.message}`);
      return { skipped: false, error: err.message };
    }
  }

  async downloadAndAnalyze(query, targetDurationSec = null, cacheKey = null, isrc = null) {
    // Cache hit → skip the download entirely.
    if (this._loadFromCache(cacheKey)) {
      return { analysis: this.analysis, cached: true };
    }

    // If a prefetch for this key is already running, join it instead of
    // kicking off a parallel yt-dlp/analyzer job for the same track.
    const joining = cacheKey && this._inFlight.has(cacheKey);
    this._status = joining ? 'analyzing' : 'downloading';

    try {
      const analysis = await this._fetchShared(
        query, targetDurationSec, cacheKey,
        { track: this.track }, isrc,
        // Flip the badge to ANALYZING once the WAV is on disk — librosa
        // alone takes 30-90s on a 3-5min track, and leaving "DOWNLOADING"
        // up that whole time reads as a hang.
        (phase) => { if (phase === 'analyzing') this._status = 'analyzing'; },
        // The track the user is about to hear — outranks any background
        // prefetches sitting in the worker queue.
        'high',
      );
      this.analysis = analysis;
      this.buildTimeline();
      this._status = 'ready';
      return { analysis, cached: joining };
    } catch (err) {
      this._status = 'idle';
      throw err;
    }
  }

  /**
   * Download audio for analysis. When an ISRC is provided and Deezer is
   * configured, downloads the exact studio track from Deezer — guaranteed
   * audio-only and correct duration. Falls back to yt-dlp when Deezer is
   * unavailable, the ISRC lookup fails, or the source is a direct URL.
   */
  async _downloadAudio(query, targetDurationSec = null, isrc = null) {
    const isUrl = /^https?:\/\//.test(query);

    // Try Deezer first when we have an ISRC and Deezer is initialized
    if (isrc && !isUrl && deezer.isAvailable()) {
      try {
        return await deezer.downloadByIsrc(query, isrc);
      } catch (err) {
        console.warn(`[deezer] Failed for "${query}" (ISRC: ${isrc}): ${err.message} — falling back to yt-dlp`);
      }
    }

    // Fallback: yt-dlp
    const hasTarget = Number.isFinite(targetDurationSec) && targetDurationSec > 0;
    if (hasTarget && !isUrl) {
      try {
        return await this._ytDlpExec(query, targetDurationSec);
      } catch (err) {
        // No video passed the duration filter — retry without it.
        if (/output file not found/i.test(err.message)) {
          console.warn(`[yt-dlp] No result matched ${Math.round(targetDurationSec)}s ±5s, retrying without duration filter`);
          return this._ytDlpExec(query, null);
        }
        throw err;
      }
    }
    return this._ytDlpExec(query, null);
  }

  _ytDlpExec(query, targetDurationSec) {
    return new Promise((resolve, reject) => {
      const basename = `auto-dl-${Date.now()}`;
      const outputTemplate = path.join(os.tmpdir(), `${basename}.%(ext)s`);
      const expectedWav = path.join(os.tmpdir(), `${basename}.wav`);

      const isUrl = /^https?:\/\//.test(query);
      const useFilter = !isUrl && Number.isFinite(targetDurationSec) && targetDurationSec > 0;
      // With a duration filter we widen the search so yt-dlp has more candidates
      // to skim through before giving up.
      const source = isUrl ? query : (useFilter ? `ytsearch5:${query}` : `ytsearch1:${query}`);

      const args = [
        '-x',
        '--audio-format', 'wav',
        '--audio-quality', '0',
        '--no-playlist',
        '--no-warnings',
      ];

      if (useFilter) {
        const tolerance = 5; // seconds
        const minDur = Math.max(1, Math.floor(targetDurationSec - tolerance));
        const maxDur = Math.ceil(targetDurationSec + tolerance);
        args.push('--match-filter', `duration >= ${minDur} & duration <= ${maxDur}`);
        // Stop after the first candidate that passes the filter.
        args.push('--max-downloads', '1');
      }

      args.push('-o', outputTemplate, source);

      console.log(`[yt-dlp] Downloading: ${query}${useFilter ? ` (target ${Math.round(targetDurationSec)}s ±5s)` : ''}`);
      const proc = spawn('yt-dlp', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let timedOut = false;
      proc.stdout.on('data', (d) => { stdout += d; });
      proc.stderr.on('data', (d) => { stderr += d; });

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

      proc.on('close', (code) => {
        clearTimeout(timer);
        if (timedOut) {
          return reject(new Error(
            `yt-dlp timed out after ${Math.round(downloadTimeoutMs() / 1000)}s `
            + '(raise the download timeout in the settings page)'
          ));
        }
        // yt-dlp exits 101 when --max-downloads is reached — that's the normal
        // success path for a filtered search, so treat it the same as 0.
        if (code !== 0 && code !== 101) {
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
  buildTimeline() {
    if (!this.analysis) return;

    const director = new ShowDirector({
      patterns: this._patterns,
      colorPresets: this._colorPresets,
      paletteSize: this.paletteSize,
      intensity: this.intensity,
      blackoutIndex: this._blackoutIdx,
    });

    const plan = director.plan(this.analysis);
    this.palette = plan.palette;
    this.paletteName = plan.paletteName;
    // What the director settled on. Identical to `paletteSize` unless that is
    // 'auto', and it is what the client shows — an operator looking at the rig
    // needs to know it is on three colours, not that something chose three.
    this.resolvedPaletteSize = plan.paletteSize;
    this.intents = plan.intents;
    this.timeline = renderIntents(plan.intents, { blackoutIndex: this._blackoutIdx });
  }

  // ── 3. Playback ─────────────────────────────────────────────────────────────

  start(getPositionMs) {
    if (!this.timeline.length) return;
    this._getPositionMs = getPositionMs;
    this.running = true;
    this._lastEventIdx = -1;
    this._activeEnergyClearAt = 0;
    this._status = 'playing';
    this._expressive = this.timeline.some(e => e.data?.showDynamics);
    this._lastPositionMs = undefined;
    if (this._expressive) this._reseek();
    this._tick();
    this._loopTimer = setInterval(() => this._tick(), 20);
  }

  stop() {
    this.running = false;
    this._status = this.analysis ? 'ready' : 'idle';
    if (this._loopTimer) { clearInterval(this._loopTimer); this._loopTimer = null; }
    // Clear any lingering energy override so we don't leave the rig stuck
    this._applyPatch({ energyOverride: null, showDynamics: null });
  }

  reset() {
    this.stop();
    this.analysis = null;
    this.timeline = [];
    this.track = null;
    this.palette = null;
    this.paletteName = null;
    this._lastEventIdx = -1;
    this._status = 'idle';
  }

  _tick() {
    if (!this.running || !this._getPositionMs) return;
    const posMs = this.getPositionMs();
    if (this._expressive && Number.isFinite(this._lastPositionMs)
        && (posMs < this._lastPositionMs - 100 || posMs > this._lastPositionMs + 1500)) {
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
          `[auto-show] event ${i} at ${ev.timeMs}ms (${ev.action}) rejected: ${err.message}`,
          ev.data,
        );
      }
      this._lastEventIdx = i;
    }
  }

  _fireEvent(ev) {
    switch (ev.action) {
      case 'patch':
        // Safety net: never allow a timeline event to move the master fader.
        if (ev.data && 'masterDimmer' in ev.data) delete ev.data.masterDimmer;
        this._applyPatch(ev.data);
        break;
      case 'energy': {
        const duration = ev.data.durationMs || 200;
        const clearAt = Date.now() + duration;
        this._activeEnergyClearAt = clearAt;
        this._applyPatch({ energyOverride: ev.data.id });
        setTimeout(() => {
          // Its own timer, so it needs its own guard — a throw here would be
          // just as fatal as one in _tick, and it would also leave the rig
          // stuck holding the energy override it was about to clear.
          try {
            // Only clear if this burst is still the active one (avoids races)
            if (this.running && Date.now() >= this._activeEnergyClearAt - 5) {
              this._applyPatch({ energyOverride: null });
            }
          } catch (err) {
            console.error(`[auto-show] could not clear energy override: ${err.message}`);
          }
        }, duration);
        break;
      }
    }
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
  setPaletteSize(n) {
    const size = n === 'auto' ? 'auto' : n === 2 ? 2 : n === 3 ? 3 : 4;
    if (size === this.paletteSize) return;
    this.paletteSize = size;
    if (this.analysis) {
      this.buildTimeline();
      this._reseek();
    }
  }

  /**
   * Set the energy intensity (0-100). Rebuilds the timeline so accent density,
   * drop effects and beat-division scaling adjust on the fly.
   */
  setIntensity(n) {
    const val = Math.max(0, Math.min(100, Math.round(Number(n) || 50)));
    if (val === this.intensity) return;
    this.intensity = val;
    if (this.analysis) {
      this.buildTimeline();
      this._reseek();
    }
  }

  /** See src/show/director.js — measured build-up acceleration. */
  _buildupAccel(build, a, baseBpm) {
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
    const timeline = this.timeline.map(ev => ({
      timeMs: ev.timeMs,
      action: ev.action,
      id: ev.data && ev.data.id,
      pattern: ev.data && ev.data.pattern,
      colorA: ev.data && ev.data.colorA,
      durationMs: ev.data && ev.data.durationMs,
    }));
    return {
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
    };
  }
}

module.exports = AutoShow;
// Kept as a getter: callers (the startup banner, scripts/bench-worker.js) read
// it after the settings store has loaded, and it must reflect a configured
// interpreter rather than a value frozen at require time.
Object.defineProperty(module.exports, 'PYTHON_EXE', { get: () => pythonEnv.pythonExe() });
