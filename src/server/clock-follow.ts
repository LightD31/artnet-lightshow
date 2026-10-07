// Hold small backwards corrections within an epoch so worker interpolation cannot replay a step boundary.

import { BACKWARD_JUMP_BEATS } from './conductor.ts';
import type { MusicalTime } from './conductor.ts';

export type PostedReading = MusicalTime & { moving?: boolean };

export interface ClockFollower {
  push(reading: PostedReading | null | undefined, at: number): void;
  at(t: number): MusicalTime | null;
}

function createClockFollower({ backwardJump = BACKWARD_JUMP_BEATS } = {}): ClockFollower {
  let sample: (PostedReading & { at: number }) | null = null;   // the latest reading, and when it was taken
  let last: { beatPos: number; epoch: number } | null = null;    // what was last handed out

  return {
    push(reading, at) {
      if (!reading || !Number.isFinite(reading.beatPos) || !Number.isFinite(at)) return;
      sample = { ...reading, at };
    },

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
