'use strict';

const fs = require('fs');
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

class AnalysisCache {
  constructor(dir) {
    this.dir = dir;
    try { fs.mkdirSync(this.dir, { recursive: true }); } catch (_) {}
  }

  _pathFor(key) {
    const hash = crypto.createHash('sha1').update(key).digest('hex');
    return path.join(this.dir, `${hash}.json`);
  }

  get(key) {
    if (!key) return null;
    const p = this._pathFor(key);
    try {
      if (!fs.existsSync(p)) return null;
      const entry = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (!entry || !entry.analysis) return null;
      if (!isCompatible(entry.analysis)) {
        // Removed rather than skipped, so has(), which the warmer and the
        // prefetch poll, stops reporting it as analysed.
        console.log(`[analysis-cache] ${key}: schema ${entry.analysis.schemaVersion ?? 'none'} `
          + `is older than ${MIN_COMPATIBLE.join('.')}; it will be re-analysed`);
        try { fs.unlinkSync(p); } catch (_) { /* already gone */ }
        return null;
      }
      return entry.analysis;
    } catch (_) {
      return null;
    }
  }

  /** Cheap existence check (no read/parse) — safe to poll. */
  has(key) {
    if (!key) return false;
    try { return fs.existsSync(this._pathFor(key)); } catch (_) { return false; }
  }

  set(key, analysis, meta = {}) {
    if (!key || !analysis) return;
    const p = this._pathFor(key);
    try {
      const entry = {
        key,
        meta,
        cachedAt: new Date().toISOString(),
        analysis,
      };
      fs.writeFileSync(p, JSON.stringify(entry));
    } catch (e) {
      console.warn(`[analysis-cache] failed to write ${p}: ${e.message}`);
    }
  }

  delete(key) {
    if (!key) return false;
    const p = this._pathFor(key);
    try { fs.unlinkSync(p); return true; } catch (_) { return false; }
  }

  clear() {
    let removed = 0;
    try {
      for (const f of fs.readdirSync(this.dir)) {
        if (f.endsWith('.json')) {
          try { fs.unlinkSync(path.join(this.dir, f)); removed++; } catch (_) {}
        }
      }
    } catch (_) {}
    return removed;
  }

  list() {
    try {
      return fs.readdirSync(this.dir)
        .filter(f => f.endsWith('.json'))
        .map(f => {
          try {
            const entry = JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf8'));
            return {
              key: entry.key,
              meta: entry.meta || {},
              cachedAt: entry.cachedAt,
              duration: entry.analysis?.duration,
              bpm: entry.analysis?.bpm,
              key_: entry.analysis?.key,
              scale: entry.analysis?.scale,
            };
          } catch (_) { return null; }
        })
        .filter(Boolean)
        .sort((a, b) => String(b.cachedAt).localeCompare(String(a.cachedAt)));
    } catch (_) { return []; }
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
