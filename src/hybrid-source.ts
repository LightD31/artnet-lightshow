import PlaybackClock from './playback-clock.ts';
import type { PlaybackClockStatus } from './playback-clock.ts';
import type { NowPlaying } from './types/playback.ts';

export type HybridDriver = 'nowplaying' | 'spotify' | 'none';

type TrackIdentity = Pick<NowPlaying, 'name' | 'artist' | 'durationMs'>;

export interface HybridStatus {
  driver: HybridDriver;
  matched: boolean;
  sessionLive: boolean;
  sessionApp: string | null;
  sessionTrack: string | null;
  contentTrack: string | null;
  clock: PlaybackClockStatus;
}

const CLOCK_STALE_MS = 1500;

const DURATION_TOLERANCE_MS = 2500;

const MISMATCH_GRACE = 3;

function normalise(text: unknown): string {
  return String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')   // combining marks left by NFD
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function tracksMatch(a: TrackIdentity | null | undefined, b: TrackIdentity | null | undefined): boolean {
  if (!a || !b) return false;

  const titleA = normalise(a.name);
  const titleB = normalise(b.name);
  if (!titleA || !titleB) return false;

  const titleAgrees = titleA === titleB
    || titleA.startsWith(titleB) || titleB.startsWith(titleA);
  if (!titleAgrees) return false;

  const durationA = Number(a.durationMs) || 0;
  const durationB = Number(b.durationMs) || 0;
  const haveBoth = durationA > 0 && durationB > 0;
  const durationAgrees = haveBoth
    && Math.abs(durationA - durationB) <= DURATION_TOLERANCE_MS;
  if (haveBoth && !durationAgrees) return false;

  const artistA = normalise(a.artist);
  const artistB = normalise(b.artist);
  const artistAgrees = !artistA || !artistB
    || artistA === artistB
    || artistA.includes(artistB) || artistB.includes(artistA);

  return durationAgrees || artistAgrees;
}

class HybridSource {
  declare _clock: PlaybackClock;
  declare _now: () => number;
  declare _content: NowPlaying | null;
  declare _session: NowPlaying | null;
  declare _sessionAt: number;
  declare _matched: boolean;
  declare _mismatches: number;
  declare _driver: HybridDriver;

  /**
   * @param {object} [options]
   * @param {PlaybackClock} [options.clock]  injectable, for tests
   * @param {function} [options.now]         injectable clock, for tests
   */
  constructor({ clock, now }: { clock?: PlaybackClock; now?: () => number } = {}) {
    this._clock = clock || new PlaybackClock();
    this._now = now || (() => Date.now());
    this._content = null;         // the Spotify track the show is following
    this._session = null;         // the last OS media-session report
    this._sessionAt = 0;
    this._matched = false;
    this._mismatches = 0;
    this._driver = 'none';        // 'nowplaying' | 'spotify' | 'none'
  }

  get driver(): HybridDriver { return this._driver; }

  get matched(): boolean { return this._matched; }

  setContent(playing: NowPlaying | null | undefined): void {
    if (!playing || !playing.trackId) return;
    const changed = !this._content || this._content.trackId !== playing.trackId;
    this._content = playing;
    if (changed) {
      this._clock.reset();
      this._matched = false;
      this._mismatches = 0;
      this._driver = 'none';
      if (this._session) this._evaluateMatch();
    }
  }

  reset(): void {
    this._clock.reset();
    this._content = null;
    this._session = null;
    this._sessionAt = 0;
    this._matched = false;
    this._mismatches = 0;
    this._driver = 'none';
  }

  observeSession(playing: NowPlaying | null | undefined, at = this._now()): void {
    if (!playing) return;
    this._session = playing;
    this._sessionAt = at;
    const agrees = this._evaluateMatch();
    // Reject disagreeing positions even during match grace; they belong to another track.
    if (!this._matched || !agrees) return;
    this._driver = 'nowplaying';
    this._clock.observe(playing.progressMs, { isPlaying: playing.isPlaying, at });
  }

  observeContent(playing: NowPlaying | null | undefined, at = this._now()): void {
    // Unidentified content must not move the clock for the identified Spotify track.
    if (!playing || !playing.trackId) return;
    this.setContent(playing);
    if (this._sessionIsLive() && this._matched) return;
    this._driver = 'spotify';
    this._clock.observe(playing.progressMs, { isPlaying: playing.isPlaying, at, now: this._now() });
  }

  getPositionMs(now = this._now()): number {
    return this._clock.positionMs(now);
  }

  _sessionIsLive(): boolean {
    return !!this._session && (this._now() - this._sessionAt) < CLOCK_STALE_MS;
  }

  _evaluateMatch(): boolean {
    const agrees = tracksMatch(this._content, this._session);
    if (agrees) {
      // The triggering OS report follows immediately, so takeover can snap without a gap.
      if (!this._matched) this._clock.reset();
      this._matched = true;
      this._mismatches = 0;
      return true;
    }
    if (!this._matched) return false;
    if (++this._mismatches < MISMATCH_GRACE) return false;
    this._matched = false;
    this._mismatches = 0;
    this._driver = 'spotify';
    return false;
  }

  getStatus(): HybridStatus {
    const sessionLive = this._sessionIsLive();
    return {
      driver: this._driver,
      matched: this._matched,
      sessionLive,
      sessionApp: sessionLive && this._session ? (this._session.sourceApp || null) : null,
      sessionTrack: sessionLive && this._session
        ? `${this._session.artist} — ${this._session.name}` : null,
      contentTrack: this._content
        ? `${this._content.artist} — ${this._content.name}` : null,
      clock: this._clock.getStatus(),
    };
  }
}

export default HybridSource;
export { tracksMatch };
export { normalise };
export { CLOCK_STALE_MS };
export { MISMATCH_GRACE };