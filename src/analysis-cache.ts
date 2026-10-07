import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { messageOf } from './errors.ts';
import type { Analysis } from './show/score.ts';
import type { ShowOverlay } from './show/overlay.ts';

export type CacheMeta = Record<string, unknown>;

export interface CacheEntry {
  key: string;
  meta: CacheMeta;
  cachedAt: string;
  analysis: Analysis;
}

export interface CacheSummary {
  key: string;
  meta: CacheMeta;
  cachedAt: string;
  duration?: number;
  bpm?: number;
  key_?: string | null;
  scale?: string | null;
  schemaVersion: string | null;
  bytes: number;
}

export type CacheListing = Omit<CacheSummary, 'schemaVersion' | 'bytes'>;

export interface ProlinkTrackRef {
  deviceId?: number | null;
  slot?: string | number | null;
  trackId?: number | string | null;
  title?: string | null;
  artist?: string | null;
  durationMs?: number;
}

function readMinCompatible(): [number, number] {
  try {
    const source = fs.readFileSync(path.join(import.meta.dirname, 'analysis', 'version.py'), 'utf8');
    const m = source.match(/^MIN_COMPATIBLE\s*=\s*['"](\d+)\.(\d+)['"]/m);
    if (m) return [Number(m[1]), Number(m[2])];
  } catch (_) { /* fall through */ }
  return [2, 0];
}
const MIN_COMPATIBLE = readMinCompatible();

function isCompatible(analysis: { schemaVersion?: unknown } | null | undefined, min = MIN_COMPATIBLE): boolean {
  const m = /^(\d+)\.(\d+)/.exec(String(analysis?.schemaVersion ?? ''));
  if (!m) return false;
  const [major, minor] = [Number(m[1]), Number(m[2])];
  return major > min[0] || (major === min[0] && minor >= min[1]);
}

const DEFAULT_MAX_BYTES = 4 * 1024 * 1024 * 1024;

const SUMMARY_SUFFIX = '.summary.json';
const OVERLAY_SUFFIX = '.overlay.json';

function isEntryFile(name: string): boolean {
  return name.endsWith('.json') && !name.endsWith(SUMMARY_SUFFIX) && !name.endsWith(OVERLAY_SUFFIX);
}

function summarise(entry: CacheEntry, bytes: number): CacheSummary {
  const a: Analysis = entry.analysis || {};
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

function listing({ schemaVersion: _v, bytes: _b, ...rest }: CacheSummary): CacheListing {
  return rest;
}

function writeAtomicSync(file: string, body: string): void {
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmp, body);
  fs.renameSync(tmp, file);
}

async function writeAtomic(file: string, body: string): Promise<void> {
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
  declare dir: string;
  declare maxBytes: number;
  declare _evicting: Promise<number> | null;

  /**
   * @param {string} dir
   * @param {object} [options]
   * @param {number} [options.maxBytes]  total size to keep; the least recently
   *   used entries are removed past it
   */
  constructor(dir: string, { maxBytes = DEFAULT_MAX_BYTES } = {}) {
    this.dir = dir;
    this.maxBytes = maxBytes;
    this._evicting = null;
    try { fs.mkdirSync(this.dir, { recursive: true }); } catch (_) {}
  }

  _pathFor(key: string): string {
    const hash = crypto.createHash('sha1').update(key).digest('hex');
    return path.join(this.dir, `${hash}.json`);
  }

  _summaryPathFor(key: string): string {
    return this._pathFor(key).replace(/\.json$/, SUMMARY_SUFFIX);
  }

  _overlayPathFor(key: string): string {
    return this._pathFor(key).replace(/\.json$/, OVERLAY_SUFFIX);
  }

  overlay(key: string | null | undefined): ShowOverlay | null {
    if (!key) return null;
    try {
      const parsed = JSON.parse(fs.readFileSync(this._overlayPathFor(key), 'utf8'));
      return parsed && typeof parsed === 'object' ? parsed.overlay ?? null : null;
    } catch (_) {
      return null;
    }
  }

  setOverlay(key: string | null | undefined, overlay: ShowOverlay | null): void {
    if (!key) return;
    const p = this._overlayPathFor(key);
    const empty = !overlay || (!overlay.palette && !overlay.sections?.length
      && !overlay.accents?.add?.length && !overlay.accents?.remove?.length);
    if (empty) {
      try { fs.rmSync(p, { force: true }); } catch (_) { /* not there */ }
      return;
    }
    writeAtomicSync(p, JSON.stringify({ key, updatedAt: new Date().toISOString(), overlay }));
  }

  _accept(key: string, entry: CacheEntry | null | undefined): Analysis | null {
    if (!entry || !entry.analysis) return null;
    if (!isCompatible(entry.analysis)) {
      console.log(`[analysis-cache] ${key}: schema ${entry.analysis.schemaVersion ?? 'none'} `
        + `is older than ${MIN_COMPATIBLE.join('.')}; it will be re-analysed`);
      this.delete(key);
      return null;
    }
    return entry.analysis;
  }

  // Use async reads for live playback because analysis documents are large enough to block rendering.
  get(key: string | null | undefined): Analysis | null {
    if (!key) return null;
    const p = this._pathFor(key);
    try {
      if (!fs.existsSync(p)) return null;
      return this._accept(key, JSON.parse(fs.readFileSync(p, 'utf8')));
    } catch (_) {
      return null;
    }
  }

  async load(key: string | null | undefined): Promise<Analysis | null> {
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
      // Evict by last use so regularly played tracks outlive unused warm-cache entries.
      const now = new Date();
      fsp.utimes(p, now, now).catch(() => {});
    }
    return analysis;
  }

  has(key: string | null | undefined): boolean {
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

  _entry(key: string, analysis: Analysis, meta: CacheMeta): CacheEntry {
    return { key, meta, cachedAt: new Date().toISOString(), analysis };
  }

  set(key: string | null | undefined, analysis: Analysis | null | undefined, meta: CacheMeta = {}): void {
    if (!key || !analysis) return;
    const p = this._pathFor(key);
    try {
      const entry = this._entry(key, analysis, meta);
      const body = JSON.stringify(entry);
      writeAtomicSync(p, body);
      writeAtomicSync(this._summaryPathFor(key), JSON.stringify(summarise(entry, Buffer.byteLength(body))));
    } catch (e) {
      console.warn(`[analysis-cache] failed to write ${p}: ${messageOf(e)}`);
    }
  }

  // Rename completed writes so interrupted analysis cannot leave a truncated cache hit.
  async save(key: string | null | undefined, analysis: Analysis | null | undefined, meta: CacheMeta = {}): Promise<void> {
    if (!key || !analysis) return;
    const p = this._pathFor(key);
    try {
      const entry = this._entry(key, analysis, meta);
      const body = JSON.stringify(entry);
      await writeAtomic(p, body);
      await writeAtomic(this._summaryPathFor(key), JSON.stringify(summarise(entry, Buffer.byteLength(body))));
    } catch (e) {
      console.warn(`[analysis-cache] failed to write ${p}: ${messageOf(e)}`);
      return;
    }
    await this.evict();
  }

  delete(key: string | null | undefined): boolean {
    if (!key) return false;
    const p = this._pathFor(key);
    try { fs.rmSync(this._summaryPathFor(key), { force: true }); } catch (_) { /* no summary */ }
    try { fs.unlinkSync(p); return true; } catch (_) { return false; }
  }

  clear(): number {
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

  count(): number {
    try { return fs.readdirSync(this.dir).filter(isEntryFile).length; } catch (_) { return 0; }
  }

  async list(): Promise<CacheListing[]> {
    let files;
    try { files = (await fsp.readdir(this.dir)).filter(isEntryFile); } catch (_) { return []; }
    const out: CacheListing[] = [];
    for (const f of files) {
      const main = path.join(this.dir, f);
      const summaryPath = main.replace(/\.json$/, SUMMARY_SUFFIX);
      try {
        let summary: CacheSummary;
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

  evict(): Promise<number> {
    if (!this._evicting) {
      this._evicting = this._evictOnce().finally(() => { this._evicting = null; });
    }
    return this._evicting;
  }

  async _evictOnce(): Promise<number> {
    let files;
    try { files = (await fsp.readdir(this.dir)).filter(isEntryFile); } catch (_) { return 0; }
    const entries: { f: string; bytes: number; usedAt: number }[] = [];
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

// Keep cache keys stable across restarts so warmed analysis remains reusable.

function keyForSpotify(trackId: string | number | null | undefined): string | null {
  return trackId ? `spotify:${trackId}` : null;
}

function keyForYouTube(input: unknown): string | null {
  if (!input) return null;
  const m = String(input).match(
    /(?:v=|youtu\.be\/|\/embed\/|\/shorts\/|\/v\/)([A-Za-z0-9_-]{11})/
  );
  return m ? `yt:${m[1]}` : null;
}

function keyForQuery(query: unknown): string | null {
  if (!query) return null;
  const norm = String(query).trim().toLowerCase().replace(/\s+/g, ' ');
  if (!norm) return null;
  return `q:${norm}`;
}

function keyForLocalFile(filepath: string): string | null {
  try {
    const abs = path.resolve(filepath);
    const st = fs.statSync(abs);
    return `file:${abs.toLowerCase()}:${st.size}:${Math.round(st.mtimeMs)}`;
  } catch (_) {
    return null;
  }
}

function keyForBuffer(buf: Buffer | null | undefined): string | null {
  if (!buf || !buf.length) return null;
  const hash = crypto.createHash('sha1').update(buf).digest('hex');
  return `upload:${hash}`;
}

// Key tracks by metadata and duration because rekordbox IDs can be reused after USB re-export.
function keyForProlinkTrack({ deviceId, slot, trackId, title, artist, durationMs }: ProlinkTrackRef = {},
  { exact = false }: { exact?: boolean } = {}): string | null {
  if (title && artist) {
    const norm = `${artist} - ${title}`.trim().toLowerCase().replace(/\s+/g, ' ');
    const seconds = typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs > 0
      ? Math.round(durationMs / 1000) : 0;
    return `${exact ? 'prolink-file' : 'prolink'}:${norm}:${seconds}`;
  }
  if (exact) return null;
  if (deviceId != null && slot != null && trackId) {
    return `prolink:${deviceId}:${slot}:${trackId}`;
  }
  return null;
}

export {
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
