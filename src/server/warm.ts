import { z } from 'zod';
import { keyForSpotify, keyForQuery, keyForYouTube } from '../analysis-cache.ts';
import { HttpError, messageOf } from '../errors.ts';

export type WarmStatus = 'pending' | 'warming' | 'ready' | 'cached' | 'error' | 'cancelled';

/** One track of a set list being warmed. */
export interface WarmJob {
  query: string;
  cacheKey: string;
  isrc: string | null;
  durationSec: number | null;
  status: WarmStatus;
  message: string;
}

/** A track as a set list or a playlist names it. */
export type WarmInput = z.output<typeof trackInputSchema>;

/** A playlist track as the Spotify client returns it. */
export interface PlaylistTrack {
  name?: string;
  artist?: string;
  isrc?: string | null;
  trackId?: string | number | null;
  durationMs?: number;
}

/** What the warmer needs of the auto show. */
export interface WarmTarget {
  isCached(cacheKey: string): boolean;
  prefetch(query: string, durationSec: number | null, cacheKey: string, meta: unknown,
    isrc: string | null, priority: string): Promise<{ error?: string; skipped?: boolean; reason?: string }>;
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

/**
 * Warm the analysis cache for a whole set list, ahead of the show.
 *
 * Live prefetch only looks one to five tracks down the queue, and only once a
 * source is playing. That is enough to make a track change instant *during* a
 * set, and no help at all for the first track of the night, for a DJ who does
 * not queue ahead, or for a venue whose network you would rather not depend on
 * once the room is full. Analysing a track takes tens of seconds; doing forty of
 * them at load-in costs nothing but time you already have.
 *
 * So: paste the set list, walk away, come back to a cache that already knows
 * every track.
 *
 * Runs one track at a time. The analyzer worker serialises anyway, and doing it
 * in order means the progress list says something true rather than showing
 * forty tracks all "in progress".
 */

// A set list, not a library. The cap bounds both the work and the progress
// payload that rides the state broadcast.
const MAX_TRACKS = 200;

// Track statuses, in the order one moves through them.
const PENDING: WarmStatus = 'pending';
const WARMING: WarmStatus = 'warming';
const READY: WarmStatus = 'ready';
const CACHED: WarmStatus = 'cached';
const ERROR: WarmStatus = 'error';
const CANCELLED: WarmStatus = 'cancelled';

const trackInputSchema = z.object({
  // Either a ready-made query, or the parts to build one from.
  query: z.string().min(1).max(512).optional(),
  title: z.string().max(512).optional(),
  artist: z.string().max(512).optional(),
  isrc: z.string().max(32).nullable().optional(),
  trackId: z.union([z.string().max(128), z.number()]).nullable().optional(),
  durationMs: z.number().nonnegative().max(24 * 60 * 60 * 1000).optional(),
}).strict();

const warmRequestSchema = z.object({
  tracks: z.array(trackInputSchema).max(MAX_TRACKS).optional(),
  // A pasted set list: one "Artist - Title" per line. Blank lines and lines
  // starting with # are ignored, and leading track numbers are stripped.
  text: z.string().max(64 * 1024).optional(),
}).strict();

// A playlist to warm, as pasted: a share link, a Spotify URI or a bare id.
// The id itself is parsed (and rejected) by the Spotify client.
const warmPlaylistSchema = z.object({
  playlist: z.string().min(1).max(512),
}).strict();

// "1. ", "01) ", "12 - " at the start of a pasted line.
const LEADING_NUMBER_RE = /^\s*\d{1,3}\s*[.)\]-]\s+/;

/** Turn a pasted set list into track inputs. */
function parseSetList(text: unknown): { query: string }[] {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.replace(LEADING_NUMBER_RE, '').trim())
    .filter((line) => line && !line.startsWith('#'))
    .slice(0, MAX_TRACKS)
    .map((query) => ({ query }));
}

/**
 * Map Spotify track summaries — from the live queue or from a playlist — onto
 * warm inputs. Both sources hand back the same shape, and both want the same
 * thing out of it: the Spotify id (so the warmed entry lands under the key the
 * live path will look up) plus the ISRC, which finds the exact recording
 * instead of whatever a title search turns up.
 */
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

/**
 * Normalise one input into the job the warmer runs.
 *
 * The cache key has to be the same one the live path will look up when the
 * track actually plays, or the warming was wasted: a Spotify track id when we
 * have one, a YouTube id for a URL, and otherwise the normalised
 * "artist - title" query, which is what every other source falls back to.
 */
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

/** Build the job list, dropping duplicates so a repeated track is warmed once. */
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

  /** The progress view the UI renders and the REST endpoints return. */
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

  /**
   * Start warming. Rejects a second run rather than interleaving two set lists,
   * which would make the progress list meaningless and the ordering arbitrary.
   */
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

    // Deliberately not awaited: the caller gets an immediate answer and follows
    // progress over the state broadcast. Warming a forty-track set is minutes
    // of work, not a request.
    this._run().catch((err) => {
      console.warn(`[warm] run failed: ${messageOf(err)}`);
      this._running = false;
      this._finishedAt = new Date().toISOString();
      this._onChange();
    });

    return this.status();
  }

  /**
   * Stop after the track currently being analysed.
   *
   * The analyzer worker has no way to abandon a job mid-run, and killing it
   * would take the live show's analysis down with it. So the in-flight track
   * finishes — its result goes in the cache, which is what was wanted anyway —
   * and nothing else starts.
   */
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

  /** Drop a finished run's list. Refuses while one is in progress. */
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

      // Cheap check first: a track already on disk needs no worker at all, and
      // re-running a whole set list should be nearly instant.
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
        // Normal priority and no queue position: a track change during a set
        // submits as the current track, which must not sit behind an hour of
        // warming — it interrupts the warm job in flight and this one resumes
        // after. Prefetches for the upcoming queue have a position and so are
        // served ahead of warm jobs waiting in the same band.
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
