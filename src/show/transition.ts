/**
 * How the lights follow a DJ from one track into the next.
 *
 * The CDJs say when the mix happened: which deck went on air, and how long
 * both were audible together (src/prolink.ts). The incoming track's analysis
 * says where in it the DJ has come in. Between them they answer what a
 * lighting operator watching the mix would do:
 *
 *   a cut        the DJ slammed the fader across, or cut on the beat: the
 *                room changes at once
 *   the drop     the incoming track drops within the next few seconds: the
 *                look blends until then and the drop lands on its own, as a
 *                cut, which is the moment the DJ lined the mix up for
 *   the phrase   otherwise the blend ends where the incoming track's next
 *                phrase starts — its next section, or its next eight bars —
 *                so the new look arrives on a bar line the music is also
 *                turning over on
 *   hot          the DJ brought the new track in already in its chorus or
 *                drop: a bar's blend and no more
 *   a blend      no analysis to read yet: two bars of the incoming tempo, as
 *                before
 *
 * The fade can be at most ten seconds, the most a look change can fade over.
 * Anything further away than that is not what the mix was lined up for.
 */

import { list, finite } from './score.ts';
import type { Analysis } from './score.ts';

export interface Transition {
  fadeMs: number;
  reason: 'cut' | 'drop' | 'phrase' | 'hot' | 'blend';
}

/** What the CDJs said about the change (see prolink.ts TrackChange). */
export interface MixChange {
  handoff: boolean;
  overlapMs: number;
}

/** The longest a look may fade over (the patch schema's cap). */
const MAX_FADE_MS = 10000;
// Shorter than this overlap is a cut, not a blend.
const CUT_BEATS = 4;
// A blend with nothing else to go on.
const BLEND_BEATS = 8;
// A phrase boundary nearer than this is too soon to blend towards; the next
// one is the one.
const MIN_PHRASE_BARS = 2;
const PHRASE_BARS = 8;
const HOT_ROLES = new Set(['chorus', 'drop']);

/**
 * @param analysis    the incoming track's, or null when it has none yet
 * @param positionMs  where the incoming deck is in it
 * @param bpm         the tempo the DJ is playing it at (the CDJ's), or 0
 */
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

  // The track's own seconds run at its own tempo; the DJ may be playing it
  // faster or slower. Time on the deck is track time over that ratio.
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

  // The next phrase: a section start, or every eighth bar of the section the
  // deck is in, whichever comes first — and not so soon the blend is a blink.
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
