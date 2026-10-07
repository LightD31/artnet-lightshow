import { z } from 'zod';
import { keyForSpotify, keyForQuery, keyForYouTube } from '../analysis-cache.ts';
import { HttpError, messageOf } from '../errors.ts';
import type { CacheMeta } from '../analysis-cache.ts';
import type { AnalysisPriority } from '../analyzer-worker.ts';

export type WarmStatus = 'pending' | 'warming' | 'ready' | 'cached' | 'error' | 'cancelled';

export interface WarmJob {
  query: string;
  cacheKey: string;
  isrc: string | null;
  durationSec: number | null;
  status: WarmStatus;
  message: string;
}

export type WarmInput = z.output<typeof trackInputSchema>;

export interface PlaylistTrack {
  name?: string;
  artist?: string;
  isrc?: string | null;
  trackId?: string | number | null;
  durationMs?: number;
}

export interface WarmTarget {
  isCached(cacheKey: string): boolean;
  prefetch(query: string, durationSec: number | null, cacheKey: string, meta: CacheMeta,
    isrc: string | null, priority: AnalysisPriority): Promise<{ error?: string; skipped?: boolean; reason?: string }>;
}

export interface WarmProgress {
  running: boolean;
  total: number;
  done: number;
  ready: number;
  failed: number;
  current: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  tracks: Pick<WarmJob, 'query' | 'cacheKey' | 'status' | 'message'>[];
}

const MAX_TRACKS = 200;

const PENDING: WarmStatus = 'pending';
const WARMING: WarmStatus = 'warming';
const READY: WarmStatus = 'ready';
const CACHED: WarmStatus = 'cached';
const ERROR: WarmStatus = 'error';
const CANCELLED: WarmStatus = 'cancelled';

const trackInputSchema = z.object({
  query: z.string().min(1).max(512).optional(),
  title: z.string().max(512).optional(),
  artist: z.string().max(512).optional(),
  isrc: z.string().max(32).nullable().optional(),
  trackId: z.union([z.string().max(128), z.number()]).nullable().optional(),
  durationMs: z.number().nonnegative().max(24 * 60 * 60 * 1000).optional(),
}).strict();

const warmRequestSchema = z.object({
  tracks: z.array(trackInputSchema).max(MAX_TRACKS).optional(),
  text: z.string().max(64 * 1024).optional(),
}).strict();

const warmPlaylistSchema = z.object({
  playlist: z.string().min(1).max(512),
}).strict();

const LEADING_NUMBER_RE = /^\s*\d{1,3}\s*[.)\]-]\s+/;

function parseSetList(text: unknown): { query: string }[] {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.replace(LEADING_NUMBER_RE, '').trim())
    .filter((line) => line && !line.startsWith('#'))
    .slice(0, MAX_TRACKS)
    .map((query) => ({ query }));
}

function fromSpotifyTracks(tracks: readonly PlaylistTrack[] | null | undefined): WarmInput[] {
  return (tracks || [])
    .filter((t): t is PlaylistTrack & { name: string } => !!(t && t.name))
    .map((t) => ({
      title: t.name,
      artist: t.artist,
      isrc: t.isrc,
      trackId: t.trackId,
      durationMs: t.durationMs,
    }));
}

// Reuse live-playback cache keys so warmed tracks are found when they start.
function toJob(input: WarmInput): WarmJob | null {
  const query = input.query || [input.artist, input.title].filter(Boolean).join(' - ');
  if (!query) return null;

  const cacheKey = keyForSpotify(input.trackId) || keyForYouTube(query) || keyForQuery(query);
  if (!cacheKey) return null;

  return {
    query,
    cacheKey,
    isrc: input.isrc || null,
    durationSec: input.durationMs ? input.durationMs / 1000 : null,
    status: PENDING,
    message: '',
  };
}

function buildJobs(inputs: readonly WarmInput[]): WarmJob[] {
  const seen = new Set<string>();
  const jobs: WarmJob[] = [];
  for (const input of inputs) {
    const job = toJob(input);
    if (!job || seen.has(job.cacheKey)) continue;
    seen.add(job.cacheKey);
    jobs.push(job);
    if (jobs.length >= MAX_TRACKS) break;
  }
  return jobs;
}

class Warmer {
  declare _autoShow: WarmTarget;
  declare _onChange: () => void;
  declare _jobs: WarmJob[];
  declare _running: boolean;
  declare _cancelled: boolean;
  declare _startedAt: string | null;
  declare _finishedAt: string | null;

  constructor({ autoShow, onChange = () => {} }: { autoShow: WarmTarget; onChange?: () => void }) {
    this._autoShow = autoShow;
    this._onChange = onChange;
    this._jobs = [];
    this._running = false;
    this._cancelled = false;
    this._startedAt = null;
    this._finishedAt = null;
  }

  get running(): boolean { return this._running; }

  status(): WarmProgress {
    const done = this._jobs.filter((j) => j.status !== PENDING && j.status !== WARMING).length;
    const current = this._jobs.find((j) => j.status === WARMING);
    return {
      running: this._running,
      total: this._jobs.length,
      done,
      ready: this._jobs.filter((j) => j.status === READY || j.status === CACHED).length,
      failed: this._jobs.filter((j) => j.status === ERROR).length,
      current: current ? current.query : null,
      startedAt: this._startedAt,
      finishedAt: this._finishedAt,
      tracks: this._jobs.map((j) => ({
        query: j.query, cacheKey: j.cacheKey, status: j.status, message: j.message,
      })),
    };
  }

  start(inputs: readonly WarmInput[]): WarmProgress {
    if (this._running) {
      throw new HttpError(409, 'Already warming — cancel the current run first');
    }

    const jobs = buildJobs(inputs);
    if (!jobs.length) {
      throw new HttpError(400, 'Nothing to warm — no usable track names in that list');
    }

    this._jobs = jobs;
    this._running = true;
    this._cancelled = false;
    this._startedAt = new Date().toISOString();
    this._finishedAt = null;
    this._onChange();

    this._run().catch((err) => {
      console.warn(`[warm] run failed: ${messageOf(err)}`);
      this._running = false;
      this._finishedAt = new Date().toISOString();
      this._onChange();
    });

    return this.status();
  }

  cancel(): boolean {
    if (!this._running) return false;
    this._cancelled = true;
    for (const job of this._jobs) {
      if (job.status === PENDING) {
        job.status = CANCELLED;
        job.message = 'Cancelled';
      }
    }
    this._onChange();
    return true;
  }

  clear(): boolean {
    if (this._running) return false;
    this._jobs = [];
    this._startedAt = null;
    this._finishedAt = null;
    this._onChange();
    return true;
  }

  async _run(): Promise<void> {
    for (const job of this._jobs) {
      if (this._cancelled) break;

      if (this._autoShow.isCached(job.cacheKey)) {
        job.status = CACHED;
        job.message = 'Already cached';
        this._onChange();
        continue;
      }

      job.status = WARMING;
      job.message = 'Downloading and analysing';
      this._onChange();

      try {
        // Keep warm jobs below current and queued tracks so background preparation cannot delay the show.
        const result = await this._autoShow.prefetch(
          job.query, job.durationSec, job.cacheKey,
          { track: { name: job.query } }, job.isrc, 'normal',
        );

        if (result.error) {
          job.status = ERROR;
          job.message = result.error;
        } else if (result.skipped && result.reason === 'already-cached') {
          job.status = CACHED;
          job.message = 'Already cached';
        } else {
          job.status = READY;
          job.message = 'Analysed and cached';
        }
      } catch (err) {
        job.status = ERROR;
        job.message = messageOf(err);
      }
      this._onChange();
    }

    this._running = false;
    this._finishedAt = new Date().toISOString();
    const { ready, failed, total } = this.status();
    console.log(`[warm] finished: ${ready}/${total} cached${failed ? `, ${failed} failed` : ''}`);
    this._onChange();
  }
}

export const STATUSES = { PENDING, WARMING, READY, CACHED, ERROR, CANCELLED };

export {
  Warmer,
  MAX_TRACKS,
  warmRequestSchema,
  warmPlaylistSchema,
  parseSetList,
  fromSpotifyTracks,
  buildJobs,
  toJob,
};
