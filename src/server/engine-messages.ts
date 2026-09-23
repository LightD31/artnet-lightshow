/**
 * What the engine and its worker thread say to each other (see engine.ts and
 * engine-worker.ts). Types only: one declaration of the protocol, so the two
 * sides cannot drift.
 */

import type { MusicalTime } from './conductor.ts';
import type { PostedReading } from './clock-follow.ts';
import type { FrameSummary } from './frame-clock.ts';
import type { RenderInput } from './renderer.ts';
import type { TransmitConfig } from './transmit.ts';
import type { SharedUniverses } from './universes.ts';
import type { Profile } from '../types/rig.ts';

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
  | { type: 'render'; id: number; input: RenderInput; reading: MusicalTime; now: number }
  | { type: 'stop' };

export type FromWorker =
  | { type: 'ready' }
  | { type: 'frame' }
  | { type: 'stats'; stats: FrameSummary }
  | { type: 'stopped' }
  | { type: 'rendered'; id: number; frames: RenderedFrames };
