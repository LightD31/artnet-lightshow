'use strict';

/**
 * Deezer source — driven by the Firefox extension (browser-extension/).
 *
 * The Deezer JS SDK is dead (no obtainable DEEZER_APP_ID), so instead the
 * extension reads the Deezer web player's internal state (window.dzPlayer) and
 * POSTs it here. Unlike the generic SMTC now-playing source, this knows
 * everything the web player knows: the exact track ISRC (→ exact-audio download
 * via src/deezer.js), album art, position, AND the upcoming queue (→ prefetch).
 *
 * Mirrors the SpotifyClient/NowPlayingSource "currently playing" shape so the
 * downstream auto-show pipeline is shared. `authenticated` is true while the
 * extension is actively reporting — it fades after STALE_MS so closing the
 * Deezer tab cleanly drops Deezer as an available auto-source.
 */
const STALE_MS = 10000;

class DeezerSource {
  constructor() {
    this._playing = null;
    this._currentTrackId = null;
    this._queue = [];
    this._lastUpdateAt = 0;
    this._onTrackChange = null;
    this._onPlaybackUpdate = null;
  }

  /** Always "configured" — no server-side key; the extension does the work. */
  get configured() { return true; }

  /** Authenticated = the extension is actively reporting playback. */
  get authenticated() {
    return !!(this._playing && Date.now() - this._lastUpdateAt < STALE_MS);
  }

  /** Apply a current-track update pushed from the extension. */
  updatePlayback(payload) {
    if (!payload) return;
    const name = payload.name || payload.title || '';
    const artist = payload.artist || '';
    if (!name && !payload.trackId) return;
    const trackId = String(payload.trackId || payload.isrc || `${artist}|${name}`);
    const playing = {
      trackId,
      name,
      artist,
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

  /** Replace the upcoming queue (used for prefetch). */
  updateQueue(tracks) {
    this._queue = (Array.isArray(tracks) ? tracks : [])
      .map((t) => (t ? {
        name: t.name || t.title || '',
        artist: t.artist || '',
        isrc: t.isrc || null,
        durationMs: Number(t.durationMs) || 0,
      } : null))
      .filter((t) => t && t.name && t.artist);
  }

  getQueue() { return this._queue; }

  /** Same shape as SpotifyClient.getCurrentlyPlaying() — used by analyze route. */
  async getCurrentlyPlaying() {
    if (!this.authenticated) return null;
    return this._playing;
  }

  onTrackChange(fn) { this._onTrackChange = fn; }
  onPlaybackUpdate(fn) { this._onPlaybackUpdate = fn; }

  /** Clear playback + queue — called when the Deezer tab disconnects. */
  disconnect() {
    this._playing = null;
    this._currentTrackId = null;
    this._queue = [];
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
      albumArt: live && this._playing ? this._playing.albumArt : null,
      isPlaying: live && this._playing ? this._playing.isPlaying : false,
      queueLength: this._queue.length,
    };
  }
}

module.exports = DeezerSource;
