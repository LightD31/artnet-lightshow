import type { AnalysisDocument, CurvePoint, Embedding, Genre, LabelScore, Mood, Section } from '../types/analysis.ts';

export type Segment = Partial<Omit<Section, 'label'>> & { label?: string | null };

// Accept missing analysis fields so older cached documents can still produce a show.
export type Analysis = Partial<Omit<AnalysisDocument, 'mood' | 'genre' | 'segments'>> & {
  mood?: Partial<Mood>;
  genre?: Genre | null;
  segments?: Segment[];
};

export interface Reading {
  kick: number;
  snare: number;
  hats: number;
  bassline: number;
  vocal: number;
  synth: number;
  energy: number;
  impact: number;
  pulse: number;
  texture: number;
  range: number;
}

export interface Score {
  semantic: Record<string, number>;
  subgenre: Record<string, number>;
  genreTrust: number;
  separated: boolean;
  confidence: number;
  stability: number;
  keyStrength: number;
  articulation: number;
  decay: number;
  width: number;
  range: number;
  crest: number;
  texture: number;
  sample(t: number): Reading;
  span(start: number, end: number, steps?: number): Reading;
  vector(start: number, end: number): number[] | undefined;
  novelty(t: number): number;
}

const isNumber = (v: unknown): v is number => Number.isFinite(v);
const unit = (v: unknown, fallback = 0): number => (isNumber(v) ? Math.max(0, Math.min(1, v)) : fallback);
function list<T>(v: readonly T[] | null | undefined): readonly T[];
function list(v: unknown): readonly unknown[];
function list(v: unknown): readonly unknown[] {
  return Array.isArray(v) ? v : [];
}
const finite = (v: unknown, fallback = 0): number => (isNumber(v) ? v : fallback);
const mean = (values: readonly number[]): number | null => (values.length
  ? values.reduce((sum, v) => sum + v, 0) / values.length : null);

function curve(raw: readonly CurvePoint[] | null | undefined, fallback = 0): (t: number) => number {
  const points = list(raw)
    .filter((p) => p && Number.isFinite(p.t) && Number.isFinite(p.v))
    .sort((a, b) => a.t - b.t);
  return (t: number) => {
    if (!points.length) return fallback;
    let lo = 0;
    let hi = points.length - 1;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (points[mid].t <= t) lo = mid; else hi = mid - 1;
    }
    const a = points[lo];
    const b = points[lo + 1];
    if (!b || t <= a.t) return a.v;
    return a.v + (b.v - a.v) * unit((t - a.t) / Math.max(0.001, b.t - a.t));
  };
}

const SEMANTIC_FULL_SPREAD = 0.2;

function semantics(raw: readonly LabelScore[] | null | undefined): Record<string, number> {
  const entries = list(raw).filter((p) => p && typeof p.label === 'string'
    && Number.isFinite(p.score));
  if (!entries.length) return {};
  const scores = entries.map((p) => p.score);
  const low = Math.min(...scores);
  const high = Math.max(...scores);
  const spread = high - low;
  if (spread < 0.025) return {};
  const strength = unit(spread / SEMANTIC_FULL_SPREAD);
  return Object.fromEntries(entries.map((p) =>
    [p.label, unit((p.score - low) / spread) * strength]));
}

function cosine(a: readonly number[] | null | undefined, b: readonly number[] | null | undefined): number {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; aa += a[i] ** 2; bb += b[i] ** 2; }
  return aa && bb ? dot / Math.sqrt(aa * bb) : 0;
}

function subgenreWeights(genre: Genre | null | undefined): { weights: Record<string, number>; trust: number } {
  const scores = genre && genre.subScores;
  if (!scores || typeof scores !== 'object') return { weights: {}, trust: 0 };
  const entries = Object.entries(scores).filter(([, v]) => Number.isFinite(v) && v > 0);
  const total = entries.reduce((sum, [, v]) => sum + v, 0);
  if (!entries.length || total <= 0) return { weights: {}, trust: 0 };

  const weights = Object.fromEntries(entries.map(([k, v]) => [k, v / total]));
  const ranked = Object.values(weights).sort((a, b) => b - a);
  const uniform = 1 / entries.length;
  const peak = unit((ranked[0] - uniform) / Math.max(0.001, 1 - uniform));
  const lead = ranked.length > 1 ? unit((ranked[0] - ranked[1]) / Math.max(0.001, ranked[0])) : 1;
  const source = genre?.source === 'muq-mulan' ? 1 : genre.source === 'panns' ? 0.75 : 0.5;
  return { weights, trust: unit(peak * 0.6 + lead * 0.4) * source };
}

function blend<K>(
  weights: Record<string, number>,
  table: Record<string, K | readonly K[]>,
  value: (item: K, name: string, entry: K | readonly K[]) => number = () => 1,
): Map<K, number> {
  const out = new Map<K, number>();
  for (const [name, weight] of Object.entries(weights)) {
    const entry = table[name];
    if (entry == null) continue;
    for (const item of (isList(entry) ? entry : [entry])) {
      const key = item;
      out.set(key, (out.get(key) || 0) + weight * value(item, name, entry));
    }
  }
  return out;
}

const isList = <K>(entry: K | readonly K[]): entry is readonly K[] => Array.isArray(entry);

type Role = 'kick' | 'snare' | 'hats' | 'bassline' | 'vocal' | 'synth';

function makeScore(analysis: Analysis | null | undefined): Score {
  const a: Analysis = analysis || {};
  const bands = a.bands || {};
  const roles = a.instruments || {};
  const sources: Record<string, number> = a.sources || {};

  const ROLE_BAND: Record<Role, string> = { kick: 'sub', snare: 'mid', hats: 'high', bassline: 'bass', vocal: 'mid', synth: 'presence' };
  const ROLE_SOURCE: Record<Role, string> = { kick: 'drums', snare: 'drums', hats: 'drums', bassline: 'bass', vocal: 'vocals', synth: 'other' };
  const sourceMax = Math.max(0.001, ...Object.values(sources).filter(Number.isFinite));
  const separated = !!roles.curves;

  const envelopes = Object.fromEntries((Object.keys(ROLE_BAND) as Role[]).map((name) => {
    const band = bands[ROLE_BAND[name]];
    const read = curve((roles.curves && roles.curves[name]) || (band && band.curve));
    // Floor an unmeasured role’s weight so missing data makes it quieter rather than absent.
    const strength = (roles.scores && roles.scores[name] != null)
      ? unit(roles.scores[name])
      : 0.5 + 0.5 * unit(band && band.importance, 0.5);
    const source = sources[ROLE_SOURCE[name]];
    const share = Number.isFinite(source) ? Math.sqrt(unit(source / sourceMax)) : 1;
    const gain = Math.sqrt(strength * share);
    return [name, (t: number) => unit(read(t)) * gain];
  }));

  const sectionEnergy = (t: number) => unit(list(a.segments)
    .find((p) => p.start !== undefined && p.end !== undefined && t >= p.start && t < p.end)?.energy, 0.4);
  const energy = list(a.energyCurve).length ? curve(a.energyCurve, 0.4) : sectionEnergy;
  const impact = curve(a.dynamics?.impactCurve);

  const bandList = Object.values(bands).filter((b) => b && typeof b === 'object');
  const totalImportance = bandList.reduce((sum, b) => sum + unit(b.importance), 0);
  const groove = totalImportance
    ? bandList.reduce((sum, b) => sum + unit(b.importance) * unit(b.rhythmic), 0) / totalImportance
    : 0.5;
  const pulse = curve(a.rhythm?.intensityCurve, groove);

  const noise = unit(a.features?.flatness?.mean);
  const crisp = unit(0.5 * finite(a.features?.centroid?.mean, 2200) / 6000
    + 0.5 * finite(a.features?.rolloff?.mean, 6000) / 12000);
  const grain = unit(0.5 * noise + 0.5 * unit(a.features?.zcr?.mean));

  const attackMs = finite(bands.sub?.attackMs ?? bands.bass?.attackMs, 90);
  const articulation = unit(0.6 * unit(bands.sub?.percussive, 0.5)
    + 0.4 * unit((200 - attackMs) / 170));
  const decay = unit(finite(bands.bass?.decayMs ?? bands.sub?.decayMs, 250) / 1000);

  const range = unit(finite(a.loudness?.range, 8) / 16);
  const crestDb = finite(a.loudness?.truePeakDb, -1)
    - (finite(a.loudness?.integratedLufs, -12) + finite(a.loudness?.appliedGainDb, 0));
  const crest = unit((crestDb - 6) / 14);

  const width = unit(unit(a.stereo?.width, 0.5) * 0.8
    + (1 - finite(a.stereo?.correlation, 0)) * 0.1);

  const beatConfidence = list(a.rhythm?.beatConfidences).filter(Number.isFinite);
  const certainty = beatConfidence.length ? mean(beatConfidence) : 1;
  const snr = unit(finite(a.loudness?.snrDb, 40) / 30);
  const confidence = snr * (0.6 + 0.4 * unit(certainty));
  const stability = unit(a.rhythm?.stability ?? a.tempoStability, 0.8);
  const keyStrength = unit(a.keyStrength, 0.5);

  const embeddings = list(a.embeddings).filter((p) => p && Number.isFinite(p.time)
    && Array.isArray(p.vector) && p.vector.length && p.vector.every(Number.isFinite));
  const nearest = (t: number) => embeddings.reduce<Embedding | null>((best, p) => (!best
    || Math.abs(p.time - t) < Math.abs(best.time - t) ? p : best), null);

  const semantic = semantics(a.semantic_scores);
  const genre = subgenreWeights(a.genre);

  return {
    semantic,
    subgenre: genre.weights,
    genreTrust: genre.trust,
    separated,
    confidence: unit(confidence),
    stability,
    keyStrength,
    articulation,
    decay,
    width,
    range,
    crest,
    texture: unit(0.5 * grain + 0.5 * crisp),

    sample(t) {
      const r = Object.fromEntries(Object.entries(envelopes)
        .map(([key, read]) => [key, read(t)])) as Record<Role, number>;
      return {
        ...r,
        energy: unit(energy(t)),
        impact: unit(impact(t)),
        pulse: unit(pulse(t)),
        texture: unit(0.45 * r.hats + 0.3 * grain + 0.25 * crisp),
        range,
      };
    },

    span(start, end, steps = 12) {
      const step = Math.max(0.25, (end - start) / steps);
      const rows: Reading[] = [];
      for (let t = start; t < end; t += step) rows.push(this.sample(t));
      if (!rows.length) rows.push(this.sample(start));
      return Object.fromEntries((Object.keys(rows[0]) as (keyof Reading)[])
        .map((key) => [key, mean(rows.map((r) => r[key]))])) as unknown as Reading;
    },

    vector(start, end) {
      const rows = embeddings.filter((p) => p.time >= start && p.time < end);
      if (!rows.length) return nearest((start + end) / 2)?.vector;
      const valid = rows.filter((p) => p.vector.length === rows[0].vector.length);
      return valid[0].vector.map((_, i) => mean(valid.map((p) => p.vector[i])) ?? 0);
    },

    novelty(t) {
      if (embeddings.length < 2) return 0;
      return unit(1 - cosine(nearest(t)?.vector, nearest(Math.max(0, t - 4))?.vector));
    },
  };
}

function hasScore(a: Analysis | null | undefined): boolean {
  return !!(a && (a.instruments?.curves || a.bands
    || list(a.embeddings).length || list(a.semantic_scores).length));
}

export {
  makeScore,
  hasScore,
  semantics,
  subgenreWeights,
  blend,
  cosine,
  curve,
  SEMANTIC_FULL_SPREAD,
  unit,
  list,
  finite,
};
