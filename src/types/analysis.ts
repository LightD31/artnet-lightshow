// Generated from src/analysis/document.schema.json by scripts/gen-analysis-types.ts.
// Do not edit: change the schema and run `npm run gen:analysis-types`.

/**
 * What the analyser says about a track: its beat grid, its sections, its dynamics and its event
 * stream. Written by src/analysis/pipeline.py, read by the show engine. The TypeScript types in
 * src/types/analysis.ts are generated from this file (npm run gen:analysis-types);
 * src/analysis/schema.py validates the pipeline's output against it. Only the fields every 2.x
 * document carries are required at the top level: cached documents are replayed across minor
 * versions, and a field added since is simply absent from the older ones.
 */
export interface AnalysisDocument {
  /** major.minor; see src/analysis/version.py. */
  schemaVersion: string;
  track: Track;
  /** Seconds. */
  duration: number;
  /** The track's tempo, to a tenth. */
  bpm: number;
  /** Local tempo every two seconds. */
  tempoCurve?: CurvePoint[];
  /** 0..1: how steady the tempo is. */
  tempoStability?: number;
  /** Which tracker found the beats. */
  beatSource?: string;
  /** Beat times, seconds. */
  beats: number[];
  beatStrengths?: number[];
  /** Bar-start times, seconds. */
  downbeats: number[];
  /** Beats per bar. */
  meter?: number;
  downbeatConfidence?: number;
  key?: string | null;
  scale?: string | null;
  keyStrength?: number;
  mood?: Mood;
  genre?: Genre;
  /** The track's sections, in order. */
  segments: Section[];
  /**
   * Where the sections came from: 'songformer' when the structure model named them, 'analysis' for
   * the self-similarity labeller, or 'rekordbox' when a CDJ track's phrases replaced them.
   */
  sectionSource?: string;
  /**
   * rekordbox's phrase mood, when its phrases are the sections: high for club tracks, mid and low
   * for songs.
   */
  phraseMood?: "high" | "mid" | "low";
  onsets?: number[];
  kickOnsets?: number[];
  drops?: Drop[];
  buildups?: Span[];
  energyCurve?: CurvePoint[];
  bassCurve?: CurvePoint[];
  kickCurve?: CurvePoint[];
  highCurve?: CurvePoint[];
  loudness?: Loudness;
  stereo?: Stereo;
  rhythm?: Rhythm;
  /** Per frequency band, by name (sub, bass, low-mid, mid, high-mid, high, air). */
  bands?: Record<string, Band>;
  instruments?: Instruments;
  /** Share of total energy per separated stem, or null when nothing was separated. */
  sources?: Record<string, number> | null;
  structure?: Structure;
  dynamics?: Dynamics;
  perception?: Perception;
  features?: Record<string, FeatureStat>;
  /** The event stream, in time order. */
  events: MusicalEvent[];
  /** MuQ windows; empty when the model is not installed. */
  embeddings?: Embedding[];
  /** MuQ-MuLan similarity to the mood vocabulary. */
  semantic_scores?: LabelScore[];
  meta?: Meta;
}

export interface Track {
  hash: string;
  duration: number;
  bpm?: number;
  key?: string | null;
  mode?: string | null;
}

export interface CurvePoint {
  /** Seconds. */
  t: number;
  v: number;
}

export interface Mood {
  valence: number;
  arousal: number;
  danceability: number;
  kickiness: number;
  tension: number;
}

export interface Genre {
  label: string;
  confidence: number;
  /** The same as confidence; the name older clients read. */
  labelConf?: number;
  style?: string;
  /** muq-mulan, panns or signal. */
  source?: string;
  subScores?: Record<string, number>;
  topTags?: unknown[];
}

export interface Section {
  start: number;
  end: number;
  label: string;
  /** intro, verse, prechorus, chorus, drop, bridge, breakdown or outro. */
  role: string;
  energy: number;
  brightness?: number;
  bass?: number;
  rhythmic?: number;
  vocal?: number;
  level: "low" | "mid" | "high";
  confidence?: number;
  /**
   * What a structure model called the section (intro, verse, pre-chorus, chorus, bridge, inst,
   * outro, silence), when one named it.
   */
  function?: string;
}

export interface Drop {
  t: number;
  confidence: number;
  rise?: number;
  breakdownScore?: number;
  sustainScore?: number;
  /** What the drop was snapped to: raw, beat or downbeat. */
  snapTo?: string;
  kind?: string;
}

export interface Span {
  start: number;
  end: number;
  intensity?: number;
  /** For build-ups: how finely the roll subdivides by the end. */
  subdivision?: number;
}

export interface Loudness {
  integratedLufs?: number | null;
  range?: number;
  truePeakDb?: number | null;
  appliedGainDb?: number;
  noiseFloorDb?: number | null;
  snrDb?: number | null;
  denoised?: boolean;
}

export interface Stereo {
  width?: number | null;
  correlation?: number | null;
}

export interface Rhythm {
  bpm?: number;
  beatPeriod?: number;
  barPeriod?: number;
  meter?: number;
  stability?: number;
  source?: string;
  downbeatConfidence?: number;
  beatConfidences?: number[];
  onsetStrengths?: number[];
  intensityCurve?: CurvePoint[];
}

export interface Band {
  name: string;
  range?: number[];
  energy?: number;
  attackMs?: number;
  decayMs?: number;
  variation?: number;
  rhythmic?: number;
  percussive?: number;
  importance?: number;
  curve?: CurvePoint[];
}

export interface Instruments {
  /** 0..1 per role: kick, snare, hats, bassline, vocal, synth… */
  scores?: Record<string, number>;
  curves?: Record<string, CurvePoint[]>;
}

export interface Structure {
  sections?: Section[];
  roles?: string[];
}

export interface Dynamics {
  drops?: Drop[];
  buildups?: Span[];
  breaks?: Span[];
  silences?: Span[];
  spikes?: Span[];
  impactCurve?: CurvePoint[];
}

export interface Perception {
  key?: string | null;
  scale?: string | null;
  keyStrength?: number;
  mood?: Mood;
  genre?: Genre;
}

export interface FeatureStat {
  mean?: number;
  std?: number;
  p90?: number;
}

export interface MusicalEvent {
  /** Seconds. */
  t: number;
  /**
   * BEAT, BAR, DROP, BUILDUP, ENERGY_SPIKE, BASS_HIT, VOCAL_SECTION, MELODY_CHANGE, SILENCE,
   * TRANSITION, BREAK or SECTION.
   */
  type: string;
  confidence?: number;
  intensity?: number;
  duration?: number;
  /** The look the analyser suggests: accent, pulse, flash, blinder, ramp… */
  effect?: string;
  /** Type-specific detail: a beat's place in the bar, a section's role, a build-up's end… */
  data?: Record<string, unknown>;
}

export interface Embedding {
  time: number;
  vector: number[];
  confidence?: number;
  source?: string;
}

export interface LabelScore {
  label: string;
  score: number;
  source?: string;
}

export interface Meta {
  sampleRate?: number;
  hopLength?: number;
  nFft?: number;
  frames?: number;
  trimOffset?: number;
  taggerUsed?: boolean;
  beatSource?: string;
  separated?: boolean;
  modelUsage?: Record<string, string | boolean>;
  elapsedSec?: number;
  processingRatio?: number;
  withinRealtimeBudget?: boolean;
}
