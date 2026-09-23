/**
 * The musical clock as the engine's worker thread sees it.
 *
 * The Conductor lives on the main thread, next to everything it listens to —
 * the auto show's position, the CDJs, the playing track. Once a frame the main
 * thread reads it and posts the reading across, stamped with when it was taken
 * (on the process-wide clock, see frame-clock.js). The worker renders a few
 * milliseconds later, and keeps rendering when the main thread is busy and a
 * reading is late, so it carries the last one forward at its tempo.
 *
 * Carried forward, a reading lands a hair away from where the next real one
 * says the music is. Forward is harmless. Backward is not: a chase whose step
 * boundary falls in that hair would show the next step, then the last, then
 * the next again — a one-frame flicker on the beat. So within an epoch the
 * position never steps back by less than the Conductor's own threshold for a
 * real jump; it holds until the music catches up. A new epoch — a seek, a new
 * track — is taken as it comes.
 */

import { BACKWARD_JUMP_BEATS } from './conductor.ts';
import type { MusicalTime } from './conductor.ts';

/** A Conductor reading as posted to the worker; `moving: false` is a held clock. */
export type PostedReading = MusicalTime & { moving?: boolean };

export interface ClockFollower {
  push(reading: PostedReading | null | undefined, at: number): void;
  at(t: number): MusicalTime | null;
}

function createClockFollower({ backwardJump = BACKWARD_JUMP_BEATS } = {}): ClockFollower {
  let sample: (PostedReading & { at: number }) | null = null;   // the latest reading, and when it was taken
  let last: { beatPos: number; epoch: number } | null = null;    // what was last handed out

  return {
    /** A reading from the Conductor, taken at `at` on the shared clock. */
    push(reading, at) {
      if (!reading || !Number.isFinite(reading.beatPos) || !Number.isFinite(at)) return;
      sample = { ...reading, at };
    },

    /** Where the music is at `t`, or null before the first reading. */
    at(t) {
      if (!sample) return null;
      const moving = sample.moving !== false;
      let beatPos = sample.beatPos + (moving ? (Math.max(0, t - sample.at) / 60000) * sample.bpm : 0);
      if (last && last.epoch === sample.epoch && beatPos < last.beatPos && last.beatPos - beatPos < backwardJump) {
        beatPos = last.beatPos;
      }
      last = { beatPos, epoch: sample.epoch };
      const reading: MusicalTime = { beatPos, bpm: sample.bpm, source: sample.source, epoch: sample.epoch };
      if (sample.anchorBeat !== undefined && Number.isFinite(sample.anchorBeat)) reading.anchorBeat = sample.anchorBeat;
      return reading;
    },
  };
}

export {
  createClockFollower,
};
