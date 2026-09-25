import multer from 'multer';
import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from 'express';
import { messageOf, statusOf } from '../../errors.ts';
import { cues as defaultCues } from '../cues.ts';
import { createOflLibrary } from '../ofl-library.ts';
import { wledClient } from '../wled.ts';
import type AutoShow from '../../auto-show.ts';
import type { CueStore } from '../cues.ts';
import type { AnalysisCache } from '../../analysis-cache.ts';
import type DeezerSource from '../../deezer-source.ts';
import type MidiController from '../../midi.ts';
import type NowPlayingSource from '../../nowplaying-source.ts';
import type ProLink from '../../prolink.ts';
import type SpotifyClient from '../../spotify.ts';
import type { createApplier } from '../apply.ts';
import type { setupIntegrations } from '../integrations.ts';
import type { OflLibrary } from '../ofl-library.ts';
import type { WledClient } from '../wled.ts';

/**
 * What every domain's routes share (src/server/routes/): the subsystems they
 * drive, the async wrapper that hands a throw to the error handler, the upload
 * limits, and the error handler itself.
 */

/** The live subsystems the routes drive. */
export interface RouteDeps {
  midi: MidiController;
  autoShow: AutoShow;
  spotify: SpotifyClient;
  nowPlaying: NowPlayingSource;
  deezerSource: DeezerSource;
  prolink: ProLink;
  analysisCache: AnalysisCache;
  integrations: ReturnType<typeof setupIntegrations>;
  applier: ReturnType<typeof createApplier>;
  /** The Open Fixture Library online; the real one unless a test stands in. */
  oflLibrary?: OflLibrary;
  /** Finding and asking WLEDs; the real network unless a test stands in. */
  wled?: WledClient;
  /** The cue stack; the one saved in config/cues.json unless a test stands in. */
  cues?: CueStore;
  /** Stop to be started again by the supervisor; false when there is none. */
  restart?: (reason: string) => boolean;
}

// Audio uploads genuinely need headroom; GDTF files do not. Separate limits so
// the fixture importer isn't handed a 50 MB budget it has no use for — a real
// GDTF is a few hundred KB.
// One file and a handful of fields per request: both are held in memory.
export const uploadAudio = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024, files: 1, fields: 8 } });
export const uploadGdtf = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: 1, fields: 8 } });
// An OFL fixture is plain JSON, tens of KB even for a pixel bar.
export const uploadOfl = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024, files: 1, fields: 8 } });

/** The subsystems, with the ones a test may stand in for filled in. */
export type RouteContext = RouteDeps & { oflLibrary: OflLibrary; wled: WledClient; cues: CueStore };

export function routeContext(deps: RouteDeps): RouteContext {
  return {
    ...deps,
    oflLibrary: deps.oflLibrary || createOflLibrary(),
    wled: deps.wled || wledClient,
    cues: deps.cues || defaultCues,
  };
}

/** An async handler whose throw (or rejection) reaches the error handler. */
export function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => unknown): RequestHandler {
  return (req, res, next) => { Promise.resolve(fn(req, res, next)).catch(next); };
}

// ─── Error handler ────────────────────────────────────────────────────────
// Must be registered last. Without it, anything that reaches next(err) — an
// upload over the size limit, a malformed JSON body, a throw inside an
// asyncHandler — fell through to Express's default handler, which answers
// with an HTML page carrying the stack trace (it only hides it when NODE_ENV
// is 'production', which a locally-run show tool never sets). Every other
// route here answers JSON; this makes the failure paths agree.
export const errorHandler: ErrorRequestHandler = (err: unknown, _req, res, _next) => {
  if (res.headersSent) return;
  const e = (err ?? {}) as { code?: string; field?: string; status?: number; statusCode?: number; stack?: string; message?: string };

  // Multer signals "too big" with a code rather than a status.
  if (e.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ ok: false, error: 'Uploaded file is too large' });
  }
  if (e.code === 'LIMIT_UNEXPECTED_FILE') {
    return res.status(400).json({ ok: false, error: `Unexpected file field "${e.field}"` });
  }

  const status = statusOf(err) || e.statusCode;
  if (status && status >= 400 && status < 500) {
    return res.status(status).json({ ok: false, error: messageOf(err) });
  }

  // Genuine server-side faults: log the detail, return only the message.
  console.error('[api] unhandled error:', e.stack ? e.stack : err);
  res.status(500).json({ ok: false, error: e.message || 'Internal error' });
};
