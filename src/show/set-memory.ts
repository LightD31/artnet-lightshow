/**
 * The night so far: what the show looked like on the tracks it has played.
 *
 * Every track is planned on its own, and on its own each plan is a good one.
 * Played back to back they can still be the same plan twice — two house
 * records an hour apart in the same palette, the same chase on every chorus,
 * a blinder on every drop from the first track to the last. A person running
 * the rig would not do that; they remember what they did ten minutes ago.
 * This is that memory, kept by the auto show and handed to the director with
 * each plan (see ShowDirector's `history`):
 *
 *   no repeats     the previous track's palette and the look each of its
 *                  sections opened on are not used again straight after
 *   key            a track that mixes harmonically out of the last one keeps
 *                  some of its colours; a key change the DJ did not blend is
 *                  free to change them all
 *   energy arc     how hard this track drives against the night so far. A
 *                  track hotter than the last few is a peak and gets the big
 *                  gestures; one that is not holds some back. The first
 *                  twenty minutes warm up.
 *
 * Only what the director needs is kept, a dozen tracks deep, and a track
 * starting more than an hour after the last one started begins a new set.
 * Nothing is saved to disk: a set is one night, and a restart forgets it.
 */

/** One track as the show played it. */
export interface TrackMemory {
  /** The analysis cache key, or anything else that names the track. */
  key: string;
  paletteName: string;
  palette: number[];
  /** The look each section role opened on. */
  looks: Record<string, string>;
  /** How hard the rig worked, 0..1 (ShowDirector's drive). */
  drive: number;
  /** The track's key as the analysis spells it, e.g. "A minor". */
  musicalKey: string | null;
  /** Did it spend a blinder. */
  blinder: boolean;
  /** When it started playing, ms. */
  at: number;
}

/** What the director is told about the night before this track. */
export interface SetHistory {
  /** The track played just before, or null at the start of a set. */
  previous: TrackMemory | null;
  /** The set's tracks before this one, oldest first. */
  recent: TrackMemory[];
  /** How long the set has been running, in minutes. */
  setMinutes: number;
}

/** A track starting this long after the last one started begins a new set. */
const SET_GAP_MS = 60 * 60 * 1000;
const KEEP = 12;

class SetMemory {
  declare _tracks: TrackMemory[];
  declare _now: () => number;

  constructor({ now = Date.now }: { now?: () => number } = {}) {
    this._tracks = [];
    this._now = now;
  }

  /**
   * Remember a track as it starts playing. The same track again straight
   * after — a replan, a restart after a seek — replaces its own entry
   * rather than counting twice.
   */
  record(entry: Omit<TrackMemory, 'at'> & { at?: number }): void {
    const at = entry.at ?? this._now();
    const last = this._tracks[this._tracks.length - 1];
    if (last && at - last.at > SET_GAP_MS) this._tracks = [];
    const track = { ...entry, at };
    if (last && last.key === entry.key && this._tracks.length) {
      this._tracks[this._tracks.length - 1] = { ...track, at: last.at };
    } else {
      this._tracks.push(track);
      if (this._tracks.length > KEEP) this._tracks.shift();
    }
  }

  /** The night before the track named `key`: every track of this set but it. */
  history(key: string | null = null): SetHistory {
    const now = this._now();
    const last = this._tracks[this._tracks.length - 1];
    if (!last || now - last.at > SET_GAP_MS) return { previous: null, recent: [], setMinutes: 0 };
    const recent = this._tracks.filter((t, i) => !(t.key === key && i === this._tracks.length - 1));
    return {
      previous: recent[recent.length - 1] ?? null,
      recent,
      setMinutes: recent.length ? Math.max(0, (now - recent[0].at) / 60000) : 0,
    };
  }

  get size(): number { return this._tracks.length; }

  reset(): void { this._tracks = []; }
}

// ── Keys ─────────────────────────────────────────────────────────────────────

const PITCHES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FLATS: Record<string, string> = { Db: 'C#', Eb: 'D#', Gb: 'F#', Ab: 'G#', Bb: 'A#' };

/**
 * A key on the Camelot wheel — the DJ's map of which keys mix: `{ number,
 * minor }`, 8A being A minor and 8B C major. Null for a key it cannot read.
 */
function camelot(key: string | null | undefined, scale?: string | null): { number: number; minor: boolean } | null {
  const text = String(key ?? '').trim();
  if (!text) return null;
  const [token, mode] = text.split(/[\s/|-]+/);
  const pitch = token[0].toUpperCase() + token.slice(1).replace(/[^#b]/g, '');
  const pc = PITCHES.indexOf(FLATS[pitch] || pitch);
  if (pc < 0) return null;
  const minor = /^min|^m$/i.test(mode || '') || /minor/i.test(String(scale ?? ''));
  // The relative major shares the number: A minor is C major's.
  const major = minor ? (pc + 3) % 12 : pc;
  return { number: ((major * 7 + 7) % 12) + 1, minor };
}

/**
 * Do two keys mix: the same key, its relative major or minor, or a fifth
 * either way (one step round the wheel)? Unknown keys are not a clash.
 */
function keysMix(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = camelot(a);
  const y = camelot(b);
  if (!x || !y) return false;
  if (x.number === y.number) return true;
  const step = Math.abs(x.number - y.number);
  return x.minor === y.minor && (step === 1 || step === 11);
}

// ── The energy arc ──────────────────────────────────────────────────────────

/** How this track sits in the night: what it may spend. */
export interface SetArc {
  /** Scales the accent budget. */
  budget: number;
  /** May a drop spend a blinder. */
  blinder: boolean;
  /** In words, for the operator. */
  reason: 'first' | 'warm-up' | 'peak' | 'breather' | 'level';
}

// The first stretch of a set warms up.
const WARM_UP_MINUTES = 20;
// How far this track has to drive above or below the last few to count as a
// peak or a breather, on the 0..1 drive scale.
const PEAK = 0.12;

/**
 * What this track may spend, from how it drives against the last few tracks.
 * A night is paced the way a track is: the big moments mean something only
 * against the ones that were held back.
 */
function arcFor(history: SetHistory | null | undefined, drive: number): SetArc {
  if (!history || !history.recent.length) return { budget: 1, blinder: true, reason: 'first' };
  const recent = history.recent.slice(-4);
  const mean = recent.reduce((sum, t) => sum + t.drive, 0) / recent.length;
  const delta = drive - mean;
  // A blinder at every drop of every track stops being one. Two tracks in a
  // row without one earns it back; a peak always has it.
  const blindersLately = history.recent.slice(-2).some((t) => t.blinder);
  if (delta >= PEAK) return { budget: 1.15, blinder: true, reason: 'peak' };
  if (history.setMinutes < WARM_UP_MINUTES) return { budget: 0.85, blinder: !blindersLately, reason: 'warm-up' };
  if (delta <= -PEAK) return { budget: 0.9, blinder: !blindersLately, reason: 'breather' };
  return { budget: 1, blinder: !blindersLately, reason: 'level' };
}

export { SetMemory, SET_GAP_MS, camelot, keysMix, arcFor, WARM_UP_MINUTES };
