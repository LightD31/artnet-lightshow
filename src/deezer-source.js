'use strict';

/**
 * Browser-driven Deezer player source.
 *
 * Unlike SpotifyClient (which polls Spotify's Web API from the server), the
 * Deezer player lives in the browser via Deezer's JS SDK. The web client
 * forwards playback updates over socket.io and this module just holds the
 * most recent snapshot, exposing the same shape the rest of the server uses
 * for "currently playing" sources (Spotify, prolink, etc).
 *
 * `authenticated` is true while we have a fresh playback update — it fades to
 * false once `STALE_MS` has elapsed without one, so disconnecting a browser
 * tab cleanly removes Deezer as an available auto-source.
 */
const STALE_MS = 10000;

class DeezerSource {
  constructor() {
    this._playing = null;         // last full playback snapshot
    this._currentTrackId = null;
    this._lastUpdateAt = 0;
    this._onTrackChange = null;
    this._onPlaybackUpdate = null;
  }

  /** Always "configured" — there's no server-side key required. */
  get configured() { return true; }

  /** Authenticated = browser is actively reporting playback. */
  get authenticated() {
    return !!(this._playing && Date.now() - this._lastUpdateAt < STALE_MS);
  }

  /**
   * Apply a playback update pushed from the browser. Mirrors the fields
   * SpotifyClient.getCurrentlyPlaying() returns so downstream code is shared.
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

  /** Clear any held playback state — called when the browser disconnects. */
  disconnect() {
    this._playing = null;
    this._currentTrackId = null;
    this._lastUpdateAt = 0;
  }

  getStatus() {
    return {
      configured: this.configured,
      authenticated: this.authenticated,
      currentTrackId: this._currentTrackId,
    };
  }
}

module.exports = DeezerSource;
