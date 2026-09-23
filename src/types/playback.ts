/**
 * What is playing, as every playback source reports it: the shape Spotify's
 * client returns, which the browser extensions, the OS media session and the
 * hybrid source copy so the auto show can follow any of them.
 *
 * Types only.
 */

/** The track playing now, and where in it playback is. */
export interface NowPlaying {
  trackId: string;
  name: string;
  artist: string;
  album: string;
  albumArt: string | null;
  durationMs: number;
  progressMs: number;
  isPlaying: boolean;
  isrc: string | null;
  /** When `progressMs` was true, on the wall clock (Spotify: the round trip's middle). */
  sampledAt?: number;
  previewUrl?: string | null;
  /** The app the OS media session read it from. */
  sourceApp?: string | null;
}

/** A playback report as a client pushes it: any field may be missing or loosely typed. */
export interface PlaybackUpdate {
  trackId?: string | number | null;
  name?: string;
  title?: string;
  artist?: string;
  album?: string;
  albumArt?: string | null;
  durationMs?: number | string;
  progressMs?: number | string;
  isPlaying?: boolean;
  isrc?: string | null;
}

/** A track waiting in a player's queue. */
export interface QueuedTrack {
  name: string;
  artist: string;
  isrc: string | null;
  durationMs: number;
  trackId?: string | null;
}

/** Called with what is playing. */
export type PlayingListener = (playing: NowPlaying) => void;

/** Something the auto show can follow. */
export interface PlaybackSource {
  readonly configured: boolean;
  readonly authenticated: boolean;
  getCurrentlyPlaying(): Promise<NowPlaying | null>;
  onTrackChange(fn: PlayingListener | null): void;
}
