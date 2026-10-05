/**
 * What the engine and its worker thread say to each other (see engine.ts and
 * engine-worker.ts). Types only: one declaration of the protocol, so the two
 * sides cannot drift.
 */

import type { MusicalTime } from './conductor.ts';
import type { PostedReading } from './clock-follow.ts';
import type { FrameSummary } from './frame-clock.ts';
import type { BaseIntent, CommandResult, RenderInput } from './renderer.ts';
import type { TransmitConfig } from './transmit.ts';
import type { SharedUniverses } from './universes.ts';
import type { Profile } from '../types/rig.ts';
import type { SequenceTable } from '../shared/effects/sequence.ts';

/** Handed to the worker when it starts. */
export interface EngineWorkerData {
  shared: SharedUniverses;
  /** The frame grid's origin, on the process-wide clock. */
  epochMs?: number;
  periodMs?: number;
  /** Tests: render only on request, with seeded dice. */
  capture?: boolean;
  seed?: number | null;
  startNow?: number | null;
}

/** The universes' bytes after a requested frame; null for one just retired. */
export type RenderedFrames = Record<number, number[] | null>;

export type ToWorker =
  | { type: 'profiles'; profiles: Profile[] }
  | { type: 'snapshot'; at: number; input: RenderInput; reading: PostedReading; outputs: TransmitConfig }
  /**
   * Tests: `gridOriginMs` places the capture's frames on a grid, as the live
   * ticker's are; `table`, when given, is the sequence's clip table from this frame on.
   */
  | { type: 'render'; id: number; input: RenderInput; reading: MusicalTime; now: number; gridOriginMs?: number; table?: SequenceTable | null }
  /** The loaded sequence's clip table, sent when its revision changes and to every new worker; null for none. */
  | { type: 'sequence'; table: SequenceTable | null }
  /** A command for the base effect, decided at the next frame (renderer.ts Renderer.command). */
  | { type: 'command'; seq: number; cmd: string; arg?: unknown; intent?: BaseIntent | null }
  | { type: 'stop' };

export type FromWorker =
  | { type: 'ready' }
  | { type: 'frame' }
  | { type: 'stats'; stats: FrameSummary }
  | { type: 'stopped' }
  /** The commands the renderer decided, and the highest sequences it has decided and applied. */
  | { type: 'commands'; results: CommandResult[]; processed: number; applied: number }
  | { type: 'rendered'; id: number; frames: RenderedFrames; commands?: CommandResult[] };
