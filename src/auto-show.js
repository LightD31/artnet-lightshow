'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

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
    this.analysis = null;
    this.timeline = [];
    this.running = false;
    this.track = null;
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
   * State-free runner: spawn the Essentia/librosa bridge and return the parsed
   * analysis JSON. Does not touch instance state (so it's safe to call from
   * prefetch while a show is already running).
   */
  _runAnalyzer(source) {
    return new Promise((resolve, reject) => {
      const script = path.join(__dirname, 'essentia-analyze.py');
      const proc = spawn('python', [script, source], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', (d) => { stdout += d; });
      proc.stderr.on('data', (d) => { stderr += d; });

      proc.on('error', (err) => {
        reject(new Error(`Essentia bridge failed to start: ${err.message}. Install librosa: pip install librosa`));
      });

      proc.on('close', (code) => {
        if (code !== 0) {
          return reject(new Error(`Analyzer exited with code ${code}: ${stderr || stdout}`));
        }
        try {
          const result = JSON.parse(stdout);
          if (result.error) return reject(new Error(result.error));
          resolve(result);
        } catch (e) {
          reject(new Error(`Failed to parse analyzer output: ${e.message}`));
        }
      });
    });
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
  async _fetchAnalysis(query, targetDurationSec, cacheKey, meta) {
    let audioPath = null;
    try {
      audioPath = await this._downloadAudio(query, targetDurationSec);
      const analysis = await this._runAnalyzer(audioPath);
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
   * callers share one download/analyze job.
   */
  _fetchShared(query, targetDurationSec, cacheKey, meta) {
    if (cacheKey && this._inFlight.has(cacheKey)) {
      return this._inFlight.get(cacheKey);
    }
    const promise = this._fetchAnalysis(query, targetDurationSec, cacheKey, meta);
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
  async prefetch(query, targetDurationSec, cacheKey, meta = {}) {
    if (!cacheKey || !this._cache) return { skipped: true, reason: 'no-cache' };
    if (this._cache.get(cacheKey)) return { skipped: true, reason: 'already-cached' };
    if (this._inFlight.has(cacheKey)) return { skipped: true, reason: 'in-flight' };

    try {
      console.log(`[auto-show] prefetching: ${query}`);
      await this._fetchShared(query, targetDurationSec, cacheKey, meta);
      console.log(`[auto-show] prefetched and cached: ${cacheKey}`);
      return { skipped: false };
    } catch (err) {
      console.warn(`[auto-show] prefetch failed for ${cacheKey}: ${err.message}`);
      return { skipped: false, error: err.message };
    }
  }

  async downloadAndAnalyze(query, targetDurationSec = null, cacheKey = null) {
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
        { track: this.track },
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
   * Download audio via yt-dlp. When `targetDurationSec` is provided, we pull
   * several search candidates and ask yt-dlp to skip any whose duration doesn't
   * match within ±5s — this avoids grabbing extended remixes, live versions,
   * or music videos with long intros/outros when we know the Spotify length.
   * Falls back to an unfiltered search if no candidate passes the filter.
   */
  async _downloadAudio(query, targetDurationSec = null) {
    const hasTarget = Number.isFinite(targetDurationSec) && targetDurationSec > 0;
    const isUrl = /^https?:\/\//.test(query);

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

    const palette = this._buildPalette(a.key, a.scale);
    const drops = a.drops || [];
    const buildups = a.buildups || [];

    // Keep a lookup of segments → bass dominance / brightness
    const segments = a.segments || [];

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

    // ── Segment-driven pattern + colour + strobe ────────────────────────────
    let colorIdx = 0;
    let segIdx = 0;
    let lastPatternKey = '';

    for (const seg of segments) {
      const timeMs = Math.round(seg.start * 1000);
      const pattern = this._pickPattern(seg, segIdx++, availablePatterns);
      const colA = palette[colorIdx % palette.length];
      const colB = palette[(colorIdx + 1) % palette.length];

      // Beat division: quarter notes normally, eighths on bright high-energy parts
      const beatDivision = seg.level === 'high' && (seg.spectralCentroid || 0) > 0.35 ? 2 : 1;

      // Note: strobeSpeed is only honoured by the server when pattern === 'strobe'.
      // For non-strobe patterns we zero it so a previous build-up strobe doesn't
      // bleed into the new segment.
      const strobeSpeed = pattern === 'strobe' ? this._segmentStrobeSpeed(seg) : 0;
      const strobeFunction = this._segmentStrobeFunction(seg);

      const patchKey = `${pattern}|${colA}|${colB}|${strobeSpeed}|${strobeFunction}|${beatDivision}`;
      if (patchKey === lastPatternKey) continue;
      lastPatternKey = patchKey;

      events.push({
        timeMs,
        action: 'patch',
        data: {
          pattern,
          colorA: colA,
          colorB: colB,
          strobeSpeed,
          strobeFunction,
          beatDivision,
          energyOverride: null,
        },
      });
      colorIdx++;
    }

    // ── Build-ups: escalating strobe speed during the rise ──────────────────
    for (const build of buildups) {
      const startMs = Math.round(build.start * 1000);
      const endMs = Math.round(build.end * 1000);
      const durMs = Math.max(1000, endMs - startMs);
      // Emit 5 rising strobe-speed patches across the build
      const steps = 5;
      for (let i = 0; i < steps; i++) {
        const t = startMs + Math.round((i / steps) * durMs);
        const speed = Math.round(40 + (i / (steps - 1)) * 210); // 40 → 250
        events.push({
          timeMs: t,
          action: 'patch',
          data: {
            pattern: 'strobe',
            strobeSpeed: speed,
            strobeFunction: i < 2 ? 'ramp-up' : 'standard',
          },
        });
      }
      // On the last beat of the build, kill the lights for a split-second
      // "silence" that makes the drop hit harder.
      events.push({
        timeMs: Math.max(startMs, endMs - 120),
        action: 'patch',
        data: { pattern: 'solid', colorA: 12 /* Blackout */, strobeSpeed: 0 },
      });
    }

    // ── Drops: blinder → hot colour slam → color-strobe burst → movement ───
    for (let i = 0; i < drops.length; i++) {
      const drop = drops[i];
      const tMs = Math.round(drop.t * 1000);
      const strength = Math.max(0, Math.min(1, drop.strength || 0.5));
      const dropColorA = this._dropColor(i, palette);
      const dropColorB = (dropColorA + 4) % this._colorPresets.length;

      // 1. Lock in the hot drop colour at the exact drop time. JS sort is
      //    stable, and drops are pushed AFTER segment-boundary patches, so
      //    at the same timestamp this anchor lands last among patches
      //    (and still before the energy burst thanks to our sort rule).
      events.push({
        timeMs: tMs,
        action: 'patch',
        data: {
          pattern: 'solid',
          colorA: dropColorA,
          colorB: dropColorB,
          strobeSpeed: 0,
          beatDivision: 2,
          energyOverride: null,
        },
      });

      // 2. Instant full-white blinder flash on the downbeat (140–300ms)
      const blinderMs = Math.round(140 + strength * 160);
      events.push({
        timeMs: tMs,
        action: 'energy',
        data: { id: 'blinder', durationMs: blinderMs },
      });

      // 3. Sustained colour-strobe burst right after the blinder (~650ms).
      //    Re-lock the drop colour 1ms before the burst so color-strobe
      //    reads the right colorA even if anything else wrote to it.
      const afterBlinderMs = tMs + blinderMs + 10;
      const colorStrobeMs = Math.round(500 + strength * 300);
      events.push({
        timeMs: afterBlinderMs - 1,
        action: 'patch',
        data: { colorA: dropColorA, colorB: dropColorB },
      });
      events.push({
        timeMs: afterBlinderMs,
        action: 'energy',
        data: { id: 'color-strobe', durationMs: colorStrobeMs },
      });

      // 4. When the burst clears, switch into a high-intensity movement
      //    pattern so the drop keeps moving. Rotate through the pool by drop
      //    index so a track with multiple drops doesn't replay the same look.
      const dropMovePool = ['color-cycle', 'rainbow', 'runner', 'pairs', 'sparkle', 'random-flash'];
      const dropMoveFiltered = dropMovePool.filter(p => availablePatterns.has(p));
      const movePattern = dropMoveFiltered.length
        ? dropMoveFiltered[i % dropMoveFiltered.length]
        : 'chase';
      events.push({
        timeMs: afterBlinderMs + colorStrobeMs + 20,
        action: 'patch',
        data: {
          pattern: movePattern,
          colorA: dropColorA,
          colorB: dropColorB,
          strobeSpeed: 0,
          beatDivision: 2,
          energyOverride: null,
        },
      });
    }


    // ── Beat-level accents on strong beats in high-energy segments ─────────
    if (a.beats && a.beatStrengths && segments.length) {
      const strongThreshold = 0.55;
      let lastAccentMs = -9999;
      for (let i = 0; i < a.beats.length; i++) {
        const beatT = a.beats[i];
        const strength = a.beatStrengths[i] || 0;
        if (strength < strongThreshold) continue;

        const beatMs = Math.round(beatT * 1000);
        if (beatMs - lastAccentMs < 900) continue; // don't spam

        // Skip accents inside drops / buildups (they handle themselves)
        if (drops.some(d => Math.abs(d.t * 1000 - beatMs) < 1500)) continue;
        if (buildups.some(b => beatMs >= b.start * 1000 - 200 && beatMs <= b.end * 1000 + 200)) continue;

        // Only accent during high-energy segments
        const seg = segments.find(s => beatT >= s.start && beatT < s.end);
        if (!seg || seg.level !== 'high') continue;

        const bright = (seg.spectralCentroid || 0) > 0.35;
        const effectId = bright ? 'white-strobe' : 'color-strobe';

        events.push({
          timeMs: beatMs,
          action: 'energy',
          data: { id: effectId, durationMs: 90 },
        });
        lastAccentMs = beatMs;
      }
    }

    // ── Bass onsets on mid-energy segments → subtle colour flips ────────────
    if (a.bassOnsets && segments.length) {
      let lastFlip = -9999;
      for (const bt of a.bassOnsets) {
        const btMs = Math.round(bt * 1000);
        if (btMs - lastFlip < 1500) continue;
        const seg = segments.find(s => bt >= s.start && bt < s.end);
        if (!seg || seg.level !== 'mid') continue;
        if (drops.some(d => Math.abs(d.t * 1000 - btMs) < 1500)) continue;
        if (buildups.some(b => btMs >= b.start * 1000 && btMs <= b.end * 1000)) continue;
        events.push({
          timeMs: btMs,
          action: 'patch',
          data: { colorA: palette[(Math.floor(bt) % palette.length)] },
        });
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
    this.timeline = events;
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

  _buildPalette(key, scale) {
    // Color preset indices: 0=Red 1=Orange 2=Amber 3=Yellow 4=Green
    // 5=Cyan 6=Blue 7=Purple 8=Magenta 9=White 10=UV 11=UV(RGB)

    const warm = [0, 1, 2, 3, 8, 7]; // Red Orange Amber Yellow Magenta Purple
    const cool = [6, 5, 4, 7, 11, 9]; // Blue Cyan Green Purple UV(RGB) White

    let palette = scale === 'minor' ? cool : warm;

    const keys = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    const keyIdx = keys.indexOf(key);
    if (keyIdx > 0) {
      const offset = keyIdx % palette.length;
      palette = [...palette.slice(offset), ...palette.slice(0, offset)];
    }

    return palette;
  }

  _dropColor(dropIdx, _palette) {
    // Pick a "hot" drop colour: saturated magentas / reds / cyans that
    // contrast hard against the current palette.
    const hotColors = [0, 8, 5, 7, 6, 4]; // Red, Magenta, Cyan, Purple, Blue, Green
    return hotColors[dropIdx % hotColors.length];
  }

  _pickPattern(segment, segIdx, available) {
    const brightness = segment.spectralCentroid || 0;
    const bass = segment.bass || 0;

    // Rotate through a pool using segIdx so consecutive segments of the same
    // energy level don't keep landing on the same pattern. Unavailable
    // patterns are filtered out first; 'chase' is the universal fallback.
    const pickFrom = (pool) => {
      const filtered = pool.filter(p => available.has(p));
      if (!filtered.length) return available.has('chase') ? 'chase' : [...available][0];
      return filtered[segIdx % filtered.length];
    };

    switch (segment.level) {
      case 'low':
        // Calm: slow sustained patterns, light movement if there's any bass.
        if (bass < 0.2) return pickFrom(['fade', 'solid', 'wave']);
        return pickFrom(['solid', 'fade', 'color-cycle', 'wave']);

      case 'mid':
        // Movement: bigger pool, picked by brightness/bass character.
        if (brightness > 0.45) return pickFrom(['rainbow', 'ping-pong', 'wave', 'runner', 'chase']);
        if (bass > 0.4)        return pickFrom(['split', 'pairs', 'runner', 'stack-up', 'chase']);
        return pickFrom(['chase', 'ping-pong', 'pairs', 'runner', 'wave']);

      case 'high':
        // Intensity: sparkly/flashy patterns on bright sections, hammering
        // colour movement on bass-heavy ones.
        if (brightness > 0.55) return pickFrom(['sparkle', 'twinkle', 'random-flash', 'rainbow', 'color-cycle']);
        if (bass > 0.5)        return pickFrom(['color-cycle', 'pairs', 'stack-up', 'random-flash', 'split']);
        return pickFrom(['chase', 'runner', 'color-cycle', 'rainbow', 'sparkle']);

      default:
        return pickFrom(['chase']);
    }
  }

  _segmentStrobeSpeed(seg) {
    if (seg.level !== 'high') return 0;
    const energy = seg.energy || 0;
    const bright = seg.spectralCentroid || 0;
    // Only introduce strobe on bright, hot sections — otherwise it's a blur
    if (bright < 0.3 && energy < 0.65) return 0;
    return Math.round(Math.min(255, 90 + energy * 140 + bright * 30));
  }

  _segmentStrobeFunction(seg) {
    const bright = seg.spectralCentroid || 0;
    if (bright > 0.55) return 'random';
    if ((seg.bass || 0) > 0.55) return 'ramp-up';
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
      key: a.key,
      scale: a.scale,
      beats: a.beats || [],
      segments: a.segments || [],
      drops: a.drops || [],
      buildups: a.buildups || [],
      energyCurve: a.energyCurve || [],
      bassCurve: a.bassCurve || [],
      highCurve: a.highCurve || [],
      timeline,
    };
  }

  getClientState() {
    return {
      status: this._status,
      running: this.running,
      track: this.track,
      analysis: this.analysis ? {
        duration: this.analysis.duration,
        bpm: this.analysis.bpm,
        key: this.analysis.key,
        scale: this.analysis.scale,
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
