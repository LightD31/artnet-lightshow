'use strict';

const { z } = require('zod');
const { keyForSpotify, keyForQuery, keyForYouTube } = require('../analysis-cache');

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
const PENDING = 'pending';
const WARMING = 'warming';
const READY = 'ready';
const CACHED = 'cached';
const ERROR = 'error';
const CANCELLED = 'cancelled';

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

// "1. ", "01) ", "12 - " at the start of a pasted line.
const LEADING_NUMBER_RE = /^\s*\d{1,3}\s*[.)\]-]\s+/;

/** Turn a pasted set list into track inputs. */
function parseSetList(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.replace(LEADING_NUMBER_RE, '').trim())
    .filter((line) => line && !line.startsWith('#'))
    .slice(0, MAX_TRACKS)
    .map((query) => ({ query }));
}

/**
 * Normalise one input into the job the warmer runs.
 *
 * The cache key has to be the same one the live path will look up when the
 * track actually plays, or the warming was wasted: a Spotify track id when we
 * have one, a YouTube id for a URL, and otherwise the normalised
 * "artist - title" query, which is what every other source falls back to.
 */
function toJob(input) {
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
function buildJobs(inputs) {
  const seen = new Set();
  const jobs = [];
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
  constructor({ autoShow, onChange = () => {} }) {
    this._autoShow = autoShow;
    this._onChange = onChange;
    this._jobs = [];
    this._running = false;
    this._cancelled = false;
    this._startedAt = null;
    this._finishedAt = null;
  }

  get running() { return this._running; }

  /** The progress view the UI renders and the REST endpoints return. */
  status() {
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
  start(inputs) {
    if (this._running) {
      const err = new Error('Already warming — cancel the current run first');
      err.status = 409;
      throw err;
    }

    const jobs = buildJobs(inputs);
    if (!jobs.length) {
      const err = new Error('Nothing to warm — no usable track names in that list');
      err.status = 400;
      throw err;
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
      console.warn(`[warm] run failed: ${err.message}`);
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
  cancel() {
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
  clear() {
    if (this._running) return false;
    this._jobs = [];
    this._startedAt = null;
    this._finishedAt = null;
    this._onChange();
    return true;
  }

  async _run() {
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
        // Normal priority: a track change during a set submits at high
        // priority and must not sit behind an hour of warming.
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
        job.message = err.message;
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

module.exports = {
  Warmer,
  MAX_TRACKS,
  warmRequestSchema,
  parseSetList,
  buildJobs,
  toJob,
  STATUSES: { PENDING, WARMING, READY, CACHED, ERROR, CANCELLED },
};
