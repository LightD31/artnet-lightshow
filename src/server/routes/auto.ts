import crypto from 'node:crypto';
import path from 'node:path';
import fsp from 'node:fs/promises';
import os from 'node:os';
import { state } from '../state.ts';
import { applyPatch } from '../patch.ts';
import { overlaySchema, validate } from '../validation.ts';
import { settings } from '../settings.ts';
import { keyForSpotify, keyForYouTube, keyForQuery, keyForLocalFile, keyForBuffer } from '../../analysis-cache.ts';
import { HttpError, messageOf, statusOf, isCancelled } from '../../errors.ts';
import type { Express, Request, RequestHandler, Response } from 'express';
import type { NowPlaying, PlaybackSource } from '../../types/playback.ts';
import { asyncHandler, uploadAudio } from './common.ts';
import type { RouteContext } from './common.ts';

/** What the operator typed into "Analyse", classified (see classifyAnalyzeSource). */
export type AnalyzeSource =
  | { kind: 'url'; source: string; direct: boolean }
  | { kind: 'local'; source: string }
  | { kind: 'search'; source: string };

// Local-file analysis reads a path off the filesystem. When a library folder is
// set (Sources → Analysis) it is confined to that subtree; blank keeps the old
// behaviour of any absolute path. Read per request so a change applies without
// a restart.
//
// Both sides are resolved with realpath, so a symlink inside the folder cannot
// point the analyser somewhere outside it.
export async function resolveLocalPath(source: string): Promise<string> {
  let resolved: string;
  try {
    resolved = await fsp.realpath(source);
  } catch (_) {
    throw new HttpError(404, `No such file: ${source}`);
  }
  const configured = settings.get('analysis.localRoot');
  if (!configured) return resolved;
  let root: string;
  try { root = await fsp.realpath(configured); } catch (_) { root = path.resolve(configured); }
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  if (resolved !== root && !resolved.startsWith(prefix)) {
    throw new HttpError(403, `Local file analysis is restricted to ${root}`);
  }
  return resolved;
}

const AUDIO_EXTENSIONS = ['.mp3', '.wav', '.ogg', '.flac', '.m4a', '.aac', '.wma', '.opus', '.webm', '.aiff', '.aif'];
const DIRECT_AUDIO_RE = /\.(mp3|wav|ogg|flac|m4a|aac|wma|opus|webm|aiff?)(\?|$)/i;

/**
 * What an operator typed into "Analyse", classified before anything touches it.
 *
 *   url     an http(s) link — a direct audio file or a page yt-dlp understands
 *   local   an absolute path on this machine
 *   search  anything else, handed to yt-dlp as a search
 *
 * Refused outright: UNC and device paths (\\server\share, //server/share,
 * \\?\C:), which on Windows make the machine authenticate to whatever server
 * the path names; any other URL scheme (file:, ftp:, smb:); and a relative
 * path to an audio file, whose meaning depends on the server's working folder.
 */
export function classifyAnalyzeSource(source: unknown): AnalyzeSource {
  const text = String(source).trim();
  const refuse = (message: string): never => {
    throw new HttpError(400, message);
  };
  if (/^[\\/]{2}/.test(text)) refuse('Network (UNC) paths are not accepted — copy the file to this machine first');
  if (/^https?:\/\//i.test(text)) return { kind: 'url', source: text, direct: DIRECT_AUDIO_RE.test(text) };
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) refuse('Only http(s) links, absolute file paths or a search can be analysed');
  if (/^[a-zA-Z]:[\\/]/.test(text) || text.startsWith('/')) return { kind: 'local', source: text };
  if (DIRECT_AUDIO_RE.test(text) && /[\\/]/.test(text)) refuse('Give the full path to the file, not a relative one');
  return { kind: 'search', source: text };
}

/**
 * The auto show: analysing a track from wherever it comes from, starting and
 * stopping the show, its edits, its settings, its timeline, and the analysis
 * cache.
 */
export function attachAutoRoutes(app: Express, ctx: RouteContext): void {
  const { autoShow, spotify, nowPlaying, deezerSource, prolink, analysisCache, integrations } = ctx;

  // ─── Auto-show ────────────────────────────────────────────────────────────

  /**
   * `start: true` on an analyse request: start the show once the analysis is
   * in. Held on the server, so it happens whether or not the page that asked
   * is still open or on the same tab — it used to wait in the page, and a
   * tab switch mid-analysis lost it. A stop or a cancel in between calls it
   * off, and so does a newer request.
   */
  function wantStart(req: Request): symbol | null {
    const start = req.body && (req.body.start === true || req.body.start === 'true');
    if (!start) return null;
    const token = Symbol('start');
    autoShow.startPending = token;
    integrations.broadcast();
    return token;
  }

  /** Start the show if the start that `token` asked for still stands. */
  function startIfWanted(token: symbol | null): boolean {
    if (!token || autoShow.startPending !== token) return false;
    autoShow.startPending = null;
    integrations.startAutoShow();
    return true;
  }

  /**
   * An analysis that did not finish. One the operator called off, or a
   * newer track overtook, is not an error to show them.
   */
  function analysisFailed(res: Response, err: unknown, token: symbol | null): void {
    if (token && autoShow.startPending === token) autoShow.startPending = null;
    integrations.broadcast();
    const overtaken = !!err && typeof err === 'object' && (err as { superseded?: unknown }).superseded === true;
    if (isCancelled(err) || overtaken) {
      res.status(409).json({ ok: false, cancelled: true, error: messageOf(err) });
      return;
    }
    res.status(statusOf(err) || 500).json({ ok: false, error: messageOf(err) });
  }

  app.post('/api/auto/analyze', asyncHandler(async (req, res) => {
    const { source } = req.body || {};
    if (!source) return res.status(400).json({ ok: false, error: 'Provide a source (file path, URL, or YouTube search)' });

    const start = wantStart(req);
    try {
      const input = classifyAnalyzeSource(source);
      if (input.kind === 'local') {
        const file = await resolveLocalPath(input.source);
        autoShow.track = { name: path.basename(file), artist: 'Local file', album: '', albumArt: null };
        await autoShow.analyze(file, keyForLocalFile(file));
      } else if (input.kind === 'url' && input.direct) {
        autoShow.track = { name: path.basename(new URL(input.source).pathname), artist: 'Link', album: '', albumArt: null };
        await autoShow.analyze(input.source, `url:${input.source}`);
      } else {
        autoShow.track = { name: input.source, artist: '', album: '', albumArt: null };
        integrations.broadcast();
        const cacheKey = keyForYouTube(input.source) || keyForQuery(input.source);
        await autoShow.downloadAndAnalyze(input.source, null, cacheKey);
      }
      const started = startIfWanted(start);
      integrations.broadcast();
      res.json({ ok: true, started, analysis: autoShow.getClientState().analysis });
    } catch (err) {
      analysisFailed(res, err, start);
    }
  }));

  /**
   * Analyse whatever a playback source says is playing now.
   *
   * One handler for the sources that report a track rather than hand over
   * audio. They differ only in how they are asked, what they are called when
   * they are not connected, and the cache key: Spotify has a stable track id,
   * the others only a name.
   */
  function analyzePlaying({ source, notConnected, nothingPlaying, keyFor = () => null, after }: {
    source: PlaybackSource;
    notConnected: string;
    nothingPlaying: string;
    keyFor?: (playing: NowPlaying) => string | null;
    after?: () => unknown;
  }): RequestHandler {
    return asyncHandler(async (req, res) => {
      if (!source.authenticated) return res.status(400).json({ ok: false, error: notConnected });
      const start = wantStart(req);
      try {
        const playing = await source.getCurrentlyPlaying();
        if (!playing) return res.status(400).json({ ok: false, error: nothingPlaying });

        autoShow.track = {
          name: playing.name, artist: playing.artist, album: playing.album,
          albumArt: playing.albumArt, durationMs: playing.durationMs,
        };
        integrations.broadcast();

        const query = `${playing.artist} - ${playing.name}`;
        const cacheKey = keyFor(playing) || keyForQuery(query);
        await autoShow.downloadAndAnalyze(query, playing.durationMs / 1000, cacheKey, playing.isrc);

        const started = startIfWanted(start);
        integrations.broadcast();
        res.json({ ok: true, started, track: autoShow.track, analysis: autoShow.getClientState().analysis });
        if (after) after();
      } catch (err) {
        analysisFailed(res, err, start);
      }
    });
  }

  app.post('/api/auto/analyze-spotify', analyzePlaying({
    source: spotify,
    notConnected: 'Spotify not connected',
    nothingPlaying: 'No track currently playing on Spotify',
    keyFor: (playing) => keyForSpotify(playing.trackId),
    after: () => integrations.prefetchNextFromQueue(),
  }));

  app.post('/api/auto/analyze-nowplaying', analyzePlaying({
    source: nowPlaying,
    notConnected: 'Nothing is currently playing',
    nothingPlaying: 'Nothing is currently playing',
  }));

  app.post('/api/auto/analyze-deezer', analyzePlaying({
    source: deezerSource,
    notConnected: 'Deezer extension not connected',
    nothingPlaying: 'No track currently playing on Deezer',
  }));

  app.post('/api/auto/download-analyze', asyncHandler(async (req, res) => {
    const { query } = req.body || {};
    if (!query) return res.status(400).json({ ok: false, error: 'Provide a query (YouTube URL or search terms)' });
    const start = wantStart(req);
    try {
      autoShow.track = { name: query, artist: '', album: '', albumArt: null };
      integrations.broadcast();
      const cacheKey = keyForYouTube(query) || keyForQuery(query);
      await autoShow.downloadAndAnalyze(query, null, cacheKey);
      const started = startIfWanted(start);
      integrations.broadcast();
      res.json({ ok: true, started, analysis: autoShow.getClientState().analysis });
    } catch (err) {
      analysisFailed(res, err, start);
    }
  }));

  app.post('/api/auto/analyze-upload', uploadAudio.single('audio'), asyncHandler(async (req, res) => {
    if (!req.file) return res.status(400).json({ ok: false, error: 'No audio file uploaded' });
    // The extension is the only part of the client's file name that reaches the
    // disk, and only from a fixed list: a name the client chose, or an
    // executable extension, has no business sitting in the temp folder.
    const ext = path.extname(req.file.originalname || '').toLowerCase();
    if (!AUDIO_EXTENSIONS.includes(ext)) {
      return res.status(400).json({ ok: false, error: `Not an audio file (${AUDIO_EXTENSIONS.join(', ')})` });
    }
    const tmpPath = path.join(os.tmpdir(), `auto-analyze-${crypto.randomUUID()}${ext}`);
    const start = wantStart(req);
    try {
      // Async on purpose: this buffer can be 50 MB, and a synchronous write of
      // that size stalls the event loop — which here means the 44 Hz Art-Net
      // render loop stops sending frames and the rig visibly freezes mid-show.
      await fsp.writeFile(tmpPath, req.file.buffer);
      autoShow.track = { name: req.file.originalname, artist: 'Local file', album: '', albumArt: null };
      const cacheKey = keyForBuffer(req.file.buffer);
      await autoShow.analyze(tmpPath, cacheKey);
      const started = startIfWanted(start);
      integrations.broadcast();
      res.json({ ok: true, started, track: autoShow.track, analysis: autoShow.getClientState().analysis });
    } catch (err) {
      analysisFailed(res, err, start);
    } finally {
      await fsp.unlink(tmpPath).catch(() => { /* already gone */ });
    }
  }));

  app.post('/api/auto/analyze-prolink', asyncHandler(async (req, res) => {
    if (!prolink.connected) return res.status(400).json({ ok: false, error: 'PRO DJ LINK not connected' });
    const track = prolink.getTrack();
    if (!track) return res.status(400).json({ ok: false, error: 'No track on the deck the show follows' });

    const start = wantStart(req);
    try {
      autoShow.track = {
        name: track.title || `Track ${track.trackId}`, artist: track.artist || 'PRO DJ LINK', album: track.album || '',
        albumArt: null, durationMs: track.durationMs || 0,
      };
      integrations.broadcast();

      await integrations.analyseCdjTrack(track);

      const started = startIfWanted(start);
      integrations.broadcast();
      res.json({ ok: true, started, track: autoShow.track, analysis: autoShow.getClientState().analysis });
    } catch (err) {
      analysisFailed(res, err, start);
    }
  }));

  app.post('/api/auto/start', (_req, res) => {
    // Playing by ear needs no analysis: that is what it is for.
    if (!autoShow.analysis && integrations.resolveAutoSource() !== 'live') {
      return res.status(400).json({ ok: false, error: 'No analysis loaded. Analyze a track first, or turn on the live input to play by ear.' });
    }
    const source = integrations.startAutoShow();
    integrations.broadcast();
    res.json({ ok: true, source });
  });

  // Call off the analysis the page is waiting on (AutoShow.cancelAnalysis).
  app.post('/api/auto/cancel', (_req, res) => {
    const cancelled = autoShow.cancelAnalysis();
    integrations.broadcast();
    res.json({ ok: true, cancelled });
  });

  app.post('/api/auto/stop', (_req, res) => {
    autoShow.startPending = null;
    integrations.stopAutoShow();
    integrations.broadcast();
    res.json({ ok: true });
  });

  app.post('/api/auto/reset', (_req, res) => {
    autoShow.reset();
    integrations.broadcast();
    res.json({ ok: true });
  });

  // The operator's edits to the loaded track's show: a palette locked, a
  // section's look swapped, accents added or taken away (show/overlay.ts).
  // Stored beside the track's analysis and put back on every plan of it.
  app.get('/api/auto/overlay', (_req, res) => {
    if (!autoShow.analysis) return res.status(404).json({ ok: false, error: 'No track loaded.' });
    res.json({ ok: true, key: autoShow.analysisKey, overlay: autoShow.overlay() || {} });
  });

  app.put('/api/auto/overlay', (req, res) => {
    if (!autoShow.analysis) return res.status(404).json({ ok: false, error: 'No track loaded.' });
    try {
      const overlay = validate(overlaySchema, req.body || {}, 'overlay');
      autoShow.setOverlay(overlay);
      integrations.broadcast();
      res.json({ ok: true, key: autoShow.analysisKey, overlay: autoShow.overlay() || {}, revision: autoShow.timelineRevision });
    } catch (err) { res.status(statusOf(err) || 400).json({ ok: false, error: messageOf(err) }); }
  });

  // The energy slider, on its own endpoint so a Stream Deck button or a script
  // can reach it without composing a state patch.
  app.post('/api/auto/intensity/:value', (req, res) => {
    try {
      applyPatch({ autoIntensity: parseInt(req.params.value, 10) });
      res.json({ ok: true, intensity: state.autoIntensity });
    } catch (err) { res.status(statusOf(err) || 400).json({ ok: false, error: messageOf(err) }); }
  });

  // Nudging this mid-set is normal — an operator hears the lights lagging and
  // corrects — so it gets its own endpoint alongside intensity rather than
  // living only in the stored settings.
  app.post('/api/auto/sync-offset/:value', (req, res) => {
    try {
      applyPatch({ autoSyncOffsetMs: parseInt(req.params.value, 10) });
      res.json({ ok: true, syncOffsetMs: state.autoSyncOffsetMs });
    } catch (err) { res.status(statusOf(err) || 400).json({ ok: false, error: messageOf(err) }); }
  });

  app.post('/api/auto/palette-size/:value', (req, res) => {
    try {
      const raw = req.params.value;
      applyPatch({ autoPaletteSize: raw === 'auto' ? 'auto' : parseInt(raw, 10) });
      res.json({ ok: true, paletteSize: autoShow.paletteSize });
    } catch (err) { res.status(statusOf(err) || 400).json({ ok: false, error: messageOf(err) }); }
  });

  app.get('/api/auto/state', (_req, res) => {
    res.json({
      ok: true,
      ...autoShow.getClientState(),
      spotify: spotify.getStatus(),
      nowPlaying: nowPlaying.getStatus(),
      deezer: deezerSource.getStatus(),
    });
  });

  app.get('/api/auto/timeline', (_req, res) => {
    const data = autoShow.getTimelineData();
    if (!data) return res.status(404).json({ ok: false, error: 'No analysis loaded' });
    res.json({ ok: true, data });
  });

  app.get('/api/auto/cache', asyncHandler(async (_req, res) => {
    res.json({ ok: true, entries: await analysisCache.list() });
  }));

  app.delete('/api/auto/cache', (_req, res) => {
    const removed = analysisCache.clear();
    res.json({ ok: true, removed });
  });

  app.delete('/api/auto/cache/entry', (req, res) => {
    const { key } = req.body || {};
    if (!key) return res.status(400).json({ ok: false, error: 'Missing key' });
    const ok = analysisCache.delete(key);
    res.json({ ok });
  });
}
