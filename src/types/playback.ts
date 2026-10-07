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

export interface QueuedTrack {
  name: string;
  artist: string;
  isrc: string | null;
  durationMs: number;
  trackId?: string | null;
}

export type PlayingListener = (playing: NowPlaying) => void;

export interface PlaybackSource {
  readonly configured: boolean;
  readonly authenticated: boolean;
  getCurrentlyPlaying(): Promise<NowPlaying | null>;
  onTrackChange(fn: PlayingListener | null): void;
}
