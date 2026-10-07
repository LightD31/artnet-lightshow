// Remember recent looks and energy so independently planned tracks do not repeat the same show.

export interface TrackMemory {
  key: string;
  paletteName: string;
  palette: number[];
  looks: Record<string, string>;
  drive: number;
  musicalKey: string | null;
  blinder: boolean;
  at: number;
}

export interface SetHistory {
  previous: TrackMemory | null;
  recent: TrackMemory[];
  setMinutes: number;
}

const SET_GAP_MS = 60 * 60 * 1000;
const KEEP = 12;

class SetMemory {
  declare _tracks: TrackMemory[];
  declare _now: () => number;

  constructor({ now = Date.now }: { now?: () => number } = {}) {
    this._tracks = [];
    this._now = now;
  }

  // Replace an immediate replay’s entry so seeking or replanning does not count the track twice.
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

const PITCHES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FLATS: Record<string, string> = { Db: 'C#', Eb: 'D#', Gb: 'F#', Ab: 'G#', Bb: 'A#' };

function camelot(key: string | null | undefined, scale?: string | null): { number: number; minor: boolean } | null {
  const text = String(key ?? '').trim();
  if (!text) return null;
  const [token, mode] = text.split(/[\s/|-]+/);
  const pitch = token[0].toUpperCase() + token.slice(1).replace(/[^#b]/g, '');
  const pc = PITCHES.indexOf(FLATS[pitch] || pitch);
  if (pc < 0) return null;
  const minor = /^min|^m$/i.test(mode || '') || /minor/i.test(String(scale ?? ''));
  const major = minor ? (pc + 3) % 12 : pc;
  return { number: ((major * 7 + 7) % 12) + 1, minor };
}

function keysMix(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = camelot(a);
  const y = camelot(b);
  if (!x || !y) return false;
  if (x.number === y.number) return true;
  const step = Math.abs(x.number - y.number);
  return x.minor === y.minor && (step === 1 || step === 11);
}

export interface SetArc {
  budget: number;
  blinder: boolean;
  reason: 'first' | 'warm-up' | 'peak' | 'breather' | 'level';
}

const WARM_UP_MINUTES = 20;
const PEAK = 0.12;

function arcFor(history: SetHistory | null | undefined, drive: number): SetArc {
  if (!history || !history.recent.length) return { budget: 1, blinder: true, reason: 'first' };
  const recent = history.recent.slice(-4);
  const mean = recent.reduce((sum, t) => sum + t.drive, 0) / recent.length;
  const delta = drive - mean;
  const blindersLately = history.recent.slice(-2).some((t) => t.blinder);
  if (delta >= PEAK) return { budget: 1.15, blinder: true, reason: 'peak' };
  if (history.setMinutes < WARM_UP_MINUTES) return { budget: 0.85, blinder: !blindersLately, reason: 'warm-up' };
  if (delta <= -PEAK) return { budget: 0.9, blinder: !blindersLately, reason: 'breather' };
  return { budget: 1, blinder: !blindersLately, reason: 'level' };
}

export { SetMemory, SET_GAP_MS, camelot, keysMix, arcFor, WARM_UP_MINUTES };
