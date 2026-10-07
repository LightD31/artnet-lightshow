import SmtcReader from './smtc-source.ts';
import MprisReader from './mpris-source.ts';
import type { NowPlaying } from './types/playback.ts';

export interface OsNowPlaying {
  onUpdate(fn: ((playing: NowPlaying) => void) | null): void;
  onIdle(fn: (() => void) | null): void;
  start(): boolean;
  stop(): void;
}

export function osNowPlayingKind(platform: NodeJS.Platform = process.platform): 'SMTC' | 'MPRIS' | null {
  if (platform === 'win32') return 'SMTC';
  if (platform === 'darwin') return null;
  return 'MPRIS';
}

export function createOsNowPlaying(platform: NodeJS.Platform = process.platform): OsNowPlaying {
  return osNowPlayingKind(platform) === 'MPRIS' ? new MprisReader() : new SmtcReader();
}
