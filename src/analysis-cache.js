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
      return entry.analysis;
    } catch (_) {
      return null;
    }
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

function keyForDeezer(trackId) {
  return trackId ? `deezer:${trackId}` : null;
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
 * Stable key for a track loaded on a CDJ via PRO DJ LINK. Prefers the
 * rekordbox identity tuple; falls back to a search-query key when only
 * title+artist are known.
 */
function keyForProlinkTrack({ deviceId, slot, trackId, title, artist } = {}) {
  if (deviceId != null && slot != null && trackId) {
    return `prolink:${deviceId}:${slot}:${trackId}`;
  }
  if (title && artist) return keyForQuery(`${artist} - ${title}`);
  return null;
}

module.exports = {
  AnalysisCache,
  keyForSpotify,
  keyForDeezer,
  keyForYouTube,
  keyForQuery,
  keyForLocalFile,
  keyForBuffer,
  keyForProlinkTrack,
};
