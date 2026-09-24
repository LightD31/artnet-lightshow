/**
 * The analysis's `pulse` block, read at the playback position: what an LED bar
 * shows inside the beat.
 *
 * The analyser keeps each stem's level fifty times a second and the time of
 * every kick, snare and hat (src/analysis/pulse.py). This decodes that once per
 * track and answers, for any moment, how loud each stem is — interpolated
 * between its 20 ms points — and how recently each drum was hit: its strength
 * on the hit, decaying after it the way the sound does, a kick slower than a
 * hat. The pixel patterns read the answer every frame (shared/patterns.ts).
 */

import type { Pulse } from '../types/analysis.ts';
import type { PulseReading } from '../types/rig.ts';

/** How fast each hit fades, ms to about a third: a kick rings, a hat ticks. */
const DECAY_MS: Record<'kick' | 'snare' | 'hats', number> = { kick: 110, snare: 90, hats: 45 };
const STEMS = ['drums', 'bass', 'vocals', 'other'] as const;

export interface PulseTrack {
  /** Whether the track was separated, so the stem levels are there. */
  readonly stems: boolean;
  at(positionMs: number): PulseReading;
}

/** Base64 to bytes, in Node and in a browser alike. */
function bytes(text: string): Uint8Array {
  const raw = atob(text);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

interface Hits { t: Float64Array; s: Float64Array }

function hits(lane: { t?: unknown; s?: unknown } | undefined): Hits {
  const t = Array.isArray(lane?.t) ? lane.t : [];
  const s = Array.isArray(lane?.s) ? lane.s : [];
  const n = Math.min(t.length, s.length);
  const times = new Float64Array(n);
  const strengths = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    times[i] = Number(t[i]) * 1000;
    strengths[i] = Math.max(0, Math.min(1, Number(s[i]) || 0));
  }
  return { t: times, s: strengths };
}

/** The last hit at or before `ms`, or -1. */
function lastHit(times: Float64Array, ms: number): number {
  let lo = 0;
  let hi = times.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= ms) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return found;
}

function hitLevel(lane: Hits, ms: number, decayMs: number): number {
  const i = lastHit(lane.t, ms);
  if (i < 0) return 0;
  return lane.s[i] * Math.exp(-(ms - lane.t[i]) / decayMs);
}

function level(envelope: Uint8Array, rate: number, ms: number): number {
  if (!envelope.length) return 0;
  const x = (ms / 1000) * rate;
  if (x <= 0) return envelope[0] / 255;
  const i = Math.floor(x);
  if (i >= envelope.length - 1) return envelope[envelope.length - 1] / 255;
  const f = x - i;
  return (envelope[i] * (1 - f) + envelope[i + 1] * f) / 255;
}

/** A track's pulse, or null when its analysis has none (or one this cannot read). */
function pulseTrack(block: Pulse | null | undefined): PulseTrack | null {
  if (!block || block.encoding !== 'u8-base64' || !(block.rate > 0) || !block.envelopes) return null;
  let envelopes: Record<string, Uint8Array>;
  try {
    envelopes = Object.fromEntries(Object.entries(block.envelopes)
      .filter(([, text]) => typeof text === 'string')
      .map(([name, text]) => [name, bytes(text)]));
  } catch {
    return null;
  }
  if (!envelopes.mix) return null;
  const lanes = block.lanes || {};
  const kick = hits(lanes.kick);
  const snare = hits(lanes.snare);
  const hats = hits(lanes.hats);
  const rate = block.rate;
  const stems = STEMS.every((name) => envelopes[name]);
  return {
    stems,
    at(positionMs: number): PulseReading {
      const ms = Number.isFinite(positionMs) ? positionMs : 0;
      const out: PulseReading = {
        mix: level(envelopes.mix, rate, ms),
        kick: hitLevel(kick, ms, DECAY_MS.kick),
        snare: hitLevel(snare, ms, DECAY_MS.snare),
        hats: hitLevel(hats, ms, DECAY_MS.hats),
      };
      if (stems) for (const name of STEMS) out[name] = level(envelopes[name], rate, ms);
      return out;
    },
  };
}

export { pulseTrack, DECAY_MS };
