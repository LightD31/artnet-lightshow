import type { BeatGridEntry, SongStructure } from './prolink.ts';
import type { Analysis } from './show/score.ts';

/**
 * rekordbox's reading of a track, folded into the analyser's.
 *
 * When a CDJ track's own file has been analysed, the DJ's rekordbox has
 * already said two things about the very same file that the show should hear
 * from it rather than guess:
 *
 *   the beat grid   the beats the deck counts, shows, and syncs to — often
 *                   corrected by hand. The show's clock (see conductor.ts)
 *                   then steps on the beats the DJ sees, and the phrases below
 *                   land on them.
 *   the phrases     rekordbox's phrase analysis (PSSI): intro, verse, chorus,
 *                   up, down, bridge, outro, on bar lines, in one of three
 *                   moods — `high` for club tracks, `mid` and `low` for songs.
 *
 * Only the grid and the sections are replaced. Everything measured from the
 * audio — energy, stems, drops, build-ups, the events — stays the analyser's,
 * and each new section takes its energy and level from the analysed sections
 * it overlaps.
 */

/** A section role, by rekordbox mood and phrase kind. */
const ROLE_BY_KIND: Record<SongStructure['mood'], Record<number, { role: string; name: string }>> = {
  // A club track: Up builds, Down breaks it down, and Chorus is the drop.
  high: {
    1: { role: 'intro', name: 'Intro' },
    2: { role: 'verse', name: 'Up' },
    3: { role: 'breakdown', name: 'Down' },
    5: { role: 'drop', name: 'Chorus' },
    6: { role: 'outro', name: 'Outro' },
  },
  mid: {
    1: { role: 'intro', name: 'Intro' },
    2: { role: 'verse', name: 'Verse 1' },
    3: { role: 'verse', name: 'Verse 2' },
    4: { role: 'verse', name: 'Verse 3' },
    5: { role: 'verse', name: 'Verse 4' },
    6: { role: 'verse', name: 'Verse 5' },
    7: { role: 'verse', name: 'Verse 6' },
    8: { role: 'bridge', name: 'Bridge' },
    9: { role: 'chorus', name: 'Chorus' },
    10: { role: 'outro', name: 'Outro' },
  },
  // Three kinds to each verse: rekordbox tells them apart, but calls them one.
  low: {
    1: { role: 'intro', name: 'Intro' },
    2: { role: 'verse', name: 'Verse 1' },
    3: { role: 'verse', name: 'Verse 1' },
    4: { role: 'verse', name: 'Verse 1' },
    5: { role: 'verse', name: 'Verse 2' },
    6: { role: 'verse', name: 'Verse 2' },
    7: { role: 'verse', name: 'Verse 2' },
    8: { role: 'bridge', name: 'Bridge' },
    9: { role: 'chorus', name: 'Chorus' },
    10: { role: 'outro', name: 'Outro' },
  },
};

// Fewer beats than this is a grid rekordbox never finished.
const MIN_GRID_BEATS = 16;

type Section = NonNullable<Analysis['segments']>[number];

/** The grid's beats in seconds, or null for a grid not worth trusting. */
function gridSeconds(grid: readonly BeatGridEntry[] | null | undefined): number[] | null {
  if (!Array.isArray(grid) || grid.length < MIN_GRID_BEATS) return null;
  const beats: number[] = [];
  for (const b of grid) {
    const t = Number(b && b.offset) / 1000;
    if (!Number.isFinite(t) || t < 0) return null;
    if (beats.length && t <= beats[beats.length - 1]) return null;
    beats.push(t);
  }
  return beats;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** The analysed beat nearest each of `beats`, for carrying strengths across. */
function nearestIndex(sorted: readonly number[], t: number): number {
  let lo = 0;
  let hi = sorted.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < t) lo = mid + 1; else hi = mid;
  }
  if (lo > 0 && Math.abs(sorted[lo - 1] - t) <= Math.abs(sorted[lo] - t)) return lo - 1;
  return lo;
}

/**
 * Sections from rekordbox's phrases, each measured from the analysed sections
 * it overlaps: their energy and features, weighted by time, and the level of
 * the one it overlaps most.
 */
function phraseSections(structure: SongStructure, beats: number[], duration: number, analysed: readonly Section[]): Section[] | null {
  const table = ROLE_BY_KIND[structure.mood];
  if (!table) return null;
  const at = (beat: number) => {
    const i = Math.round(beat) - 1;
    if (i < 0) return 0;
    if (i < beats.length) return beats[i];
    const interval = beats[beats.length - 1] - beats[beats.length - 2];
    return beats[beats.length - 1] + (i - beats.length + 1) * interval;
  };
  const phrases = [...structure.phrases].filter((p) => Number.isFinite(p.beat) && p.beat >= 1).sort((a, b) => a.beat - b.beat);
  if (!phrases.length) return null;

  const out: Section[] = [];
  phrases.forEach((phrase, i) => {
    const kind = table[phrase.kind];
    const start = i === 0 ? 0 : at(phrase.beat);
    const next = phrases[i + 1];
    // The last phrase runs to the track's end: rekordbox stops phrasing at
    // `endBeat`, and what follows is mostly the tail of the outro.
    const end = next ? at(next.beat) : Math.max(duration, at(structure.endBeat || phrase.beat));
    if (!(end > start)) return;
    const name = kind ? kind.name : phrase.phraseType || `Phrase ${phrase.kind}`;
    out.push({
      ...measure(start, end, analysed),
      start: round3(start),
      end: round3(end),
      // One identity per phrase type, as rekordbox names it: its second
      // Chorus is a return of its first.
      label: `rekordbox:${name}`,
      role: kind ? kind.role : 'unknown',
      confidence: 1,
    });
  });
  return out.length ? out : null;
}

const round3 = (t: number) => Math.round(t * 1000) / 1000;

const MEASURES = ['energy', 'brightness', 'bass', 'rhythmic', 'vocal'] as const;

function measure(start: number, end: number, analysed: readonly Section[]): Pick<Section, 'energy' | 'level'> & Partial<Section> {
  const sums: Record<string, number> = {};
  const weights: Record<string, number> = {};
  let bestOverlap = 0;
  let level: Section['level'] = 'mid';
  for (const s of analysed) {
    const overlap = Math.min(end, Number(s.end)) - Math.max(start, Number(s.start));
    if (!(overlap > 0)) continue;
    for (const k of MEASURES) {
      const v = Number(s[k]);
      if (!Number.isFinite(v)) continue;
      sums[k] = (sums[k] || 0) + v * overlap;
      weights[k] = (weights[k] || 0) + overlap;
    }
    if (overlap > bestOverlap) { bestOverlap = overlap; level = s.level; }
  }
  const out: Record<string, number> = {};
  for (const k of MEASURES) if (weights[k]) out[k] = Math.round((sums[k] / weights[k]) * 1000) / 1000;
  return { energy: 0, ...out, level };
}

/**
 * The analysis with rekordbox's grid, and its phrases when it has them, in
 * place of the analyser's. Unchanged without a usable grid.
 */
function applyRekordbox(analysis: Analysis, { beatGrid, songStructure }:
  { beatGrid?: readonly BeatGridEntry[] | null; songStructure?: SongStructure | null }): Analysis {
  const out: Analysis = { ...analysis };
  const beats = gridSeconds(beatGrid);
  if (beats && beatGrid) {
    const analysedBeats = Array.isArray(analysis.beats) ? analysis.beats : [];
    const strengths = Array.isArray(analysis.beatStrengths) ? analysis.beatStrengths : [];
    out.beats = beats.map(round3);
    out.downbeats = beatGrid.filter((b) => b.count === 1).map((b) => round3(b.offset / 1000));
    out.meter = 4;
    // Set by hand as often as not, and what the deck itself counts bars by.
    out.downbeatConfidence = 0.9;
    const bpms = beatGrid.map((b) => b.bpm).filter((b) => b >= 40 && b <= 300);
    if (bpms.length) out.bpm = Math.round(median(bpms) * 10) / 10;
    // Each beat keeps the strength the analyser heard at the beat nearest it.
    if (analysedBeats.length === strengths.length && analysedBeats.length) {
      out.beatStrengths = beats.map((t) => strengths[nearestIndex(analysedBeats, t)]);
    } else {
      delete out.beatStrengths;
    }
    out.beatSource = 'rekordbox';
  }
  // Phrases are counted in rekordbox's beats, so without its grid there is
  // nothing to place them on.
  if (songStructure && beats) {
    const sections = phraseSections(songStructure, beats, Number(analysis.duration) || 0, analysis.segments || []);
    if (sections) {
      out.segments = sections;
      out.sectionSource = 'rekordbox';
      out.phraseMood = songStructure.mood;
    }
  }
  return out;
}

export { applyRekordbox, ROLE_BY_KIND };
