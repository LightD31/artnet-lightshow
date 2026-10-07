// End blends at incoming musical boundaries so the new look lands with the track.

import { list, finite } from './score.ts';
import type { Analysis } from './score.ts';

export interface Transition {
  fadeMs: number;
  reason: 'cut' | 'drop' | 'phrase' | 'hot' | 'blend';
}

export interface MixChange {
  handoff: boolean;
  overlapMs: number;
}

const MAX_FADE_MS = 10000;
const CUT_BEATS = 4;
const BLEND_BEATS = 8;
const MIN_PHRASE_BARS = 2;
const PHRASE_BARS = 8;
const HOT_ROLES = new Set(['chorus', 'drop']);

function transitionFor({ analysis, positionMs, bpm, change }: {
  analysis: Analysis | null | undefined;
  positionMs: number;
  bpm: number;
  change: MixChange | null | undefined;
}): Transition {
  if (!change || !change.handoff) return { fadeMs: 0, reason: 'cut' };
  const tempo = bpm > 0 ? bpm : finite(analysis?.bpm, 120) || 120;
  const beatMs = 60000 / tempo;
  if (change.overlapMs < CUT_BEATS * beatMs) return { fadeMs: 0, reason: 'cut' };
  const blend: Transition = { fadeMs: Math.min(MAX_FADE_MS, Math.round(BLEND_BEATS * beatMs)), reason: 'blend' };
  if (!analysis || !Number.isFinite(positionMs)) return blend;

  const rate = tempo / (finite(analysis.bpm, tempo) || tempo);
  const pos = positionMs / 1000;
  const until = (t: number) => Math.round(((t - pos) * 1000) / rate);

  const drop = list(analysis.drops).map((d) => finite(d.t, NaN))
    .filter((t) => Number.isFinite(t) && t >= pos)
    .sort((a, b) => a - b)[0];
  if (drop !== undefined && until(drop) <= MAX_FADE_MS) return { fadeMs: Math.max(0, until(drop)), reason: 'drop' };

  const sections = list(analysis.segments || analysis.structure?.sections);
  const here = sections.find((s) => pos >= finite(s.start) && pos < finite(s.end));
  if (here && HOT_ROLES.has(String(here.role))) return { fadeMs: Math.round(4 * beatMs), reason: 'hot' };

  const downbeats = list(analysis.downbeats).map((t) => finite(t));
  const barSec = downbeats.length >= 2 ? (downbeats[downbeats.length - 1] - downbeats[0]) / (downbeats.length - 1) : (4 * 60) / tempo;
  const earliest = pos + MIN_PHRASE_BARS * barSec;
  const marks: number[] = sections.map((s) => finite(s.start)).filter((t) => t >= earliest);
  if (here && downbeats.length) {
    const from = downbeats.findIndex((t) => t >= finite(here.start) - barSec / 2);
    if (from >= 0) {
      for (let i = from; i < downbeats.length; i += PHRASE_BARS) if (downbeats[i] >= earliest) { marks.push(downbeats[i]); break; }
    }
  }
  const phrase = marks.sort((a, b) => a - b)[0];
  if (phrase !== undefined && until(phrase) <= MAX_FADE_MS) return { fadeMs: until(phrase), reason: 'phrase' };
  return blend;
}

export { transitionFor, MAX_FADE_MS };
