'use strict';

const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const deezer = require('./deezer');
const AnalyzerWorker = require('./analyzer-worker');

// Resolve a working Python executable once at startup. On Windows, `python`
// often points at the Microsoft Store stub which exits non-zero and produces
// no usable stderr — the symptom is "analysis silently fails after download".
// Probing with --version and checking the exit code filters the stub out.
// Order: `py` (Windows launcher, shipped with python.org installers) → `python3`
// → `python`. Falls back to 'python' so the eventual spawn surfaces a clear
// error if nothing is installed at all.
const PYTHON_EXE = (() => {
  const candidates = process.platform === 'win32'
    ? ['py', 'python3', 'python']
    : ['python3', 'python'];
  for (const name of candidates) {
    try {
      const r = spawnSync(name, ['--version'], { stdio: 'ignore' });
      if (r.status === 0) return name;
    } catch (_) { /* try the next candidate */ }
  }
  return 'python';
})();

// ── Palette tetrads ─────────────────────────────────────────────────────────
// Each song locks to a single 4-colour "look" from this bank for the whole
// track. Hand-tuned for coherence — most follow the tetrad rule (two pairs of
// analogous + complement) or split-complementary (one dominant + two accents).
//
// Colour preset indices (see server.js COLOR_PRESETS):
//   0=Crimson 1=Flame 2=Amber 3=Sun 4=Lime 5=Aqua 6=Cobalt 7=Violet 8=Fuchsia
//   9=Daylight White 10=UV 11=Actinic 12=Rose 13=Teal 14=Gold 15=Tungsten White
//   16=Mint 17=Sky 18=Indigo 19=Coral 20=Lavender 21=Acid 22=Moonlight
//
// Ordering inside each tetrad matters: position 0 is the "anchor" that shows
// up first, positions 1-3 fill out the coherent pairings.
const TETRADS = {
  synthwave:   [8, 6, 12, 11],  // Fuchsia / Cobalt / Rose / Actinic — high-energy club contrast
  sunsetDrive: [1, 19, 8, 15],  // Flame / Coral / Fuchsia / Tungsten White — warm lead with glam accent
  solarPunch:  [3, 2, 14, 6],   // Sun / Amber / Gold / Cobalt — warm dominant + cool counter
  deepOcean:   [5, 13, 6, 17],  // Aqua / Teal / Cobalt / Sky — cool analogous depth
  emeraldCity: [4, 16, 13, 14], // Lime / Mint / Teal / Gold — natural greens with premium warmth
  arctic:      [17, 6, 9, 20],  // Sky / Cobalt / Daylight White / Lavender — icy cinematic look
  violetDream: [7, 20, 8, 9],   // Violet / Lavender / Fuchsia / Daylight White — dreamy purple family
  volcanic:    [0, 1, 14, 15],  // Crimson / Flame / Gold / Tungsten White — aggressive warm concert look
  candyPop:    [12, 8, 3, 5],   // Rose / Fuchsia / Sun / Aqua — playful high-separation tetrad
  halloween: [1, 7, 14, 10],  // Orange / Purple / Gold / UV — spooky
  noirUv:      [10, 11, 18, 9], // UV / Actinic / Indigo / Daylight White — dark room + UV accent
  desert:      [2, 14, 19, 15], // Amber / Gold / Coral / Tungsten White — earthy warm theatre wash
  royal:       [7, 18, 14, 9],  // Violet / Indigo / Gold / Daylight White — regal stage contrast
  tropical:    [16, 13, 3, 19], // Mint / Teal / Sun / Coral — festival warm/cool crossover
  aurora:      [17, 16, 20, 11],// Sky / Mint / Lavender / Actinic — ethereal atmospheric blend
  lunar:       [9, 15, 6, 18],  // Daylight White / Tungsten White / Cobalt / Indigo — monochrome+cold accents
};

// Triad banks (3-colour looks). Hand-picked — NOT slices of TETRADS — so the
// 3-colour view stays visually coherent (triads favour three well-separated
// hues instead of the tetrad's two analogous pairs). Keys match TETRADS so
// the same genre/mood resolver can swap size without changing its logic.
const TRIADS = {
  synthwave:   [8, 6, 11],    // Fuchsia / Cobalt / Actinic
  sunsetDrive: [1, 19, 15],   // Flame / Coral / Tungsten White
  solarPunch:  [3, 14, 6],    // Sun / Gold / Cobalt
  deepOcean:   [5, 13, 6],    // Aqua / Teal / Cobalt
  emeraldCity: [4, 16, 14],   // Lime / Mint / Gold
  arctic:      [17, 6, 9],    // Sky / Cobalt / Daylight White
  violetDream: [7, 20, 9],    // Violet / Lavender / Daylight White
  volcanic:    [0, 1, 15],    // Crimson / Flame / Tungsten White
  candyPop:    [12, 3, 5],    // Rose / Sun / Aqua
  halloween:   [1, 7, 10],    // Flame / Violet / UV
  noirUv:      [10, 11, 18],  // UV / Actinic / Indigo
  desert:      [2, 14, 19],   // Amber / Gold / Coral
  royal:       [7, 14, 9],    // Violet / Gold / Daylight White
  tropical:    [16, 13, 19],  // Mint / Teal / Coral
  aurora:      [17, 16, 20],  // Sky / Mint / Lavender
  lunar:       [9, 6, 18],    // Daylight White / Cobalt / Indigo
};

// Duo banks (2-colour looks). Complementary pairs that read cleanly on a
// small rig — two hand-picked hues that contrast strongly instead of the
// tetrad's analogous pair (which would look like a single colour from the
// audience). Keys match TETRADS so the resolver works the same way.
const DUOS = {
  synthwave:   [8, 6],        // Fuchsia / Cobalt
  sunsetDrive: [1, 17],       // Flame / Sky
  solarPunch:  [3, 7],        // Sun / Violet
  deepOcean:   [5, 13],       // Aqua / Teal
  emeraldCity: [4, 14],       // Lime / Gold
  arctic:      [17, 9],       // Sky / Daylight White
  violetDream: [7, 9],        // Violet / Daylight White
  volcanic:    [0, 15],       // Crimson / Tungsten White
  candyPop:    [12, 5],       // Rose / Aqua
  halloween:   [1, 10],       // Flame / UV
  noirUv:      [10, 11],      // UV / Actinic
  desert:      [2, 6],        // Amber / Cobalt
  royal:       [7, 14],       // Violet / Gold
  tropical:    [16, 19],      // Mint / Coral
  aurora:      [16, 20],      // Mint / Lavender
  lunar:       [9, 18],       // Daylight White / Indigo
};

// Look up the right bank for a given palette size. 4 is the default (the
// hand-tuned tetrad set); 3 and 2 use dedicated banks above.
function paletteBankForSize(size) {
  if (size === 2) return DUOS;
  if (size === 3) return TRIADS;
  return TETRADS;
}

// Each genre picks from a short preference list; which one it actually lands
// on is keyed on the musical key so two EDM tracks in different keys get
// different looks but the same vocabulary.
//
// NOTE: tier keeps gating accent density / drop handling:
//   dance     — full banger (color-strobe accents, drop slams, white-strobe on
//                proper drops only)
//   moderate  — reduced bursts, no white-strobe
//   rock      — light bursts, proper drops only
//   calm      — no strobes, no drops
const GENRE_STYLES = {
  edm:       { tier: 'dance',    tetrads: ['synthwave', 'aurora', 'arctic'],
               patterns: ['pairs', 'runner', 'chase', 'split', 'stack-up', 'random-flash', 'hit', 'alt-halves', 'split-4', 'chase-4', 'pairs-4'] },
  dubstep:   { tier: 'dance',    tetrads: ['volcanic', 'noirUv', 'synthwave'],
               patterns: ['random-flash', 'stack-up', 'split', 'pairs', 'runner', 'hit', 'alt-halves', 'split-3', 'alt-thirds'] },
  trance:    { tier: 'dance',    tetrads: ['arctic', 'violetDream', 'aurora', 'synthwave'],
               patterns: ['sparkle', 'wave', 'twinkle', 'runner', 'hit', 'chase-3', 'alt-thirds'] },
  disco:     { tier: 'dance',    tetrads: ['candyPop', 'sunsetDrive', 'solarPunch'],
               patterns: ['ping-pong', 'chase', 'sparkle', 'pairs', 'alt-halves', 'split', 'split-4', 'alt-quarters', 'pairs-4'] },
  hiphop:    { tier: 'moderate', tetrads: ['volcanic', 'desert', 'royal'],
               patterns: ['pairs', 'split', 'chase', 'stack-up', 'runner', 'alt-halves', 'split-3', 'chase-3'] },
  pop:       { tier: 'moderate', tetrads: ['candyPop', 'sunsetDrive', 'tropical'],
               patterns: ['ping-pong', 'wave', 'chase', 'sparkle', 'pairs', 'split-3', 'chase-4'] },
  funk:      { tier: 'moderate', tetrads: ['solarPunch', 'tropical', 'sunsetDrive'],
               patterns: ['ping-pong', 'pairs', 'runner', 'chase', 'wave', 'alt-halves', 'split-4', 'alt-quarters'] },
  rock:      { tier: 'rock',     tetrads: ['volcanic', 'solarPunch', 'desert'],
               patterns: ['chase', 'runner', 'pairs', 'ping-pong', 'stack-up'] },
  metal:     { tier: 'rock',     tetrads: ['volcanic', 'noirUv', 'royal'],
               patterns: ['stack-up', 'split', 'random-flash', 'runner', 'pairs', 'hit'] },
  country:   { tier: 'rock',     tetrads: ['desert', 'solarPunch', 'sunsetDrive'],
               patterns: ['wave', 'chase', 'runner', 'ping-pong', 'fade'] },
  reggae:    { tier: 'rock',     tetrads: ['emeraldCity', 'tropical', 'solarPunch'],
               patterns: ['wave', 'fade', 'chase', 'ping-pong', 'pairs'] },
  latin:     { tier: 'calm',     tetrads: ['sunsetDrive', 'tropical', 'solarPunch'],
               patterns: ['ping-pong', 'runner', 'chase', 'pairs', 'wave'] },
  jazz:      { tier: 'calm',     tetrads: ['royal', 'lunar', 'violetDream'],
               patterns: ['solid', 'fade', 'wave', 'twinkle', 'sparkle'] },
  classical: { tier: 'calm',     tetrads: ['lunar', 'arctic', 'royal'],
               patterns: ['solid', 'fade', 'wave', 'twinkle'] },
  folk:      { tier: 'calm',     tetrads: ['desert', 'emeraldCity', 'lunar'],
               patterns: ['solid', 'fade', 'wave', 'twinkle'] },
  ambient:   { tier: 'calm',     tetrads: ['deepOcean', 'aurora', 'arctic'],
               patterns: ['solid', 'fade', 'wave', 'twinkle', 'sparkle'] },
};

// Fallback tetrad preferences when the genre classifier has no answer.
// Mapped onto Russell's circumplex model of affect (arousal × valence):
//
//                    high arousal
//                         │
//       angry / tense    ─┼─   excited / happy
//     (fire, monoRed,     │   (sunset, candy,
//      halloween)         │    warm, neon)
//  low valence ───────────┼─────────── high valence
//       sad / depressed   │    calm / content
//     (cool, ocean,       │   (golden, forest,
//      monoBlue, royal)   │    warm, royal)
//                         │
//                    low arousal
//
// Split the plane into four quadrants; each gets its own tetrad preference
// list. Inside a quadrant the key still selects which tetrad we land on, so
// same-mood different-key songs diverge.
const CIRCUMPLEX_TETRADS = {
  highPos: ['sunsetDrive', 'candyPop', 'tropical', 'solarPunch'], // excited / happy
  highNeg: ['volcanic', 'noirUv', 'halloween', 'synthwave'],      // angry / tense
  lowPos:  ['desert', 'emeraldCity', 'lunar', 'royal'],           // content / calm
  lowNeg:  ['deepOcean', 'arctic', 'aurora', 'lunar'],            // sad / reflective
};

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
      PYTHON_EXE, path.join(__dirname, 'essentia-analyze.py'),
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
    this.paletteSize = 4;        // 2 | 3 | 4 — picks between DUOS / TRIADS / TETRADS banks
    this.intensity = 50;         // 0–100 energy slider — scales accent density, drops, strobes
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

  /** Current playback position in ms, or 0 when not playing. */
  getPositionMs() {
    return this._getPositionMs ? this._getPositionMs() : 0;
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
    return this._worker.analyze(source, tgt, { priority, tag });
  }

  /**
   * Tear down the persistent analyzer subprocess. Called on server shutdown.
   * Safe to call multiple times.
   */
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
      proc.stdout.on('data', (d) => { stdout += d; });
      proc.stderr.on('data', (d) => { stderr += d; });

      proc.on('error', (err) => {
        reject(new Error(
          `yt-dlp not found. Install it: pip install yt-dlp  (or download from https://github.com/yt-dlp/yt-dlp)\n${err.message}`
        ));
      });

      proc.on('close', (code) => {
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
  buildTimeline() {
    if (!this.analysis) return;
    const a = this.analysis;
    const events = [];
    const availablePatterns = new Set(this._patterns.map(p => p.id));

    const mood = a.mood || { valence: 0.5, arousal: 0.5, danceability: 0.5 };
    const genreLabel = (a.genre && a.genre.label) || 'unknown';
    const genreStyle = GENRE_STYLES[genreLabel] || null;
    const { palette, name: paletteName } = this._buildPalette(a.key, a.scale, mood, genreStyle);
    this.palette = palette;
    this.paletteName = paletteName;
    const drops = a.drops || [];
    const buildups = a.buildups || [];
    const segments = a.segments || [];

    // Downbeat-aware snapping. If we have downbeats and the meter, align
    // pattern changes to the bar so transitions feel musical.
    const downbeats = a.downbeats || [];
    const meter = a.meter || 4;
    const barSec = downbeats.length >= 2 ? (downbeats[1] - downbeats[0]) : null;
    const snapToDownbeatMs = (tSec) => {
      if (!downbeats.length || !barSec) return Math.round(tSec * 1000);
      let lo = 0, hi = downbeats.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (downbeats[mid] < tSec) lo = mid + 1; else hi = mid;
      }
      // Compare current & previous downbeats for nearest
      const candidates = [];
      if (lo > 0) candidates.push(downbeats[lo - 1]);
      candidates.push(downbeats[lo]);
      if (lo + 1 < downbeats.length) candidates.push(downbeats[lo + 1]);
      let best = candidates[0];
      for (const c of candidates) {
        if (Math.abs(c - tSec) < Math.abs(best - tSec)) best = c;
      }
      // Only snap if within half a bar — otherwise leave it where it was.
      if (Math.abs(best - tSec) <= barSec * 0.5) return Math.round(best * 1000);
      return Math.round(tSec * 1000);
    };

    // ── Segment-level rescue for structurally-flat tracks ────────────────
    // Segment levels (low/mid/high) are computed via RMS percentile *inside
    // the song*, which fails on minimalist arrangements: e.g. "The Box"
    // (Roddy Ricch) reads as 'low' in every segment because the sparse 808s
    // never cross the within-song threshold, even though mood.arousal=0.9
    // and mood.kickiness=1. The result is 3 minutes of slow fade on a
    // genuinely energetic song. When *every* segment shares one level but
    // mood disagrees, promote by one or two tiers so accents, beat-division,
    // and kick flips actually engage. Tracks with real structural contrast
    // (any level variation) are left untouched.
    const segLevelsSet = new Set(segments.map(s => s.level));
    const flatSegments = segLevelsSet.size === 1 && segments.length > 0;
    const onlyLevel = flatSegments ? [...segLevelsSet][0] : null;
    const arousalHi = (mood.arousal || 0) > 0.75;
    const kickHi = (mood.kickiness || 0) > 0.7;
    let levelPromote = 0;
    if (flatSegments && onlyLevel === 'low' && arousalHi && kickHi) levelPromote = 2;
    else if (flatSegments && onlyLevel === 'low' && arousalHi)      levelPromote = 1;
    else if (flatSegments && onlyLevel === 'mid' && arousalHi && kickHi) levelPromote = 1;
    const effectiveLevel = (lvl) => {
      if (!levelPromote) return lvl;
      if (lvl === 'low') return levelPromote >= 2 ? 'high' : 'mid';
      if (lvl === 'mid') return levelPromote >= 1 ? 'high' : lvl;
      return lvl;
    };

    // Cluster label → palette offset, so repeated sections (same label) use
    // the same look on return. Labels come from Laplacian segmentation.
    const labelOffsets = new Map();
    const labelOffset = (label) => {
      if (!label) return null;
      if (!labelOffsets.has(label)) labelOffsets.set(label, labelOffsets.size);
      return labelOffsets.get(label);
    };

    // Initial state — set BPM, make sure blackout is off, clear any stale energy.
    // Explicitly DO NOT touch masterDimmer.
    events.push({
      timeMs: 0,
      action: 'patch',
      data: {
        bpm: Math.round(a.bpm || 120),
        beatDivision: 1,
        running: true,
        masterBlackout: false,
        strobeSpeed: 0,
        strobeFunction: 'standard',
        energyOverride: null,
      },
    });

    // ── Tempo drift handling: only emit periodic BPM patches for tracks
    // ── where the analyzer is *very* confident the tempo is drifting. With
    // ── the octave-anchored tempo curve in the analyzer, stability below
    // ── 0.60 means the track actually changes tempo. Stable tracks skip
    // ── this path entirely — no jitter.
    const tempoStab = a.tempoStability != null ? a.tempoStability : 1;
    const tempoCurve = a.tempoCurve || [];
    if (tempoStab < 0.60 && tempoCurve.length > 2) {
      let lastBpm = Math.round(a.bpm || 120);
      for (const pt of tempoCurve) {
        const bpmVal = Math.round(pt.v);
        if (Math.abs(bpmVal - lastBpm) < 4) continue; // 4 BPM delta floor
        if (bpmVal < 50 || bpmVal > 220) continue;
        events.push({
          timeMs: Math.round(pt.t * 1000),
          action: 'patch',
          data: { bpm: bpmVal },
        });
        lastBpm = bpmVal;
      }
    }

    // ── Style tier (from PANNs genre classifier) ──────────────────────────
    // Each genre maps to a tier via GENRE_STYLES:
    //   'dance'    – edm/dubstep/trance/disco       → full banger
    //   'moderate' – hiphop/pop/funk                → reduced bursts
    //   'rock'     – rock/metal/country/reggae      → light bursts
    //   'calm'     – jazz/classical/folk/ambient/latin → no strobes
    //   'unknown'  – classifier had no answer → fall back to arousal metric
    const tier = genreStyle ? genreStyle.tier : 'unknown';
    const arousalRaw = mood.arousal || 0;

    // ── Energy intensity scaling ──────────────────────────────────────────
    // intensity 0–100 maps to a 0.0–2.0 multiplier. 50 = normal (1.0).
    // Low values suppress strobes/drops/accents; high values unlock them
    // on tracks that would normally be too calm.
    const iFactor = this.intensity / 50; // 0.0 – 2.0

    const isCalm =
      this.intensity === 0 ||
      ((tier === 'calm' ||
        (tier === 'unknown' && arousalRaw < 0.55)) && iFactor < 1.4);
    const isLight =
      !isCalm && iFactor < 0.6 ? true :
      (tier === 'rock' ||
        (tier === 'moderate' && arousalRaw < 0.65)) && iFactor < 1.6;

    // ── White-strobe gate ─────────────────────────────────────────────────
    // The old engine leaned on white-strobe for every bright high-energy
    // accent which dulled its impact. It's now reserved exclusively for the
    // loudest slams: proper drops on dance-tier tracks with high arousal.
    // Segment accents and buildups use color-strobe or the pattern-level
    // strobe channel instead.
    // At intensity ≥ 80 the gate opens for any dance track regardless of arousal.
    const allowWhiteStrobe =
      tier === 'dance' && (arousalRaw >= 0.70 || iFactor >= 1.6);

    // ── Segment-driven pattern + colour + strobe ────────────────────────────
    // Pattern reuse by Laplacian label: two segments with the same label
    // (= same cluster in the recurrence matrix = structurally similar) get
    // the same pattern. This prevents the show from re-picking a different
    // pattern each time a verse or chorus returns.
    const labelToPattern = new Map();
    let segIdx = 0;
    let lastPatternKey = '';

    for (const seg of segments) {
      // Snap boundary to nearest downbeat within half a bar so transitions
      // land on the bar instead of mid-measure.
      const timeMs = snapToDownbeatMs(seg.start);

      // Apply segment-level rescue first (promotes flat-low tracks like The
      // Box up to mid/high based on mood.arousal+kickiness).
      const promotedLevel = effectiveLevel(seg.level);
      // Downgrade "high" to "mid" on calm tracks — percentile normalization
      // makes calm songs look louder than they are, so a quiet-but-relatively-
      // loud section can end up flagged 'high'. Don't launch banger patterns.
      const segLevel = isCalm && promotedLevel === 'high' ? 'mid' : promotedLevel;
      const segForPick = segLevel !== seg.level
        ? Object.assign({}, seg, { level: segLevel })
        : seg;

      let pattern;
      if (seg.label && labelToPattern.has(seg.label)) {
        pattern = labelToPattern.get(seg.label);
      } else {
        pattern = this._pickPattern(segForPick, segIdx, availablePatterns, mood, genreStyle);
        if (seg.label) labelToPattern.set(seg.label, pattern);
      }
      segIdx++;

      // Colour anchor: repeated sections (same Laplacian label) share an
      // offset so verse/chorus/verse lands on the same palette rotation.
      // Unlabeled segments walk via golden-ratio step — sequential `segIdx`
      // would just slide one slot per segment (verse/chorus look almost
      // identical on a 4-colour palette), the golden step jumps to the
      // most-distant unused entry instead.
      const offset = labelOffset(seg.label);
      const base = offset != null
        ? offset * 2
        : this._goldenStep(segIdx, palette.length);
      const colA = palette[base % palette.length];
      const colB = palette[(base + 1) % palette.length];
      const colC = palette.length >= 3 ? palette[(base + 2) % palette.length] : colA;
      const colD = palette.length >= 4 ? palette[(base + 3) % palette.length] : colB;

      // Beat division escalates with segment level × song energy tier. This
      // is the primary lever for "intensity without strobing": a high-tier
      // dance drop runs at 4× BPM while the chorus runs at 2×, so the same
      // pattern reads as much more aggressive at the peak.
      //
      // Triple-meter tracks stay on quarters to keep the bar feel intact.
      const bright = seg.brightness || 0;
      const segEnergy = seg.energy || 0;
      let beatDivision = 1;
      if (!isCalm && meter !== 3) {
        if (segLevel === 'high') {
          if ((tier === 'dance' || iFactor >= 1.4) && (segEnergy > 0.7 || mood.arousal > 0.85 || iFactor >= 1.6)) {
            beatDivision = 4;
          } else if (bright > 0.35 || mood.arousal > 0.75 || tier === 'dance' || iFactor >= 1.2) {
            beatDivision = 2;
          }
        } else if (segLevel === 'mid' && (mood.arousal > 0.75 && tier === 'dance' || iFactor >= 1.4)) {
          beatDivision = 2;
        }
      }
      // At very low intensity, clamp beat division to 1 (no double/quad time).
      if (iFactor < 0.5) beatDivision = 1;

      // Note: strobeSpeed is only honoured by the server when pattern === 'strobe'.
      // For non-strobe patterns we zero it so a previous build-up strobe doesn't
      // bleed into the new segment.
      const strobeSpeed = pattern === 'strobe' ? this._segmentStrobeSpeed(seg) : 0;
      const strobeFunction = this._segmentStrobeFunction(seg);

      const patchKey = `${pattern}|${colA}|${colB}|${colC}|${colD}|${strobeSpeed}|${strobeFunction}|${beatDivision}`;
      if (patchKey === lastPatternKey) continue;
      lastPatternKey = patchKey;

      events.push({
        timeMs,
        action: 'patch',
        data: {
          pattern,
          colorA: colA,
          colorB: colB,
          colorC: colC,
          colorD: colD,
          strobeSpeed,
          strobeFunction,
          beatDivision,
          energyOverride: null,
        },
      });

      // ── In-segment pattern rotation ─────────────────────────────────────
      // The segment loop locks one pattern per segment, which means a long
      // high-energy segment runs ~30s on a single look with only the
      // strobe overlay providing variation. Rotate through 2-3 patterns
      // from the same pool every few bars so the show evolves throughout
      // the segment rather than relying entirely on energy overrides.
      //
      // Skip when:
      //   - calm tracks or low segments (constancy is the point)
      //   - solid pattern (the followUp block below handles its swap)
      //   - the alt picks landed on the same pattern (1-pattern pool)
      //   - the rotation would land inside a drop/buildup window
      //
      // Repeated segments (same Laplacian label) rotate identically by
      // seeding the pick from the label, so verse-1 and verse-2 stay in
      // sync visually.
      if (!isCalm && barSec && pattern !== 'solid') {
        let rotateBars = 0;
        if (segLevel === 'high' && tier === 'dance') rotateBars = 4;
        else if (segLevel === 'high')                rotateBars = 8;
        else if (segLevel === 'mid' && tier === 'dance')    rotateBars = 8;
        else if (segLevel === 'mid' && tier === 'moderate') rotateBars = 16;

        // Intensity tightens or widens the cycle.
        if (rotateBars > 0 && iFactor > 0) {
          rotateBars = Math.max(2, Math.round(rotateBars / iFactor));
        }

        if (rotateBars > 0) {
          const segEndMs = Math.round(seg.end * 1000);
          const rotateIntervalMs = Math.round(rotateBars * barSec * 1000);
          // Only bother rotating when the segment is long enough for at
          // least two cycles — a single mid-segment swap reads as a glitch.
          if (segEndMs - timeMs >= rotateIntervalMs * 2) {
            const labelSeed = seg.label
              ? (seg.label.charCodeAt(0) * 7 + (seg.label.length || 0))
              : segIdx;
            // Walk segIdx offsets with a coprime stride until we collect 2
            // distinct patterns ≠ the main one. Fixed offsets like +47/+91
            // collide when both `% poolLen` land on the same slot (the bug
            // we just hit on a 4-pattern hiphop pool: both → 'runner').
            const altPatterns = [];
            const seenAlts = new Set([pattern]);
            for (let off = 1; off < 24 && altPatterns.length < 2; off++) {
              const cand = this._pickPattern(segForPick, labelSeed + off * 13, availablePatterns, mood, genreStyle);
              if (!seenAlts.has(cand)) {
                altPatterns.push(cand);
                seenAlts.add(cand);
              }
            }
            if (altPatterns.length) {
              let rotIdx = 0;
              let rotMs = timeMs + rotateIntervalMs;
              while (rotMs + 1000 < segEndMs) {
                const inDrop = drops.some(d => Math.abs(d.t * 1000 - rotMs) < 2000);
                const inBld = buildups.some(b => rotMs >= b.start * 1000 - 200 && rotMs <= b.end * 1000 + 200);
                if (!inDrop && !inBld) {
                  events.push({
                    timeMs: rotMs,
                    action: 'patch',
                    data: {
                      pattern: altPatterns[rotIdx % altPatterns.length],
                      colorA: colA,
                      colorB: colB,
                      colorC: colC,
                      colorD: colD,
                      strobeSpeed: 0,
                      strobeFunction,
                      beatDivision,
                      energyOverride: null,
                    },
                  });
                }
                rotIdx++;
                rotMs += rotateIntervalMs;
              }
            }
          }
        }
      }

      // Solid is a static look — cap it at ~4 bars then transition to a
      // movement pattern so the show doesn't stall on a single colour.
      if (pattern === 'solid' && barSec) {
        const solidMaxMs = Math.round(barSec * 4 * 1000);
        const segEndMs = Math.round(seg.end * 1000);
        const followUpMs = timeMs + solidMaxMs;
        if (followUpMs + 500 < segEndMs) {
          // Prefer a slow envelope pattern (fade/wave) over a rhythmic one
          // here — solid sections are quiet by definition, and dropping
          // straight into a chase reads as a jarring shift. fade/wave act
          // like thundr's bar-period fade: continuous breathing motion that
          // doesn't break the section's mood. Only fall back to the level-
          // driven picker when neither envelope pattern is available.
          let followUp = ['fade', 'wave'].find(p => availablePatterns.has(p));
          if (!followUp) {
            followUp = this._pickPattern(
              Object.assign({}, segForPick, { level: segForPick.level === 'low' ? 'low' : 'mid' }),
              segIdx + 100,   // offset so we don't land on the same pattern
              availablePatterns, mood, genreStyle,
            );
          }
          // Only emit if we actually got something different.
          if (followUp !== 'solid') {
            events.push({
              timeMs: followUpMs,
              action: 'patch',
              data: {
                pattern: followUp,
                colorA: colA,
                colorB: colB,
                colorC: colC,
                colorD: colD,
                strobeSpeed: 0,
                strobeFunction,
                beatDivision,
                energyOverride: null,
              },
            });
          }
        }
      }
    }

    // ── Build-ups: multi-phase tension arc ────────────────────────────────
    // Professional technique: buildups should CONTRAST with the drop that
    // follows.  If drops are bright / active / colorful, the buildup
    // narrows down and simplifies — restraint makes the payoff hit harder.
    //
    // Phases (proportional to buildup duration):
    //   tension (0–35%)   — simplify pattern, mono palette, beatDiv 1
    //   rise    (35–75%)  — escalate pattern, 2 colours, beatDiv 2, strobe
    //   peak    (75–92%)  — fast strobe 'break' stutter, beatDiv 4
    //   gap     (last ~150ms) — blackout silence before the drop
    //
    // Short buildups (< 2 s) skip the tension phase → rise + peak only.
    // Skip buildups entirely on calm tracks or very low intensity.
    if (!isCalm && iFactor >= 0.4) {
      for (const build of buildups) {
        const startMs = Math.round(build.start * 1000);
        const endMs = Math.round(build.end * 1000);
        const durMs = Math.max(1000, endMs - startMs);
        const isShort = durMs < 2000;

        // ── Tension phase: restrain to build contrast ──
        if (!isShort) {
          const tensionPool = ['fade', 'wave'].filter(p => availablePatterns.has(p));
          const tensionPat = tensionPool.length ? tensionPool[0] : 'fade';
          events.push({
            timeMs: startMs,
            action: 'patch',
            data: {
              pattern: tensionPat,
              colorA: palette[0],
              colorB: palette[0],   // mono — deliberate narrowing
              colorC: palette[0],
              colorD: palette[0],
              strobeSpeed: 0,
              strobeFunction: 'standard',
              beatDivision: 1,
            },
          });
        }

        // ── Rise phase: escalate pattern + colour + strobe ──
        const riseStart = isShort ? startMs : startMs + Math.round(durMs * 0.35);
        const risePool = [
          'chase-4', 'split-4', 'chase-3', 'split-3',
          'chase', 'runner', 'stack-up',
        ].filter(p => availablePatterns.has(p));
        const risePat = risePool.length ? risePool[0] : 'chase';
        const riseColB = palette.length >= 2 ? palette[1] : palette[0];
        events.push({
          timeMs: riseStart,
          action: 'patch',
          data: {
            pattern: risePat,
            colorA: palette[0],
            colorB: riseColB,
            colorC: palette[0],
            colorD: riseColB,
            strobeSpeed: Math.round(60 * Math.min(1.5, iFactor)),
            strobeFunction: 'ramp-up',
            beatDivision: meter === 3 ? 1 : 2,
          },
        });

        // ── Peak phase: fast strobe, 'break' stutter ──
        const peakStart = isShort
          ? startMs + Math.round(durMs * 0.5)
          : startMs + Math.round(durMs * 0.75);
        events.push({
          timeMs: peakStart,
          action: 'patch',
          data: {
            pattern: 'strobe',
            strobeSpeed: Math.round(220 * Math.min(1.5, iFactor)),
            strobeFunction: 'break',
            beatDivision: meter === 3 ? 1 : 4,
          },
        });

        // ── Gap: blackout silence so the drop contrast is maximal ──
        events.push({
          timeMs: Math.max(startMs, endMs - 150),
          action: 'patch',
          data: { colorA: this._blackoutIdx, strobeSpeed: 0, beatDivision: 1 },
        });
      }
    }

    // ── Drops: varied impact techniques ──────────────────────────────────
    // Three proper-drop variants rotate so consecutive drops feel distinct:
    //   'slam'        — blinder + strobe + explosive movement (biggest)
    //   'color-burst' — no blinder, color-strobe → movement
    //   'punch'       — no strobe overlay, immediate aggressive pattern
    //
    // A solid anchor at the exact drop time is always emitted so every
    // fixture snaps to the same hot colour for the initial impact.
    //
    // White-strobe is reserved for 'slam' on dance-tier tracks with high
    // arousal (see `allowWhiteStrobe`). Everything else uses color-strobe.
    const DROP_VARIANTS = ['slam', 'color-burst', 'punch'];

    for (let i = 0; i < drops.length; i++) {
      const drop = drops[i];
      const tMs = Math.round(drop.t * 1000);

      const baseConf = drop.confidence || 0.5;
      const isDownbeat = drop.snapTo === 'downbeat';
      const confidence = Math.max(0, Math.min(1, baseConf + (isDownbeat ? 0.1 : 0)));

      const breakdown = drop.breakdownScore != null ? drop.breakdownScore : 0.5;
      const sustain   = drop.sustainScore   != null ? drop.sustainScore   : 0.5;
      const kind = (breakdown >= 0.4 && sustain >= 0.6) ? 'proper' : 'hype';

      if (isCalm) continue;
      if (iFactor < 0.6 && kind !== 'proper') continue;
      if (isLight && kind !== 'proper') continue;

      // Drop colours rotate through the locked palette per drop index. Use
      // the golden-ratio stepper so consecutive drops on small palettes
      // (2-3 colours) don't fall into a tight ABAB loop — this hits every
      // palette entry before repeating with maximum spacing.
      const palLen = palette.length;
      const dropSlot = palLen ? this._goldenStep(i, palLen) : 0;
      const dropColorA = palette[dropSlot] || 0;
      const oppositeOffset = Math.max(1, Math.floor(palLen / 2));
      const dropColorB = palLen >= 2
        ? palette[(dropSlot + oppositeOffset) % palLen]
        : dropColorA;
      const dropColorC = palLen >= 3 ? palette[(dropSlot + 2) % palLen] : dropColorA;
      const dropColorD = palLen >= 4 ? palette[(dropSlot + 3) % palLen] : dropColorB;

      // ── Solid anchor at the exact drop moment ──
      events.push({
        timeMs: tMs,
        action: 'patch',
        data: {
          pattern: 'solid',
          colorA: dropColorA,
          colorB: dropColorB,
          colorC: dropColorC,
          colorD: dropColorD,
          strobeSpeed: 0,
          beatDivision: meter === 3 ? 1 : 4,
          strobeFunction: 'standard',
          energyOverride: null,
        },
      });

      if (kind === 'proper') {
        // Pick variant: highest-confidence first drop → slam; others rotate.
        const variant = (confidence >= 0.75 && i === 0)
          ? 'slam'
          : DROP_VARIANTS[i % DROP_VARIANTS.length];

        // Movement-pattern pool shared by slam and color-burst.
        const dropMovePool = tier === 'dance'
          ? ['hit', 'runner', 'pairs-4', 'chase-4', 'split-4', 'alt-quarters', 'chase-3', 'split-3', 'alt-thirds', 'pairs', 'random-flash', 'alt-halves', 'stack-up']
          : ['pairs-4', 'chase-4', 'split-4', 'chase-3', 'split-3', 'runner', 'pairs', 'chase', 'stack-up'];
        const dropMoveFiltered = dropMovePool.filter(p => availablePatterns.has(p));
        const movePattern = dropMoveFiltered.length
          ? dropMoveFiltered[i % dropMoveFiltered.length]
          : 'chase';

        if (variant === 'slam') {
          // ── Slam: blinder → strobe → explosive movement ──
          // Full treatment reserved for the biggest drops.
          const useBlinder = (tier === 'dance' || iFactor >= 1.6) && confidence >= 0.55 && iFactor >= 0.6;
          const blinderMs = useBlinder ? Math.round((300 + confidence * 250) * Math.min(1.5, iFactor)) : 0;
          if (useBlinder) {
            events.push({
              timeMs: tMs,
              action: 'energy',
              data: { id: 'blinder', durationMs: blinderMs },
            });
          }

          const afterBlinderMs = tMs + blinderMs + (useBlinder ? 10 : 1);
          const colorStrobeMs = Math.round((500 + confidence * 300) * Math.min(1.5, iFactor));

          if (useBlinder) {
            events.push({
              timeMs: afterBlinderMs - 1,
              action: 'patch',
              data: { colorA: dropColorA, colorB: dropColorB, colorC: dropColorC, colorD: dropColorD },
            });
          }

          const useWhiteStrobe =
            allowWhiteStrobe && confidence >= 0.65 && breakdown >= 0.6;
          events.push({
            timeMs: afterBlinderMs,
            action: 'energy',
            data: {
              id: useWhiteStrobe ? 'white-strobe' : 'color-strobe',
              durationMs: colorStrobeMs,
            },
          });

          events.push({
            timeMs: afterBlinderMs + colorStrobeMs + 20,
            action: 'patch',
            data: {
              pattern: movePattern,
              colorA: dropColorA,
              colorB: dropColorB,
              colorC: dropColorC,
              colorD: dropColorD,
              strobeSpeed: 0,
              strobeFunction: 'ramp-down',
              beatDivision: meter === 3 ? 1 : (tier === 'dance' ? 4 : 2),
              energyOverride: null,
            },
          });

        } else if (variant === 'color-burst') {
          // ── Color-burst: no blinder, immediate color-strobe → movement ──
          // Lighter than slam — lets the palette colour carry the impact.
          const colorStrobeMs = Math.round((600 + confidence * 400) * Math.min(1.5, iFactor));
          events.push({
            timeMs: tMs + 1,
            action: 'energy',
            data: { id: 'color-strobe', durationMs: colorStrobeMs },
          });

          events.push({
            timeMs: tMs + colorStrobeMs + 20,
            action: 'patch',
            data: {
              pattern: movePattern,
              colorA: dropColorA,
              colorB: dropColorB,
              colorC: dropColorC,
              colorD: dropColorD,
              strobeSpeed: 0,
              strobeFunction: 'standard',
              beatDivision: meter === 3 ? 1 : (tier === 'dance' ? 4 : 2),
              energyOverride: null,
            },
          });

        } else {
          // ── Punch: no strobe overlay, immediate aggressive pattern ──
          // Impact comes from pattern + beat division, not energy effects.
          // The solid anchor reads for ~100 ms, then snaps to movement.
          const punchPool = ['hit', 'alt-quarters', 'split-4', 'chase-4', 'alt-thirds', 'split-3', 'alt-halves', 'random-flash', 'stack-up']
            .filter(p => availablePatterns.has(p));
          const punchPattern = punchPool.length
            ? punchPool[i % punchPool.length]
            : 'chase';

          events.push({
            timeMs: tMs + 100,
            action: 'patch',
            data: {
              pattern: punchPattern,
              colorA: dropColorA,
              colorB: dropColorB,
              colorC: dropColorC,
              colorD: dropColorD,
              strobeSpeed: 0,
              strobeFunction: 'standard',
              beatDivision: meter === 3 ? 1 : 4,
              energyOverride: null,
            },
          });
        }

      } else {
        // ── Hype moment: color-strobe + brief aggressive pattern push ──
        // More impactful than the old strobe-only overlay — the pattern
        // change makes the hype moment feel like a real shift, not just
        // a flash on top of the current segment.
        const colorStrobeMs = Math.round((400 + confidence * 300) * Math.min(1.5, iFactor));
        events.push({
          timeMs: tMs + 1,
          action: 'energy',
          data: { id: 'color-strobe', durationMs: colorStrobeMs },
        });

        const hypePool = ['hit', 'alt-quarters', 'pairs-4', 'chase-4', 'alt-thirds', 'chase-3', 'alt-halves', 'pairs']
          .filter(p => availablePatterns.has(p));
        if (hypePool.length) {
          events.push({
            timeMs: tMs + 1,
            action: 'patch',
            data: {
              pattern: hypePool[i % hypePool.length],
              colorA: dropColorA,
              colorB: dropColorB,
              colorC: dropColorC,
              colorD: dropColorD,
              beatDivision: meter === 3 ? 1 : 2,
            },
          });
        }
      }
    }


    // ── Bar-level accents in high-energy sections ─────────────────────────
    // Prefer the downbeat array when we have one (confident meter) — that
    // guarantees the accent lands on beat 1 of every bar. Fall back to the
    // old beat-strength heuristic when downbeats are missing or the detector
    // wasn't confident.
    //
    // Skip both paths entirely on calm tracks — they never want strobes.
    // Use the downbeat-throttled path whenever we have downbeats at all and
    // the confidence is plausible (≥ 0.10). The previous 0.25 threshold was
    // too strict — tracks like Superbus (dbConf 0.25) and Tate McRae (0.18)
    // were falling into the fallback strong-beat loop, which has none of the
    // arousal-based throttling and fires on every strong beat in high
    // segments → 30+ accents/min.
    const hasConfidentDownbeats =
      downbeats.length > 0 && (a.downbeatConfidence == null || a.downbeatConfidence >= 0.10);
    const inDropWindow = (ms) => drops.some(d => Math.abs(d.t * 1000 - ms) < 1500);
    const inBuildup = (ms) =>
      buildups.some(b => ms >= b.start * 1000 - 200 && ms <= b.end * 1000 + 200);

    // Accent density depends on the PANNs style tier first, falling back to
    // arousal-based tiers when the classifier isn't available. This is the
    // primary lever for "how much rig activity does this song deserve".
    //
    // Density was roughly halved relative to the old engine — the old rig
    // leaned too hard on energy bursts and they lost their impact. Drops
    // and buildups still carry the big moments; segment accents are now
    // garnish, not the main event.
    //
    // dance:    high every 4 bars    | mid every 16 bars
    // moderate: high every 8 bars    | mid every 32 bars
    // rock:     high every 16 bars   | no mid accents
    // calm:     never (handled above)
    // unknown:  arousal-based tiers
    const arousal = mood.arousal || 0;
    // Accent throttle rates are scaled by intensity: higher intensity
    // tightens the gap (more frequent accents), lower widens it.
    // throttleScale: iFactor 0→4.0 (very sparse), 1.0→1.0 (normal), 2.0→0.5 (dense).
    const throttleScale = iFactor > 0 ? 1 / iFactor : 4;
    let highThrottle, midEligible, midThrottle;
    if (tier === 'dance') {
      highThrottle = Math.max(1, Math.round(4 * throttleScale));
      midEligible  = iFactor >= 0.3;
      midThrottle  = Math.max(2, Math.round(16 * throttleScale));
    } else if (tier === 'moderate') {
      highThrottle = Math.max(1, Math.round(8 * throttleScale));
      midEligible  = iFactor >= 0.5;
      midThrottle  = Math.max(4, Math.round(32 * throttleScale));
    } else if (tier === 'rock') {
      highThrottle = Math.max(2, Math.round(16 * throttleScale));
      midEligible  = iFactor >= 1.4;
      midThrottle  = Math.max(4, Math.round(32 * throttleScale));
    } else {
      // 'unknown' – arousal tiers, also relaxed from the old engine.
      highThrottle =
        arousal >= 0.92 ? Math.max(1, Math.round(2 * throttleScale)) :
        arousal >= 0.78 ? Math.max(1, Math.round(8 * throttleScale)) :
        Math.max(2, Math.round(16 * throttleScale));
      midEligible = arousal >= 0.70 || iFactor >= 1.4;
      midThrottle =
        arousal >= 0.92 ? Math.max(2, Math.round(8 * throttleScale)) :
        arousal >= 0.78 ? Math.max(4, Math.round(16 * throttleScale)) :
        Math.max(8, Math.round(32 * throttleScale));
    }

    if (isCalm) {
      // No accents on calm tracks.
    } else if (hasConfidentDownbeats && segments.length) {
      for (let dbIdx = 0; dbIdx < downbeats.length; dbIdx++) {
        const dbt = downbeats[dbIdx];
        const seg = segments.find(s => dbt >= s.start && dbt < s.end);
        if (!seg) continue;
        const lvl = effectiveLevel(seg.level);
        let throttle;
        if (lvl === 'high') throttle = highThrottle;
        else if (lvl === 'mid' && midEligible) throttle = midThrottle;
        else continue;
        if (dbIdx % throttle !== 0) continue;

        const dbMs = Math.round(dbt * 1000);
        if (inDropWindow(dbMs)) continue;
        if (inBuildup(dbMs)) continue;

        // Segment accents now always use color-strobe — white-strobe is
        // reserved for drops. Keeping the song inside its coherent palette
        // makes the whole show read more polished.
        //
        // 300ms minimum so the LED fixtures actually have time to react:
        // at 40 Hz DMX that's ~12 frames, plus the fixture's own strobe
        // channel firing 2-3 pulses. The old 110ms value was barely long
        // enough for a single half-open flash.
        events.push({
          timeMs: dbMs,
          action: 'energy',
          data: { id: 'color-strobe', durationMs: 300 },
        });
      }
    } else if (a.beats && a.beatStrengths && segments.length) {
      // Fallback when there are no usable downbeats: accent on strong beats,
      // but apply the same arousal-based throttling as the downbeat path so
      // the fallback can't spam accents on tracks with low downbeat
      // confidence. Gaps ~2×/4×/8× the old values to match the halved
      // segment-accent density above.
      const minGapMs = Math.round((
        arousal >= 0.92 ? 2400 :
        arousal >= 0.78 ? 9600 :
        19200) * throttleScale);
      const strongThreshold = 0.6;
      let lastAccentMs = -9999;
      for (let i = 0; i < a.beats.length; i++) {
        // Sub-400ms beat coalescing (borrowed from thundr): when the analyzer
        // reports beats faster than the rig can physically resolve, skip every
        // other one. Below 400ms we're past DMX/LED response time and human
        // strobe perception threshold — firing on every beat just smears.
        if (i + 1 < a.beats.length && (a.beats[i + 1] - a.beats[i]) < 0.4) {
          i++; // consume the partner beat too
        }
        const strength = a.beatStrengths[i] || 0;
        if (strength < strongThreshold) continue;
        const beatT = a.beats[i];
        const beatMs = Math.round(beatT * 1000);
        if (beatMs - lastAccentMs < minGapMs) continue;
        if (inDropWindow(beatMs)) continue;
        if (inBuildup(beatMs)) continue;
        const seg = segments.find(s => beatT >= s.start && beatT < s.end);
        if (!seg) continue;
        const lvl = effectiveLevel(seg.level);
        const allowed = lvl === 'high' || (lvl === 'mid' && midEligible);
        if (!allowed) continue;
        // Always color-strobe here; see note above on the downbeat path.
        // 300ms minimum so the fixture actually reacts.
        events.push({
          timeMs: beatMs,
          action: 'energy',
          data: { id: 'color-strobe', durationMs: 300 },
        });
        lastAccentMs = beatMs;
      }
    }

    // ── Kick onsets on mid-energy segments → subtle colour flips ───────────
    // Minimum gap tightens on calm tracks to avoid a metronome of colour
    // changes on atmospheric songs.
    //
    // Palette inertia (inspired by CanYuzbey/music-reactive-lighting): dance-
    // tier tracks already express groove through beatDivision 2/4, so piling
    // kick-onset colour flips on top just makes the palette feel twitchy —
    // skip them entirely on dance. Also extend the post-drop lockout window
    // to 2.5s so the hot drop colour stays anchored through the afterglow.
    if (a.kickOnsets && segments.length && tier !== 'dance') {
      const flipGapMs = isCalm ? 4500 : 2000;
      let lastFlip = -9999;
      let flipIdx = 0;
      for (const bt of a.kickOnsets) {
        const btMs = Math.round(bt * 1000);
        if (btMs - lastFlip < flipGapMs) continue;
        const seg = segments.find(s => bt >= s.start && bt < s.end);
        if (!seg) continue;
        // Allow flips on mid OR effective-mid (promoted low on energetic
        // structurally-flat tracks). Skip 'high' segments — those already
        // get full segment-level patterns and beat-division 2/4, more
        // movement on top would just smear.
        const lvl = effectiveLevel(seg.level);
        if (lvl !== 'mid') continue;
        // Asymmetric drop window: ±1.5s before, +2.5s after — post-drop
        // afterglow should keep the hot colour locked.
        if (drops.some(d => {
          const dt = btMs - d.t * 1000;
          return dt >= -1500 && dt <= 2500;
        })) continue;
        if (buildups.some(b => btMs >= b.start * 1000 && btMs <= b.end * 1000)) continue;
        // Golden-ratio step through the locked palette so consecutive flips
        // never reuse the same colour and the rotation hits every entry
        // before repeating. Beats `Math.floor(bt) % len` which can repeat.
        events.push({
          timeMs: btMs,
          action: 'patch',
          data: { colorA: palette[this._goldenStep(flipIdx, palette.length)] },
        });
        flipIdx++;
        lastFlip = btMs;
      }
    }

    // Sort by time, but at the same timestamp:
    //  - patches fire *before* energy bursts (so a segment-boundary patch's
    //    `energyOverride: null` doesn't cancel a burst starting on the same beat)
    //  - two patches or two energy events preserve insertion order (stable),
    //    which lets drop-loop patches override segment-loop patches.
    events.forEach((e, i) => { e._idx = i; });
    events.sort((x, y) => {
      if (x.timeMs !== y.timeMs) return x.timeMs - y.timeMs;
      if (x.action !== y.action) return x.action === 'patch' ? -1 : 1;
      return x._idx - y._idx;
    });
    events.forEach(e => { delete e._idx; });

    // ── Global energy-burst debounce ──────────────────────────────────────
    // Different event sources (drops, buildups, downbeat accents, beat-
    // strength accents) each have their own throttling but don't coordinate
    // with each other. When a drop lands one beat after a downbeat accent
    // the two bursts stack and the first one is immediately clobbered.
    //
    // Dynamic debounce: the next burst cannot start until the previous
    // burst has fully played out plus a 60ms safety gap. This guarantees
    // every emitted burst gets its full declared duration on the rig —
    // critical now that minimum burst length is 300ms, because a second
    // burst starting at 150ms would clip the first one in half before the
    // LEDs finished responding.
    //
    // Priority order (white-strobe > blinder > color-strobe) breaks ties
    // when a higher-priority burst collides with a lower-priority one: the
    // higher-priority one wins and replaces the earlier event.
    //
    // Inspired by "Strobe Debouncing (Blanking)" in CanYuzbey/music-
    // reactive-lighting — keeps bursts mapped to the groove, not stacked
    // on top of each other.
    const ENERGY_PRIORITY = { 'white-strobe': 3, 'blinder': 2, 'color-strobe': 1 };
    const DEBOUNCE_SAFETY_MS = 60;
    const filtered = [];
    let lastEnergy = null;
    let lastEnergyEnd = -Infinity;
    for (const ev of events) {
      if (ev.action !== 'energy') { filtered.push(ev); continue; }
      const id = ev.data && ev.data.id;
      const prio = ENERGY_PRIORITY[id] != null ? ENERGY_PRIORITY[id] : 0;
      const dur = (ev.data && ev.data.durationMs) || 200;
      if (lastEnergy && ev.timeMs < lastEnergyEnd + DEBOUNCE_SAFETY_MS) {
        // Too close — the previous burst hasn't finished yet. Keep whichever
        // has higher priority.
        const lastPrio = ENERGY_PRIORITY[lastEnergy.data.id] != null
          ? ENERGY_PRIORITY[lastEnergy.data.id] : 0;
        if (prio > lastPrio) {
          // Replace the previous burst in the filtered list with this one.
          for (let i = filtered.length - 1; i >= 0; i--) {
            if (filtered[i] === lastEnergy) { filtered.splice(i, 1); break; }
          }
          filtered.push(ev);
          lastEnergy = ev;
          lastEnergyEnd = ev.timeMs + dur;
        }
        // else: drop this lower/equal-priority event entirely
        continue;
      }
      filtered.push(ev);
      lastEnergy = ev;
      lastEnergyEnd = ev.timeMs + dur;
    }

    this.timeline = filtered;
  }

  // ── 3. Playback ─────────────────────────────────────────────────────────────

  start(getPositionMs) {
    if (!this.timeline.length) return;
    this._getPositionMs = getPositionMs;
    this.running = true;
    this._lastEventIdx = -1;
    this._activeEnergyClearAt = 0;
    this._status = 'playing';
    this._tick();
    this._loopTimer = setInterval(() => this._tick(), 20);
  }

  stop() {
    this.running = false;
    this._status = this.analysis ? 'ready' : 'idle';
    if (this._loopTimer) { clearInterval(this._loopTimer); this._loopTimer = null; }
    // Clear any lingering energy override so we don't leave the rig stuck
    this._applyPatch({ energyOverride: null });
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
    const posMs = this._getPositionMs();

    for (let i = this._lastEventIdx + 1; i < this.timeline.length; i++) {
      const ev = this.timeline[i];
      if (ev.timeMs > posMs) break;

      this._fireEvent(ev);
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
          // Only clear if this burst is still the active one (avoids races)
          if (this.running && Date.now() >= this._activeEnergyClearAt - 5) {
            this._applyPatch({ energyOverride: null });
          }
        }, duration);
        break;
      }
    }
  }

  // ── Mapping helpers ─────────────────────────────────────────────────────────

  _buildPalette(key, scale, mood = { valence: 0.5, arousal: 0.5 }, genreStyle = null) {
    // One song → one coherent palette from the bank matching this.paletteSize
    // (2 → DUOS, 3 → TRIADS, 4 → TETRADS). Pick list comes from the genre
    // style; which entry we land on is keyed on the musical key so songs in
    // the same genre diverge.
    //
    // Returns { palette: [idx, …], name: 'cyber' } so the UI can label the
    // active palette alongside the swatch row.
    const keys = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    const keyIdx = Math.max(0, keys.indexOf(key));

    let tetradNames;
    if (genreStyle && genreStyle.tetrads && genreStyle.tetrads.length) {
      tetradNames = genreStyle.tetrads;
    } else {
      // Russell's circumplex fallback — pick a quadrant from
      // (arousal × valence) rather than valence alone.
      const v = mood.valence != null ? mood.valence : (scale === 'major' ? 0.65 : 0.35);
      const ar = mood.arousal != null ? mood.arousal : 0.5;
      if (ar >= 0.5 && v >= 0.5)      tetradNames = CIRCUMPLEX_TETRADS.highPos;
      else if (ar >= 0.5 && v < 0.5)  tetradNames = CIRCUMPLEX_TETRADS.highNeg;
      else if (ar < 0.5 && v >= 0.5)  tetradNames = CIRCUMPLEX_TETRADS.lowPos;
      else                             tetradNames = CIRCUMPLEX_TETRADS.lowNeg;
    }

    // Sub-pick by key index. Same genre in two different keys gets a
    // different look, but any single song is locked in for its full duration.
    const chosen = tetradNames[keyIdx % tetradNames.length];
    const bank = paletteBankForSize(this.paletteSize);
    const raw = bank[chosen] || bank.cyber;
    const name = bank[chosen] ? chosen : 'cyber';

    // Validate against _colorPresets length so we never hand out an index the
    // server will clamp or silently remap.
    const maxIdx = Math.max(0, (this._colorPresets?.length || 17) - 1);
    let palette = raw.map(i => Math.min(maxIdx, Math.max(0, i)));

    // Minor rotation by scale so major/minor variants of the same key feel
    // slightly different without breaking the palette coherence. Pairs are
    // just swapped at 2-colour, rotated at 3, and cross-paired at 4.
    if (scale === 'minor') {
      if (palette.length === 4) {
        palette = [palette[1], palette[0], palette[3], palette[2]];
      } else if (palette.length === 3) {
        palette = [palette[1], palette[2], palette[0]];
      } else if (palette.length === 2) {
        palette = [palette[1], palette[0]];
      }
    }

    return { palette, name };
  }

  /**
   * Swap the palette size live. Rebuilds the timeline from the current
   * analysis so the new palette takes effect on the next tick without
   * re-analysing the audio. No-op when paletteSize is already n.
   *
   * Allowed values: 2 | 3 | 4. Anything else is clamped into that range.
   */
  setPaletteSize(n) {
    const size = n === 2 ? 2 : n === 3 ? 3 : 4;
    if (size === this.paletteSize) return;
    this.paletteSize = size;
    if (this.analysis) {
      this.buildTimeline();
      // Advance cursor to current position so we don't re-fire the entire
      // past of the timeline (which would machine-gun energy bursts). The
      // next tick picks up from the event immediately after posMs.
      if (this.running && this._getPositionMs) {
        const posMs = this._getPositionMs();
        let last = -1;
        for (let i = 0; i < this.timeline.length; i++) {
          if (this.timeline[i].timeMs > posMs) break;
          last = i;
        }
        this._lastEventIdx = last;
      } else {
        this._lastEventIdx = -1;
      }
    }
  }

  /**
   * Set the energy intensity (0–100). Rebuilds the timeline so accent density,
   * drop effects, and beat-division scaling adjust on the fly.
   */
  setIntensity(n) {
    const val = Math.max(0, Math.min(100, Math.round(Number(n) || 50)));
    if (val === this.intensity) return;
    this.intensity = val;
    if (this.analysis) {
      this.buildTimeline();
      if (this.running && this._getPositionMs) {
        const posMs = this._getPositionMs();
        let last = -1;
        for (let i = 0; i < this.timeline.length; i++) {
          if (this.timeline[i].timeMs > posMs) break;
          last = i;
        }
        this._lastEventIdx = last;
      } else {
        this._lastEventIdx = -1;
      }
    }
  }

  _pickPattern(segment, segIdx, available, mood = { arousal: 0.5, danceability: 0.5 }, genreStyle = null) {
    const brightness = segment.brightness || 0;
    const bass = segment.bass || 0;
    const arousal = mood.arousal || 0;
    const dance = mood.danceability != null ? mood.danceability : 0.5;
    const palLen = Array.isArray(this.palette) ? this.palette.length : this.paletteSize;

    // Danceability biases the pool: rhythm-locked patterns when the pulse is
    // steady, flowy/ambient patterns when it isn't.
    //
    // NOTE: 'rainbow' and 'color-cycle' are intentionally absent from every
    // auto-show pool — those two patterns generate colours via hsvToRgb in
    // the server and completely ignore the colA/colB channel, which would
    // break the song's locked 4-colour tetrad. They remain available for
    // manual selection from the UI.
    const RHYTHMIC = new Set(['chase', 'runner', 'pairs', 'ping-pong', 'split',
                              'stack-up', 'random-flash',
                              'hit', 'alt-halves']);
    const FLOWY    = new Set(['solid', 'fade', 'wave', 'sparkle', 'twinkle']);

    const multi3 = ['split-3', 'chase-3', 'alt-thirds'];
    const multi4 = ['split-4', 'chase-4', 'alt-quarters', 'pairs-4'];
    const has3 = palLen >= 3;
    const has4 = palLen >= 4;
    const withMulti = (basePool) => {
      const extras = [];
      if (has3) extras.push(...multi3);
      if (has4) extras.push(...multi4);
      return [...extras, ...basePool];
    };

    // Genre bias: when a style is known, intersect the level-driven pool
    // with the style's pattern list so (e.g.) metal tracks favour
    // stack-up / split / random-flash and jazz favours fade / twinkle /
    // wave. Falls back to the raw pool if the intersection is empty.
    const genrePatterns = genreStyle && genreStyle.patterns
      ? new Set(genreStyle.patterns)
      : null;

    // Rotate through a pool using segIdx so consecutive segments of the same
    // energy level don't keep landing on the same pattern. Unavailable
    // patterns are filtered out first; 'chase' is the universal fallback.
    //
    // Danceability post-filter: on very danceable tracks (≥0.7) drop flowy
    // picks; on very low danceability (≤0.35) drop rhythmic picks. Between
    // the two, keep the full pool so mid-danceability tracks vary more.
    const pickFrom = (pool) => {
      let filtered = pool.filter(p => available.has(p));
      if (genrePatterns) {
        const biased = filtered.filter(p => genrePatterns.has(p));
        if (biased.length) filtered = biased;
      }
      if (dance >= 0.7) {
        const rhythm = filtered.filter(p => !FLOWY.has(p));
        if (rhythm.length) filtered = rhythm;
      } else if (dance <= 0.35) {
        const flowy = filtered.filter(p => !RHYTHMIC.has(p));
        if (flowy.length) filtered = flowy;
      }
      if (!filtered.length) return available.has('chase') ? 'chase' : [...available][0];
      return filtered[segIdx % filtered.length];
    };

    // High arousal lifts low/mid segments into the next pool.
    const effLevel =
      arousal > 0.8 && segment.level === 'mid' ? 'high' :
      arousal > 0.8 && segment.level === 'low' ? 'mid'  : segment.level;

    switch (effLevel) {
      case 'low':
        // Calm: slow sustained patterns, light movement if there's any bass.
        if (bass < 0.2) return pickFrom(['solid', 'fade', 'wave']);
        return pickFrom(withMulti(['solid', 'fade', 'wave', 'twinkle']));

      case 'mid':
        // Movement: bigger pool, picked by brightness/bass character.
        if (brightness > 0.45) return pickFrom(withMulti(['ping-pong', 'wave', 'runner', 'chase', 'sparkle']));
        if (bass > 0.4)        return pickFrom(withMulti(['alt-halves', 'split', 'pairs', 'runner', 'stack-up', 'chase']));
        return pickFrom(withMulti(['chase', 'ping-pong', 'pairs', 'runner', 'wave']));

      case 'high': {
        // Intensity: sparkly/flashy patterns on bright sections, hammering
        // colour movement on bass-heavy ones.
        //
        // `hit` is the loudest pattern in the bank (all fixtures punch in
        // unison on every beat). User feedback: it only reads right on
        // *very* high-energy moments, otherwise it feels like the show is
        // yelling at the audience. Gate it behind a veryHigh check so mid-
        // tempo "technically high" segments get the more flowing patterns
        // instead. Drops still get `hit` unconditionally — that's handled
        // in the drop-movement pool below, not here.
        const segEnergy = segment.energy || 0;
        const veryHigh = arousal > 0.80 || segEnergy > 0.72;
        const withHit = (arr) => veryHigh ? arr : arr.filter(p => p !== 'hit');
        if (brightness > 0.55) return pickFrom(withMulti(withHit(['sparkle', 'twinkle', 'random-flash', 'hit'])));
        if (bass > 0.5)        return pickFrom(withMulti(withHit(['hit', 'alt-halves', 'pairs', 'stack-up', 'random-flash', 'split'])));
        return pickFrom(withMulti(withHit(['chase', 'runner', 'hit', 'pairs', 'stack-up'])));
      }

      default:
        return pickFrom(['chase']);
    }
  }

  // Golden-ratio palette stepper. Returns indices that walk the palette with
  // maximum spacing — for len=4 the sequence is 0,2,1,3 (every entry, never
  // adjacent); len=3 → 0,2,1; len=2 → 0,1 alternating. Used wherever we need
  // "next colour from the locked palette" without consecutive repeats.
  // Borrowed from thundr (guymargalit/thundr), which uses the same conjugate
  // 0.618 to step hue on every beat.
  _goldenStep(idx, len) {
    if (!len) return 0;
    // For 2-colour palettes plain alternation is strictly better — the
    // golden step rounds into back-to-back zeros at i=2,3 which beats the
    // whole "no consecutive repeats" property we wanted in the first place.
    if (len === 2) return idx & 1;
    return Math.round(idx * len * 0.618033988749895) % len;
  }

  _segmentStrobeSpeed(seg) {
    if (seg.level !== 'high') return 0;
    const energy = seg.energy || 0;
    const bright = seg.brightness || 0;
    // Only introduce strobe on bright, hot sections — otherwise it's a blur
    if (bright < 0.3 && energy < 0.65) return 0;
    return Math.round(Math.min(255, 90 + energy * 140 + bright * 30));
  }

  _segmentStrobeFunction(seg) {
    // Picks one of six strobe functions that ship with the fixture based on
    // segment character. This gives each segment its own *texture* instead of
    // relying on the binary standard/random choice the old engine used.
    //
    //   break          – stuttering; perfect for buildup tails and "wait for it"
    //   random         – chaotic; bright/loud high sections (already existed)
    //   ramp-up        – accelerating; rising bass sections
    //   ramp-down      – decelerating; sections coming down from a peak
    //   ramp-down-rnd  – messy deceleration; gnarly distorted high sections
    //   standard       – neutral; anything else
    const bright = seg.brightness || 0;
    const bass = seg.bass || 0;
    const level = seg.level;
    const energy = seg.energy || 0;

    if (level === 'high') {
      // Gnarly / distorted high sections (high energy, high bass, not bright)
      // → ramp-down-rnd — reads as chaos.
      if (bright < 0.35 && bass > 0.55 && energy > 0.7) return 'ramp-down-rnd';
      if (bright > 0.55) return 'random';
      if (bass > 0.55) return 'ramp-up';
      return 'standard';
    }

    if (level === 'mid') {
      if (bass > 0.5) return 'ramp-up';
      if (bright > 0.5) return 'standard';
      return 'ramp-down';
    }

    return 'standard';
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
      paletteSize: this.paletteSize,
      intensity: this.intensity,
      analysis: this.analysis ? {
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
module.exports.PYTHON_EXE = PYTHON_EXE;
