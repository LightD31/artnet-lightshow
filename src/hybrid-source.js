'use strict';

/**
 * Hybrid playback source: the OS media session for *when*, Spotify for *what*.
 *
 * Neither source is good at both halves of the job.
 *
 *   Spotify's Web API knows exactly what is playing — the track id, the ISRC
 *   the analyser needs to fetch the right audio, the real duration, and the
 *   upcoming queue, which is what lets the next few tracks be analysed before
 *   anyone hears them. What it is bad at is *where* playback is: it answers
 *   about once a second, over the network, with a `progress_ms` that was
 *   already a round trip old when it was measured.
 *
 *   The OS media session (SMTC on Windows) is the mirror image. It is read
 *   locally with no network in the path, so its position is both fresher and
 *   far steadier — but it exposes no track id and no ISRC, only the artist and
 *   title strings the player chose to publish, which is not enough to fetch the
 *   right recording or to see what is coming next.
 *
 * So this class takes each from the source that has it, and spends its own
 * complexity on the one question that arises from splitting them: is the
 * session the OS is reporting actually the track Spotify says is playing? When
 * it is, its position drives the show. When it is not — a different app took
 * over the media keys, the OS session is stale, someone is playing something
 * else on another device — the clock falls back to Spotify's own reports, which
 * is exactly the behaviour of the plain Spotify source. There is no state in
 * which this source is worse than the one it extends.
 *
 * Both paths run through a `PlaybackClock`, which turns coarse jittery samples
 * into a monotonic clock; see src/playback-clock.js for why that matters more
 * than the choice of source.
 */

const PlaybackClock = require('./playback-clock');

// How long an OS-session report stays usable. It arrives about twice a second,
// so a second and a half without one means the reader has stopped or the
// session has gone.
const CLOCK_STALE_MS = 1500;

// Durations agreeing this closely is strong evidence two reports are the same
// recording. Players round to the second and can disagree on trailing silence,
// so this is deliberately not tight.
const DURATION_TOLERANCE_MS = 2500;

// How many consecutive mismatching reports it takes to hand the clock back to
// Spotify. One is too few: the OS session and the Spotify API do not change
// track on the same tick, so every track change would flap the clock over and
// back for a poll or two.
const MISMATCH_GRACE = 3;


/** Strip a title or artist down to something two players might agree on. */
function normalise(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')   // combining marks left by NFD
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Do two playback reports describe the same recording?
 *
 * Deliberately conservative about *titles* and generous about everything else.
 * A remix and its original share an artist and often a duration, so the title
 * has to agree; but one player writing "Song" where the other writes
 * "Song (feat. Someone)" is routine, so a prefix counts.
 *
 * Duration is the strongest single signal when both report one — it is a
 * property of the recording rather than of how a player chose to name it — so
 * agreement there stands in for an artist match, and disagreement past the
 * tolerance vetoes the whole thing.
 */
function tracksMatch(a, b) {
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
  /**
   * @param {object} [options]
   * @param {PlaybackClock} [options.clock]  injectable, for tests
   * @param {function} [options.now]         injectable clock, for tests
   */
  constructor({ clock, now } = {}) {
    this._clock = clock || new PlaybackClock();
    this._now = now || (() => Date.now());
    this._content = null;         // the Spotify track the show is following
    this._session = null;         // the last OS media-session report
    this._sessionAt = 0;
    this._matched = false;
    this._mismatches = 0;
    this._driver = 'none';        // 'nowplaying' | 'spotify' | 'none'
  }

  /** Which source is currently driving the clock. */
  get driver() { return this._driver; }

  /** Is the OS session reporting the track Spotify says is playing? */
  get matched() { return this._matched; }

  /**
   * The track the show is following, from Spotify.
   *
   * Resets the clock when the track changes: a new track's position has nothing
   * to do with the old one's, and slewing between them would run the new song
   * against the tail of the old timeline.
   */
  setContent(playing) {
    if (!playing || !playing.trackId) return;
    const changed = !this._content || this._content.trackId !== playing.trackId;
    this._content = playing;
    if (changed) {
      this._clock.reset();
      this._matched = false;
      this._mismatches = 0;
      this._driver = 'none';
      // Re-test immediately: on a track change the OS session has usually
      // already moved on, so the match can be re-established without waiting
      // for its next report.
      if (this._session) this._evaluateMatch();
    }
  }

  /** Forget everything. Used when the show stops or the source is switched away. */
  reset() {
    this._clock.reset();
    this._content = null;
    this._session = null;
    this._sessionAt = 0;
    this._matched = false;
    this._mismatches = 0;
    this._driver = 'none';
  }

  /**
   * A report from the OS media session. Drives the clock when it matches.
   *
   * `at` is when the sample was true rather than when it arrived; for a local
   * reader those are the same instant, which is much of why this path is better
   * than the Spotify one.
   */
  observeSession(playing, at = this._now()) {
    if (!playing) return;
    this._session = playing;
    this._sessionAt = at;
    this._evaluateMatch();
    if (!this._matched) return;
    this._driver = 'nowplaying';
    this._clock.observe(playing.progressMs, { isPlaying: playing.isPlaying, at });
  }

  /**
   * A report from Spotify. Carries the content either way, and drives the clock
   * only while the OS session is not available to do it better.
   */
  observeContent(playing, at = this._now()) {
    // No track id means the content is unidentified — an advert, a podcast, a
    // local file Spotify will not name. `setContent` already refuses it, and
    // the clock has to refuse it too: running the show against the position of
    // something we cannot identify is worse than not running it at all.
    if (!playing || !playing.trackId) return;
    this.setContent(playing);
    if (this._sessionIsLive() && this._matched) return;
    this._driver = 'spotify';
    this._clock.observe(playing.progressMs, { isPlaying: playing.isPlaying, at });
  }

  /** Where the show is now, in milliseconds. */
  getPositionMs(now = this._now()) {
    return this._clock.positionMs(now);
  }

  _sessionIsLive() {
    return !!this._session && (this._now() - this._sessionAt) < CLOCK_STALE_MS;
  }

  /**
   * Decide whether the OS session is the Spotify track, with hysteresis in the
   * direction that matters. Matching engages at once; unmatching takes a few
   * consecutive disagreements, because the two sources never change track on
   * the same tick and a single-report test would hand the clock back and forth
   * across every track boundary.
   */
  _evaluateMatch() {
    const agrees = tracksMatch(this._content, this._session);
    if (agrees) {
      if (!this._matched) this._clock.reset();   // new clock source, new fix
      this._matched = true;
      this._mismatches = 0;
      return;
    }
    if (!this._matched) return;
    if (++this._mismatches < MISMATCH_GRACE) return;
    this._matched = false;
    this._mismatches = 0;
    this._clock.reset();
    this._driver = 'spotify';
  }

  /** A snapshot for the UI: which half is doing what, and how well. */
  getStatus() {
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

module.exports = HybridSource;
module.exports.tracksMatch = tracksMatch;
module.exports.normalise = normalise;
module.exports.CLOCK_STALE_MS = CLOCK_STALE_MS;
module.exports.MISMATCH_GRACE = MISMATCH_GRACE;
