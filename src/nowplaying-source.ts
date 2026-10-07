import type { NowPlaying, PlaybackSource, PlaybackUpdate, PlayingListener } from './types/playback.ts';

const STALE_MS = 10000;

class NowPlayingSource implements PlaybackSource {
  declare _playing: NowPlaying | null;
  declare _currentTrackId: string | null;
  declare _lastUpdateAt: number;
  declare _onTrackChange: PlayingListener | null;
  declare _onPlaybackUpdate: PlayingListener | null;

  constructor() {
    this._playing = null;         // last full playback snapshot
    this._currentTrackId = null;
    this._lastUpdateAt = 0;
    this._onTrackChange = null;
    this._onPlaybackUpdate = null;
  }

  get configured(): boolean { return true; }

  get authenticated(): boolean {
    return !!(this._playing && Date.now() - this._lastUpdateAt < STALE_MS);
  }

  updatePlayback(payload: PlaybackUpdate | null | undefined): void {
    if (!payload || !payload.trackId) return;
    const playing: NowPlaying = {
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

  async getCurrentlyPlaying(): Promise<NowPlaying | null> {
    if (!this.authenticated) return null;
    return this._playing;
  }

  onTrackChange(fn: PlayingListener | null): void { this._onTrackChange = fn; }
  onPlaybackUpdate(fn: PlayingListener | null): void { this._onPlaybackUpdate = fn; }

  disconnect(): void {
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

export default NowPlayingSource;