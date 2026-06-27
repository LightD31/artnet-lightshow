'use strict';

/**
 * Generic "now playing" source.
 *
 * Holds the most recent playback snapshot reported by the OS media session
 * (see src/smtc-source.js on Windows), exposing the same shape the rest of the
 * server uses for "currently playing" sources (Spotify, prolink, etc). It is
 * player-agnostic: anything that reports to the system media controls (Deezer,
 * Tidal, YouTube, a browser tab, a desktop app…) drives the auto-show.
 *
 * `authenticated` is true while we have a fresh playback update — it fades to
 * false once `STALE_MS` has elapsed without one, so when playback stops the
 * source cleanly drops out as an available auto-source.
 */
const STALE_MS = 10000;

class NowPlayingSource {
  constructor() {
    this._playing = null;         // last full playback snapshot
    this._currentTrackId = null;
    this._lastUpdateAt = 0;
    this._onTrackChange = null;
    this._onPlaybackUpdate = null;
  }

  /** Always "configured" — there's no server-side key required. */
  get configured() { return true; }

  /** Authenticated = something is actively reporting playback. */
  get authenticated() {
    return !!(this._playing && Date.now() - this._lastUpdateAt < STALE_MS);
  }

  /**
   * Apply a playback update. Mirrors the fields SpotifyClient.getCurrentlyPlaying()
   * returns so downstream code is shared.
   */
  updatePlayback(payload) {
    if (!payload || !payload.trackId) return;
    const playing = {
      trackId: String(payload.trackId),
      name: payload.name || '',
      artist: payload.artist || '',
      album: payload.album || '',
      albumArt: payload.albumArt || null,
      durationMs: Number(payload.durationMs) || 0,
      progressMs: Number(payload.progressMs) || 0,
      isPlaying: !!payload.isPlaying,
      isrc: payload.isrc || null,
    };
    this._playing = playing;
    this._lastUpdateAt = Date.now();

    if (this._onPlaybackUpdate) this._onPlaybackUpdate(playing);

    if (playing.trackId !== this._currentTrackId) {
      this._currentTrackId = playing.trackId;
      if (this._onTrackChange) this._onTrackChange(playing);
    }
  }

  /** Same shape as SpotifyClient.getCurrentlyPlaying() — used by analyze route. */
  async getCurrentlyPlaying() {
    if (!this.authenticated) return null;
    return this._playing;
  }

  onTrackChange(fn) { this._onTrackChange = fn; }
  onPlaybackUpdate(fn) { this._onPlaybackUpdate = fn; }

  /** Clear any held playback state. */
  disconnect() {
    this._playing = null;
    this._currentTrackId = null;
    this._lastUpdateAt = 0;
  }

  getStatus() {
    const live = this.authenticated;
    return {
      configured: this.configured,
      authenticated: live,
      currentTrackId: this._currentTrackId,
      name: live && this._playing ? this._playing.name : null,
      artist: live && this._playing ? this._playing.artist : null,
      isPlaying: live && this._playing ? this._playing.isPlaying : false,
    };
  }
}

module.exports = NowPlayingSource;
