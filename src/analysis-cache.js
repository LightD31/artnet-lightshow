'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

/**
 * Simple file-backed cache for audio analysis results.
 *
 * Each entry is one JSON file named after sha1(key), storing:
 *   { key, meta, cachedAt, analysis }
 *
 * Keys are plain strings built by the `keyFor*` helpers below so the same
 * track always produces the same key regardless of the code path (Spotify
 * track change, manual Spotify analyze, YouTube URL, search query, local
 * file, upload).
 */
// ── Schema compatibility ─────────────────────────────────────────────────────
// The analyser stamps every document with its schema version, and version.py
// names the oldest one a consumer can still read. Taken from that file rather
// than restated here, so bumping the analyser is the only edit a breaking
// change needs. An entry older than that is a miss: replaying it would drive
// tonight's show from a document the director no longer understands, silently,
// for as long as the track stays in the cache.
function readMinCompatible() {
  try {
    const source = fs.readFileSync(path.join(__dirname, 'analysis', 'version.py'), 'utf8');
    const m = source.match(/^MIN_COMPATIBLE\s*=\s*['"](\d+)\.(\d+)['"]/m);
    if (m) return [Number(m[1]), Number(m[2])];
  } catch (_) { /* fall through */ }
  return [2, 0];
}
const MIN_COMPATIBLE = readMinCompatible();

/** Whether a document's schemaVersion is one this build can still replay. */
function isCompatible(analysis, min = MIN_COMPATIBLE) {
  const m = /^(\d+)\.(\d+)/.exec(String(analysis?.schemaVersion ?? ''));
  if (!m) return false;
  const [major, minor] = [Number(m[1]), Number(m[2])];
  return major > min[0] || (major === min[0] && minor >= min[1]);
}

// Room for a season of shows. Past this the least recently played analyses
// go first; a track that comes back is simply analysed again.
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024 * 1024;

const SUMMARY_SUFFIX = '.summary.json';

/** A main entry file, as opposed to its summary or a write in progress. */
function isEntryFile(name) {
  return name.endsWith('.json') && !name.endsWith(SUMMARY_SUFFIX);
}

/** The few fields the cache list shows, taken from a full entry. */
function summarise(entry, bytes) {
  const a = entry.analysis || {};
  return {
    key: entry.key,
    meta: entry.meta || {},
    cachedAt: entry.cachedAt,
    duration: a.duration,
    bpm: a.bpm,
    key_: a.key,
    scale: a.scale,
    schemaVersion: a.schemaVersion ?? null,
    bytes,
  };
}

/** The listing's shape: the summary without the bookkeeping fields. */
function listing({ schemaVersion: _v, bytes: _b, ...rest }) {
  return rest;
}

/** Write a file so a reader sees the old contents or the new, never half. */
function writeAtomicSync(file, body) {
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmp, body);
  fs.renameSync(tmp, file);
}

async function writeAtomic(file, body) {
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  try {
    await fsp.writeFile(tmp, body);
    await fsp.rename(tmp, file);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

class AnalysisCache {
  /**
   * @param {string} dir
   * @param {object} [options]
   * @param {number} [options.maxBytes]  total size to keep; the least recently
   *   used entries are removed past it
   */
  constructor(dir, { maxBytes = DEFAULT_MAX_BYTES } = {}) {
    this.dir = dir;
    this.maxBytes = maxBytes;
    this._evicting = null;
    try { fs.mkdirSync(this.dir, { recursive: true }); } catch (_) {}
  }

  _pathFor(key) {
    const hash = crypto.createHash('sha1').update(key).digest('hex');
    return path.join(this.dir, `${hash}.json`);
  }

  _summaryPathFor(key) {
    return this._pathFor(key).replace(/\.json$/, SUMMARY_SUFFIX);
  }

  /** Validate a parsed entry; drop it from disk when it is too old to replay. */
  _accept(key, entry) {
    if (!entry || !entry.analysis) return null;
    if (!isCompatible(entry.analysis)) {
      // Removed rather than skipped, so has(), which the warmer and the
      // prefetch poll, stops reporting it as analysed.
      console.log(`[analysis-cache] ${key}: schema ${entry.analysis.schemaVersion ?? 'none'} `
        + `is older than ${MIN_COMPATIBLE.join('.')}; it will be re-analysed`);
      this.delete(key);
      return null;
    }
    return entry.analysis;
  }

  /**
   * Synchronous read. Kept for scripts and tests; the show itself uses
   * load(), because a document is megabytes and reading it synchronously
   * holds up the render loop that shares this thread.
   */
  get(key) {
    if (!key) return null;
    const p = this._pathFor(key);
    try {
      if (!fs.existsSync(p)) return null;
      return this._accept(key, JSON.parse(fs.readFileSync(p, 'utf8')));
    } catch (_) {
      return null;
    }
  }

  /** Read an entry without blocking; null on a miss. Marks it recently used. */
  async load(key) {
    if (!key) return null;
    const p = this._pathFor(key);
    let raw;
    try {
      raw = await fsp.readFile(p, 'utf8');
    } catch (_) {
      return null;
    }
    let analysis;
    try {
      analysis = this._accept(key, JSON.parse(raw));
    } catch (_) {
      return null;
    }
    if (analysis) {
      // Least recently *used*, not least recently analysed: a track played
      // every week must outlive one that was warmed once and never played.
      const now = new Date();
      fsp.utimes(p, now, now).catch(() => {});
    }
    return analysis;
  }

  /**
   * Is this key analysed and still readable? Cheap enough to poll: it reads
   * only the small summary, and an entry the analyser has moved past counts
   * as missing, so the warmer re-analyses it instead of skipping it.
   */
  has(key) {
    if (!key) return false;
    try {
      if (!fs.existsSync(this._pathFor(key))) return false;
      const summaryPath = this._summaryPathFor(key);
      if (fs.existsSync(summaryPath)) {
        const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
        if (!isCompatible({ schemaVersion: summary.schemaVersion })) {
          this.delete(key);
          return false;
        }
      }
      return true;
    } catch (_) {
      return false;
    }
  }

  _entry(key, analysis, meta) {
    return { key, meta, cachedAt: new Date().toISOString(), analysis };
  }

  /** Synchronous write, for scripts and tests. See save(). */
  set(key, analysis, meta = {}) {
    if (!key || !analysis) return;
    const p = this._pathFor(key);
    try {
      const entry = this._entry(key, analysis, meta);
      const body = JSON.stringify(entry);
      writeAtomicSync(p, body);
      writeAtomicSync(this._summaryPathFor(key), JSON.stringify(summarise(entry, Buffer.byteLength(body))));
    } catch (e) {
      console.warn(`[analysis-cache] failed to write ${p}: ${e.message}`);
    }
  }

  /**
   * Store an analysis without blocking, then trim the cache to its budget.
   *
   * Written to a temporary file and renamed into place, so a crash or a full
   * disk mid-write leaves the previous entry or none — never a truncated one
   * that has() would report as analysed for ever after. The summary is
   * written second: an entry with no summary is still read correctly.
   */
  async save(key, analysis, meta = {}) {
    if (!key || !analysis) return;
    const p = this._pathFor(key);
    try {
      const entry = this._entry(key, analysis, meta);
      const body = JSON.stringify(entry);
      await writeAtomic(p, body);
      await writeAtomic(this._summaryPathFor(key), JSON.stringify(summarise(entry, Buffer.byteLength(body))));
    } catch (e) {
      console.warn(`[analysis-cache] failed to write ${p}: ${e.message}`);
      return;
    }
    await this.evict();
  }

  delete(key) {
    if (!key) return false;
    const p = this._pathFor(key);
    try { fs.rmSync(this._summaryPathFor(key), { force: true }); } catch (_) { /* no summary */ }
    try { fs.unlinkSync(p); return true; } catch (_) { return false; }
  }

  clear() {
    let removed = 0;
    try {
      for (const f of fs.readdirSync(this.dir)) {
        if (!f.endsWith('.json')) continue;
        try {
          fs.unlinkSync(path.join(this.dir, f));
          if (isEntryFile(f)) removed++;
        } catch (_) { /* already gone */ }
      }
    } catch (_) {}
    return removed;
  }

  /** How many analyses are stored. Directory listing only — no reads. */
  count() {
    try { return fs.readdirSync(this.dir).filter(isEntryFile).length; } catch (_) { return 0; }
  }

  /**
   * Every entry, newest first, for the cache view.
   *
   * Reads the summaries, not the documents: listing used to parse every
   * cached analysis synchronously, megabytes each, on the thread that renders
   * DMX. An entry written before summaries existed is read once, in full,
   * and gets one.
   */
  async list() {
    let files;
    try { files = (await fsp.readdir(this.dir)).filter(isEntryFile); } catch (_) { return []; }
    const out = [];
    for (const f of files) {
      const main = path.join(this.dir, f);
      const summaryPath = main.replace(/\.json$/, SUMMARY_SUFFIX);
      try {
        let summary;
        try {
          summary = JSON.parse(await fsp.readFile(summaryPath, 'utf8'));
        } catch (_) {
          const body = await fsp.readFile(main, 'utf8');
          summary = summarise(JSON.parse(body), Buffer.byteLength(body));
          await writeAtomic(summaryPath, JSON.stringify(summary)).catch(() => {});
        }
        out.push(listing(summary));
      } catch (_) { /* unreadable entry: leave it out */ }
    }
    return out.sort((a, b) => String(b.cachedAt).localeCompare(String(a.cachedAt)));
  }

  /**
   * Remove the least recently used entries until the cache fits its budget.
   * One pass at a time; a call while one is running joins it.
   */
  evict() {
    if (!this._evicting) {
      this._evicting = this._evictOnce().finally(() => { this._evicting = null; });
    }
    return this._evicting;
  }

  async _evictOnce() {
    let files;
    try { files = (await fsp.readdir(this.dir)).filter(isEntryFile); } catch (_) { return 0; }
    const entries = [];
    let total = 0;
    for (const f of files) {
      try {
        const st = await fsp.stat(path.join(this.dir, f));
        entries.push({ f, bytes: st.size, usedAt: st.mtimeMs });
        total += st.size;
      } catch (_) { /* vanished */ }
    }
    if (total <= this.maxBytes) return 0;
    entries.sort((a, b) => a.usedAt - b.usedAt);
    let removed = 0;
    for (const e of entries) {
      if (total <= this.maxBytes) break;
      const main = path.join(this.dir, e.f);
      await fsp.rm(main.replace(/\.json$/, SUMMARY_SUFFIX), { force: true }).catch(() => {});
      await fsp.rm(main, { force: true }).catch(() => {});
      total -= e.bytes;
      removed++;
    }
    if (removed) console.log(`[analysis-cache] removed ${removed} least recently used ${removed === 1 ? 'analysis' : 'analyses'} to stay under ${Math.round(this.maxBytes / 1024 / 1024)} MB`);
    return removed;
  }
}

// ── Key builders ────────────────────────────────────────────────────────────
// All builders must be stable across restarts and runs.

function keyForSpotify(trackId) {
  return trackId ? `spotify:${trackId}` : null;
}

/** Returns a YouTube key if `input` looks like a YT URL, else null. */
function keyForYouTube(input) {
  if (!input) return null;
  const m = String(input).match(
    /(?:v=|youtu\.be\/|\/embed\/|\/shorts\/|\/v\/)([A-Za-z0-9_-]{11})/
  );
  return m ? `yt:${m[1]}` : null;
}

/** Normalized free-text search query key. */
function keyForQuery(query) {
  if (!query) return null;
  const norm = String(query).trim().toLowerCase().replace(/\s+/g, ' ');
  if (!norm) return null;
  return `q:${norm}`;
}

/** Path + size + mtime — invalidates automatically on file changes. */
function keyForLocalFile(filepath) {
  try {
    const abs = path.resolve(filepath);
    const st = fs.statSync(abs);
    return `file:${abs.toLowerCase()}:${st.size}:${Math.round(st.mtimeMs)}`;
  } catch (_) {
    return null;
  }
}

/** Content hash for uploaded buffers — same file gives same key. */
function keyForBuffer(buf) {
  if (!buf || !buf.length) return null;
  const hash = crypto.createHash('sha1').update(buf).digest('hex');
  return `upload:${hash}`;
}

/**
 * Stable key for a track loaded on a CDJ via PRO DJ LINK.
 *
 * Keyed on what the track *is* — artist, title and length — whenever rekordbox
 * says. The device/slot/id tuple is only an address: rekordbox numbers tracks
 * per export, so the same id on another DJ's USB stick, or on the same stick
 * after a re-export, is a different song, and a key built from it handed that
 * song the wrong analysis. The length is part of the key because it is also
 * what picks the download, so an extended mix and a radio edit stay apart.
 *
 * The tuple is still the fallback for a track rekordbox has no metadata for.
 */
function keyForProlinkTrack({ deviceId, slot, trackId, title, artist, durationMs } = {}) {
  if (title && artist) {
    const norm = `${artist} - ${title}`.trim().toLowerCase().replace(/\s+/g, ' ');
    const seconds = Number.isFinite(durationMs) && durationMs > 0 ? Math.round(durationMs / 1000) : 0;
    return `prolink:${norm}:${seconds}`;
  }
  if (deviceId != null && slot != null && trackId) {
    return `prolink:${deviceId}:${slot}:${trackId}`;
  }
  return null;
}

module.exports = {
  AnalysisCache,
  isCompatible,
  MIN_COMPATIBLE,
  keyForSpotify,
  keyForYouTube,
  keyForQuery,
  keyForLocalFile,
  keyForBuffer,
  keyForProlinkTrack,
};
