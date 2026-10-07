import SmtcReader from './smtc-source.ts';
import MprisReader from './mpris-source.ts';
import type { NowPlaying } from './types/playback.ts';

/**
 * The operating system's own "now playing": the Windows media session (SMTC)
 * or, on Linux, the MPRIS players on the session bus. Both hand on the same
 * snapshots, so the setting that turns it on (`sources.smtc`, named when there
 * was only Windows) and everything downstream are the same on either.
 */

/** What main.ts and apply.ts need of a reader. */
export interface OsNowPlaying {
  onUpdate(fn: ((playing: NowPlaying) => void) | null): void;
  onIdle(fn: (() => void) | null): void;
  start(): boolean;
  stop(): void;
}

/** What this platform's session is called, or null where there is none to read (macOS). */
export function osNowPlayingKind(platform: NodeJS.Platform = process.platform): 'SMTC' | 'MPRIS' | null {
  if (platform === 'win32') return 'SMTC';
  if (platform === 'darwin') return null;
  return 'MPRIS';
}

/** The reader for this platform. One that is not there says so when started. */
export function createOsNowPlaying(platform: NodeJS.Platform = process.platform): OsNowPlaying {
  return osNowPlayingKind(platform) === 'MPRIS' ? new MprisReader() : new SmtcReader();
}
