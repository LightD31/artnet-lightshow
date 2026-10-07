import type { MusicalTime } from './conductor.ts';
import type { PostedReading } from './clock-follow.ts';
import type { FrameSummary } from './frame-clock.ts';
import type { BaseIntent, CommandResult, RenderInput } from './renderer.ts';
import type { TransmitConfig } from './transmit.ts';
import type { SharedUniverses } from './universes.ts';
import type { Profile } from '../types/rig.ts';
import type { SequenceTable } from '../shared/effects/sequence.ts';

export interface EngineWorkerData {
  shared: SharedUniverses;
  epochMs?: number;
  periodMs?: number;
  capture?: boolean;
  seed?: number | null;
  startNow?: number | null;
}

export type RenderedFrames = Record<number, number[] | null>;

export type ToWorker =
  | { type: 'profiles'; profiles: Profile[] }
  | { type: 'snapshot'; at: number; input: RenderInput; reading: PostedReading; outputs: TransmitConfig }
  | { type: 'render'; id: number; input: RenderInput; reading: MusicalTime; now: number; gridOriginMs?: number; table?: SequenceTable | null }
  | { type: 'sequence'; table: SequenceTable | null }
  | { type: 'command'; seq: number; cmd: string; arg?: unknown; intent?: BaseIntent | null }
  | { type: 'stop' };

export type FromWorker =
  | { type: 'ready' }
  | { type: 'frame' }
  | { type: 'stats'; stats: FrameSummary }
  | { type: 'stopped' }
  | { type: 'commands'; results: CommandResult[]; processed: number; applied: number }
  | { type: 'rendered'; id: number; frames: RenderedFrames; commands?: CommandResult[] };
