import multer from 'multer';
import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from 'express';
import { messageOf, statusOf } from '../../errors.ts';
import { cues as defaultCues } from '../cues.ts';
import { createOflLibrary } from '../ofl-library.ts';
import { wledClient } from '../wled.ts';
import { openrgbClient } from '../openrgb.ts';
import { listEntertainmentConfigs, pair } from '../hue.ts';
import * as output from '../output.ts';
import type { HueBridgeSettings } from '../settings.ts';
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
import type { OpenRgbClient } from '../openrgb.ts';

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
  oflLibrary?: OflLibrary;
  wled?: WledClient;
  openrgb?: OpenRgbClient;
  hueAreas?: typeof listEntertainmentConfigs;
  huePair?: typeof pair;
  cues?: CueStore;
  restart?: (reason: string) => boolean;
}

export const uploadAudio = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024, files: 1, fields: 8 } });
export const uploadGdtf = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: 1, fields: 8 } });
export const uploadOfl = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024, files: 1, fields: 8 } });

export type RouteContext = RouteDeps & {
  oflLibrary: OflLibrary; wled: WledClient; openrgb: OpenRgbClient; hueAreas: typeof listEntertainmentConfigs; huePair: typeof pair; cues: CueStore;
};

export function routeContext(deps: RouteDeps): RouteContext {
  return {
    ...deps,
    oflLibrary: deps.oflLibrary || createOflLibrary(),
    wled: deps.wled || wledClient,
    openrgb: deps.openrgb || openrgbClient,
    hueAreas: deps.hueAreas || listEntertainmentConfigs,
    huePair: deps.huePair || pair,
    cues: deps.cues || defaultCues,
  };
}

export function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => unknown): RequestHandler {
  return (req, res, next) => { Promise.resolve(fn(req, res, next)).catch(next); };
}

export function resolveHueBridge(req: Request, res: Response): HueBridgeSettings | null {
  const bridges = output.getHueConfig().bridges;
  const id = (req.params as Record<string, string | undefined>).bridge;
  if (id === undefined) {
    if (bridges.length) return bridges[0];
    res.status(409).json({ ok: false, error: 'Pair with a bridge first.' });
    return null;
  }
  const bridge = bridges.find((b) => b.id === id);
  if (bridge) return bridge;
  res.status(404).json({ ok: false, error: `No Hue bridge "${id}" — GET /api/hue/status lists them.` });
  return null;
}

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

  console.error('[api] unhandled error:', e.stack ? e.stack : err);
  res.status(500).json({ ok: false, error: e.message || 'Internal error' });
};
