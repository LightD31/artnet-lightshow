// Use stream time and generation for hop identity so wall jitter and restarts cannot replay audio events.

import { bandBins } from '../shared/spectrum-bands.ts';
import { DISCO_DEFAULTS } from '../shared/effects/disco.ts';
import { VISUALIZER_DEFAULTS } from '../shared/effects/ldj-visualizer.ts';
import { requiresAcknowledgement } from '../shared/effects/registry.ts';
import { playingLeaves } from '../shared/effects/nesting.ts';
import { voiceOrder } from '../shared/effects/layer.ts';
import { bandsArg } from '../live-input.ts';
import type { AudioFrame } from '../shared/effects/audio-frame.ts';
import type { DiscoGlobals, DiscoParams } from '../shared/effects/disco.ts';
import type { EffectSpec, HdMaster } from '../shared/effects/types.ts';
import type { LiveReading, LiveSpectrum } from '../live-input.ts';

type Edges = [number, number];
export type SplClass = 'loud' | 'soft' | 'quiet';

export interface DiscoDetector { bands: DiscoParams['bands']; globals: DiscoGlobals }

export interface AudioFeaturesOptions {
  master: () => HdMaster;
  disco: () => DiscoDetector;
  ldjTrigger: () => number;
  binHz: number;
  now?: () => number;
  onBands?: () => void;
}

const PARTY_BANDS: readonly Edges[] = [[20, 250], [250, 3000], [3000, 9000]];
const HISTORY = 80;
const STALE_MS = 500;
const GAP_SEC = 0.5;
const KEEP_SEC = 1.25;
const KEEP_FRAMES = 256;
const SAMPLE_US = 50000;
const SECTION_WINDOW = 16;
const SECTION_AT: Record<SplClass, number> = { quiet: 7, soft: 3, loud: 11 };
const DOMINANT_MAX_HZ = 2000;
// Compared field by field, so an equal object built in another order is no edit.
const GLOBAL_KEYS = Object.keys(DISCO_DEFAULTS.globals) as (keyof DiscoGlobals)[];

const f32 = Math.fround;
const unit = (x: number) => (x > 1 ? 1 : x > 0 ? x : 0);
const nonNegative = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0;
const percentFactor = (x: number) => f32(f32(f32(x) / 100) * 2);
const dbToPower = (db: number) => 10 ** (Math.min(0, Math.max(-120, db)) / 10);

function mean32(ring: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < ring.length; i++) sum = f32(sum + ring[i]);
  return ring.length ? f32(sum / ring.length) : 0;
}
function variance32(ring: Float32Array): number {
  const m = mean32(ring);
  let sum = 0;
  for (let i = 0; i < ring.length; i++) { const d = f32(ring[i] - m); sum = f32(sum + f32(d * d)); }
  return f32(sum / ring.length);
}
const varianceCoefficient = (ring: Float32Array) => -0.0025714 * variance32(ring) + 1.5142857;

// Keep Neural’s source history indexing so long smoothers retain the app’s zero-filled remainder.
interface Smoother { length: number; values: Float32Array }
const smootherLength = (n: number) => Math.min(Number.MAX_SAFE_INTEGER, n);
function smoother(length: number): Smoother { return { length, values: new Float32Array(Math.min(length, HISTORY)) }; }
function smootherMean(s: Smoother): number {
  let sum = 0;
  for (let i = 0; i < s.values.length; i++) sum = f32(sum + s.values[i]);
  return s.length ? f32(sum / s.length) : 0;
}
function smootherMedian(s: Smoother): number {
  if (!s.length) return 0;
  const zeros = s.length - s.values.length;
  const k = Math.floor((s.length - 1) / 2);
  return k < zeros ? 0 : Array.from(s.values).sort((a, b) => a - b)[k - zeros];
}

interface Gate { last: number; decayed: number }
interface SpectrumBand extends Gate { ring: Float32Array; prime: boolean; floor: number }
interface Stream { generation: number | null; t: number; layout: string | undefined }

function onesRing(): Float32Array { return new Float32Array(HISTORY).fill(1); }

class AudioFeatures {
  declare _opts: AudioFeaturesOptions;
  declare _now: () => number;
  declare _list: Edges[];
  declare _key: string;
  declare _partyAt: number[];
  declare _discoAt: number[];
  declare _edgeKeys: string[] | null;
  declare _contentKey: string | null;
  declare _disco: DiscoDetector;
  declare _slot: number;
  declare _spectrum: SpectrumBand[];
  declare _peak: Gate & { ring: Float32Array };
  declare _neural: { ring: Float32Array; energies: Smoother; frequencies: Smoother };
  declare _party: AudioFrame['party'];
  declare _spl: SplState;
  declare _stream: Stream | null;
  declare _epoch: number;
  declare _freshAt: number;
  declare _frames: AudioFrame[];
  declare _asked: string | null;
  declare _resetDue: boolean;
  declare _heard: { epoch: number; t: number } | null;

  constructor(opts: AudioFeaturesOptions) {
    this._opts = opts;
    this._now = opts.now || (() => performance.now());
    this._list = [];
    this._key = '';
    this._partyAt = [];
    this._discoAt = [];
    this._edgeKeys = null;
    this._contentKey = null;
    this._disco = { bands: DISCO_DEFAULTS.bands, globals: DISCO_DEFAULTS.globals };
    this._party = { full: 0, bass: 0, mid: 0, high: 0 };
    this._spl = newSpl();
    this._stream = null;
    this._epoch = 0;
    this._freshAt = -Infinity;
    this._frames = [];
    this._asked = null;
    this._resetDue = false;
    this._heard = null;
    this._resetDetectors();
    this._sync();
  }

  bandList(): [number, number][] {
    this._sync();
    return this._list.map(([lo, hi]) => [lo, hi]);
  }

  reseed(): void {
    for (const band of this._spectrum) band.prime = true;
  }

  onReading(r: LiveReading): void {
    this._sync();
    if (!r || !Number.isFinite(r.t)) return;
    const generation = Number.isFinite(r.generation) ? r.generation as number : null;
    const last = this._stream;
    if (last && generation !== null && last.generation !== null && generation > last.generation && r.cause !== 'bands') this._resetDue = true;
    if (r.layout !== undefined && r.layout !== this._key) {
      this._askForBands(r.generation);
      return;
    }
    const spectrum = this._spectrumOf(r.spectrum);
    if (!spectrum) return;
    let dtSec = 0;
    if (!last) {
      this._startStream('reset');
    } else if (generation !== last.generation) {
      if (generation !== null && last.generation !== null && generation < last.generation) return;
      this._startStream(r.cause === 'bands' && !this._resetDue ? 'bands' : 'reset');
    } else if (r.t === last.t) {
      return;
    } else if (r.t < last.t) {
      if (generation !== null) return;
      this._startStream('reset');
    } else if (r.t - last.t > GAP_SEC) {
      this._startStream('reset');
    } else {
      dtSec = r.t - last.t;
    }
    this._stream = { generation, t: r.t, layout: r.layout };
    this._freshAt = this._now();
    this._keep(this._analyse(r.t, spectrum, dtSec));
  }

  frame(alignedStreamSec?: number): AudioFrame | null {
    this._sync();
    const frames = this._frames;
    if (!frames.length || this._now() - this._freshAt > STALE_MS) return null;
    const newest = frames[frames.length - 1];
    if (alignedStreamSec === undefined || !Number.isFinite(alignedStreamSec) || alignedStreamSec >= newest.t) return newest;
    for (let i = frames.length - 1; i >= 0; i--) if (frames[i].t <= alignedStreamSec) return frames[i];
    return null;
  }

  // Never return an older hop after latency changes because effects would replay its hits.
  heard(alignedStreamSec?: number): AudioFrame | null {
    const held = this._heard && this._heard.epoch === this._epoch ? this._heard.t : -Infinity;
    const at = alignedStreamSec === undefined || !Number.isFinite(alignedStreamSec) ? undefined : Math.max(alignedStreamSec, held);
    const f = this.frame(at);
    if (f) this._heard = { epoch: this._epoch, t: f.t };
    return f;
  }

  _sync(): void {
    const d = this._opts.disco();
    const b = d.bands;
    const edges = [b.bass, b.voice, b.treble].map(([lo, hi]) => `${lo}-${hi}`);
    const content = JSON.stringify([edges, b.floorDb, GLOBAL_KEYS.map((k) => d.globals[k])]);
    if (content === this._contentKey) return;
    if (this._edgeKeys) edges.forEach((key, i) => { if (key !== this._edgeKeys![i]) this._spectrum[i].prime = true; });
    if (this._contentKey !== null) this._takeBackHits();
    this._edgeKeys = edges;
    this._contentKey = content;
    this._disco = { bands: { ...b, floorDb: [...b.floorDb] as [number, number, number] }, globals: { ...d.globals } };
    const list: Edges[] = [];
    const at = ([lo, hi]: Edges) => {
      let i = list.findIndex(([l, h]) => l === lo && h === hi);
      if (i < 0) i = list.push([lo, hi]) - 1;
      return i;
    };
    this._partyAt = PARTY_BANDS.map(at);
    this._discoAt = [b.bass, b.voice, b.treble].map(at);
    this._list = list;
    this._key = bandsArg(list);
    [b.bass, b.voice, b.treble].forEach(([lo, hi], i) => {
      this._spectrum[i].floor = f32(dbToPower(b.floorDb[i]) * bandBins(lo, hi, this._opts.binHz).count);
    });
  }

  _takeBackHits(): void {
    this._frames = this._frames.map((f) => (f.disco.peakHit || f.disco.hit.some(Boolean)
      ? { ...f, disco: { ...f.disco, hit: [false, false, false], peakHit: false } } : f));
  }

  _askForBands(generation: number | undefined): void {
    const ask = `${generation ?? ''}|${this._key}`;
    if (ask === this._asked || !this._opts.onBands) return;
    this._asked = ask;
    this._opts.onBands();
  }

  _spectrumOf(s: LiveSpectrum | undefined): LiveSpectrum | null {
    if (!s || typeof s !== 'object') return null;
    if (!nonNegative(s.power) || !nonNegative(s.rms) || !Array.isArray(s.bands) || s.bands.length !== this._list.length) return null;
    if (!s.bands.every(nonNegative)) return null;
    if (s.fftPower !== undefined && !nonNegative(s.fftPower)) return null;
    if (s.dominantHz != null && !nonNegative(s.dominantHz)) return null;
    return s;
  }

  _startStream(why: 'bands' | 'reset'): void {
    this._epoch += 1;
    this._frames = [];
    this._resetDue = false;
    if (why === 'reset') {
      this._resetDetectors();
      this._spl = newSpl();
    } else {
      this._spl = { ...newSpl(), classes: this._spl.classes, section: this._spl.section };
    }
  }

  _resetDetectors(): void {
    const floors = this._spectrum ? this._spectrum.map((b) => b.floor) : [0, 0, 0];
    this._slot = 0;
    this._spectrum = floors.map((floor) => ({ ring: onesRing(), prime: false, last: 0, decayed: 0, floor }));
    this._peak = { ring: onesRing(), last: 0, decayed: 0 };
    this._neural = { ring: new Float32Array(HISTORY), energies: smoother(0), frequencies: smoother(0) };
  }

  _keep(frame: AudioFrame): void {
    const frames = this._frames;
    frames.push(frame);
    while (frames.length > KEEP_FRAMES || frame.t - frames[0].t > KEEP_SEC) frames.shift();
  }

  _analyse(t: number, s: LiveSpectrum, dtSec: number): AudioFrame {
    const party = this._partyLevels(s, dtSec * 1000);
    const slot = this._slot;
    const spectrum = this._spectrumHits(s, slot);
    const peakHit = this._peakHit(s, slot);
    const neural = this._neuralReading(s, slot);
    if (++this._slot >= HISTORY) this._slot = 0;
    this._splAdvance(t, s.rms);
    const spl = this._spl;
    return {
      t, generation: this._epoch, rms: s.rms, power: s.power, dominantHz: s.dominantHz ?? null,
      party,
      disco: { ...spectrum, peakHit, neural },
      spl: {
        db: spl.sample ? spl.sample.db : 0, level: spl.sample ? spl.sample.level : -55, beat: spl.beat, section: spl.section,
        ...(spl.eventUs !== null ? { eventT: spl.eventUs / 1e6 } : {}),
      },
    };
  }

  _partyLevels(s: LiveSpectrum, dtMs: number): AudioFrame['party'] {
    const m = this._opts.master();
    const full = unit(s.rms * (2 + 18 * unit(m.sensitivity)));
    const total = s.fftPower ?? s.power;
    const band = (i: number) => (total > Number.MIN_VALUE ? unit(full * Math.sqrt(unit(s.bands[this._partyAt[i]] / total)) * 1.8) : 0);
    const target = { full, bass: band(0), mid: band(1), high: band(2) };
    if (!(dtMs > 0)) return { ...this._party };
    const attack = Math.max(1, m.attackMs), release = Math.max(1, m.releaseMs);
    const slow = 1 + 4 * unit(m.smoothing);
    const ease = (prev: number, to: number) => {
      const tau = Math.max(1, (to >= prev ? attack : release) * slow);
      return prev + (to - prev) * (1 - Math.exp(-Math.max(1, dtMs) / tau));
    };
    const p = this._party;
    this._party = { full: ease(p.full, target.full), bass: ease(p.bass, target.bass), mid: ease(p.mid, target.mid), high: ease(p.high, target.high) };
    return { ...this._party };
  }

  _spectrumHits(s: LiveSpectrum, slot: number): Pick<AudioFrame['disco'], 'hit' | 'gate' | 'level'> {
    const g = this._disco.globals;
    const sensitivity = percentFactor(g.sensitivity);
    const decay = f32(f32(g.advancedDecay) / 1000);
    const hit: boolean[] = [], gate: number[] = [], level: number[] = [];
    this._spectrum.forEach((band, i) => {
      const power = f32(s.bands[this._discoAt[i]]);
      if (band.prime) { band.ring.fill(power); band.prime = false; }
      const mean = mean32(band.ring);
      const c = varianceCoefficient(band.ring);
      band.ring[slot] = power;
      const scaled = f32(power * sensitivity);
      const threshold = Math.max(band.floor, f32(mean * 0.5), f32(c * mean));
      gate.push(f32(Math.max(f32(threshold / Math.max(sensitivity, f32(0.0001))), band.decayed)));
      hit.push(scaled > band.floor && scaled > mean * 0.5 && scaled > c * mean && power > band.decayed);
      level.push(power);
      decayGate(band, hit[i], power, decay);
    });
    return { hit, gate, level };
  }

  _peakHit(s: LiveSpectrum, slot: number): boolean {
    const g = this._disco.globals;
    const peak = this._peak;
    const power = f32(s.power);
    const mean = mean32(peak.ring);
    const c = varianceCoefficient(peak.ring);
    peak.ring[slot] = power;
    const sensitivity = percentFactor(g.simpleSensitivity);
    const scaled = f32(power * sensitivity);
    const floor = f32(f32(g.simpleMinimumThreshold) / 100000);
    const hit = scaled > floor && f32(scaled * sensitivity) > mean && scaled > c * mean && power > peak.decayed;
    decayGate(peak, hit, power, f32(f32(g.simpleDecay) / 1000));
    return hit;
  }

  _neuralReading(s: LiveSpectrum, slot: number): AudioFrame['disco']['neural'] {
    const g = this._disco.globals;
    const n = this._neural;
    const energyLength = smootherLength(Math.max(1, Math.trunc(g.smoothnessAnalyser)));
    const frequencyLength = smootherLength(Math.trunc(Math.max(3, f32(f32(g.smoothnessAnalyser) * 3))));
    if (n.energies.length !== energyLength) n.energies = smoother(energyLength);
    if (n.frequencies.length !== frequencyLength) n.frequencies = smoother(frequencyLength);
    const rms = f32(s.rms);
    n.ring[slot] = rms;
    const c = varianceCoefficient(n.ring);
    const scaled = f32(rms * percentFactor(g.analyserSensitivity));
    const binHz = this._opts.binHz;
    const span = Math.floor(DOMINANT_MAX_HZ / binHz);
    const bin = s.dominantHz != null && s.dominantHz > 0 ? Math.round(s.dominantHz / binHz) : 0;
    n.frequencies.values[slot % frequencyLength] = span > 0 ? f32(bin / span) : 0;
    const denominator = mean32(n.ring) * c;
    let ratio = scaled < f32(f32(g.simpleMinimumThreshold) / 100000) || !(denominator > 0) || !Number.isFinite(denominator)
      ? 0 : f32(scaled / denominator);
    if (!Number.isFinite(ratio)) ratio = 0;
    n.energies.values[slot % energyLength] = ratio;
    return { mainFrequency: unit(smootherMedian(n.frequencies)), amplitude: smootherMean(n.energies) };
  }

  _splAdvance(t: number, rms: number): void {
    const spl = this._spl;
    const us = Math.round(t * 1e6);
    if (spl.originUs === null) { spl.originUs = spl.lastUs = us; return; }
    const r2 = rms * rms;
    let from = spl.lastUs;
    for (let end = spl.originUs + (spl.index + 1) * SAMPLE_US; us >= end; end += SAMPLE_US) {
      spl.acc += r2 * (end - from);
      from = end;
      this._splSample(Math.sqrt(spl.acc / SAMPLE_US), end);
      spl.acc = 0;
      spl.index += 1;
    }
    spl.acc += r2 * (us - from);
    spl.lastUs = us;
  }

  _splSample(rms: number, endUs: number): void {
    const spl = this._spl;
    const rms16 = rms * 32768;
    const db = rms16 > 0 ? 20 * Math.log10(rms16 / 2e-6) - 80 : 0;
    const sample = { db, level: Math.trunc(db) - 55 };
    spl.sample = sample;
    if (spl.index % 2 === 0) { spl.first = sample; return; }
    this._splClass(Math.max(spl.first ? spl.first.level : sample.level, sample.level), endUs);
  }

  _splClass(level: number, eventUs: number): void {
    const spl = this._spl;
    const raw = this._opts.ldjTrigger();
    const trigger = Number.isFinite(raw) ? unit(raw) : VISUALIZER_DEFAULTS.trigger;
    const loud = 15 + 65 * trigger;
    const cls: SplClass = level < 0.6 * loud ? 'quiet' : level > loud ? 'loud' : 'soft';
    spl.classes = [...spl.classes, cls].slice(-SECTION_WINDOW);
    if (spl.classes.filter((c) => c === cls).length >= SECTION_AT[cls]) spl.section = cls;
    spl.beat = cls;
    spl.eventUs = eventUs;
  }
}

interface SplState {
  originUs: number | null;
  lastUs: number;
  index: number;
  acc: number;
  first: { db: number; level: number } | null;
  sample: { db: number; level: number } | null;
  classes: SplClass[];
  section: SplClass | null;
  beat: SplClass | null;
  eventUs: number | null;
}

function newSpl(): SplState {
  return { originUs: null, lastUs: 0, index: 0, acc: 0, first: null, sample: null, classes: [], section: null, beat: null, eventUs: null };
}

// A hit leaves its power as the gate; otherwise the gate falls by a share of the last hit.
function decayGate(gate: Gate, hit: boolean, power: number, decay: number): void {
  if (hit) gate.last = gate.decayed = power;
  else gate.decayed = f32(gate.decayed - f32(gate.last * decay));
}

export interface DetectorVoice {
  id: string;
  spec: EffectSpec;
  targets: readonly number[] | null;
  tier: 'strobe' | 'voice';
  launchSeq: number;
  startedAtMs: number;
  untilMs: number | null;
  anchorBeat?: number;
}

export interface DetectorOwner { from: 'voice' | 'clip' | 'base' | 'fallback'; id: string | null; kind: string | null }

export interface Detectors {
  disco: DiscoDetector & { owner: DetectorOwner };
  spl: { owner: DetectorOwner; trigger: number };
}

const FALLBACK: DetectorOwner = { from: 'fallback', id: null, kind: null };

export function resolveDetectors({ base, clips = [], voices, nowMs, beatPos = NaN, fixtureIds, ldjTrigger, acknowledged }: {
  base: { id: string; spec: EffectSpec; anchorBeat?: number } | null;
  clips?: readonly { id: string; spec: EffectSpec; anchorBeat?: number; beatPos?: number }[];
  voices: readonly DetectorVoice[];
  nowMs: number;
  beatPos?: number;
  fixtureIds: readonly number[];
  ldjTrigger: number;
  acknowledged: boolean;
}): Detectors {
  const playing = voices
    .map((v, index) => ({ v, index }))
    .filter(({ v }) => v.startedAtMs <= nowMs && (v.untilMs === null || nowMs < v.untilMs)
      && (v.targets === null || v.targets.some((id) => fixtureIds.includes(id))))
    // The renderer's own order (shared/effects/layer.ts), so a tie resolves as the lamps show it.
    .sort((a, b) => voiceOrder(a.v, b.v) || (a.index - b.index))
    .map(({ v }) => v);
  const admitted = (spec: EffectSpec) => acknowledged || !requiresAcknowledgement(spec);
  const leafOf = (spec: EffectSpec, kind: string, at: number, anchorBeat: number | undefined, ids: readonly number[]): EffectSpec | null => {
    if (!admitted(spec)) return null;
    const leaf = spec.kind === kind ? spec : playingLeaves(spec, at, anchorBeat ?? NaN, ids).find((l) => l.kind === kind);
    return leaf && admitted(leaf) ? leaf : null;
  };
  const ownerOf = (kind: string): { owner: DetectorOwner; params: Record<string, unknown> } | null => {
    for (const v of playing) {
      const leaf = leafOf(v.spec, kind, beatPos, v.anchorBeat, v.targets === null ? fixtureIds : v.targets.filter((id) => fixtureIds.includes(id)));
      if (leaf) return { owner: { from: 'voice', id: v.id, kind }, params: leaf.params || {} };
    }
    for (const c of clips) {
      const leaf = leafOf(c.spec, kind, c.beatPos ?? beatPos, c.anchorBeat, fixtureIds);
      if (leaf) return { owner: { from: 'clip', id: c.id, kind }, params: leaf.params || {} };
    }
    const leaf = base && leafOf(base.spec, kind, beatPos, base.anchorBeat, fixtureIds);
    return base && leaf ? { owner: { from: 'base', id: base.id, kind }, params: leaf.params || {} } : null;
  };
  const disco = ownerOf('hd.disco');
  const discoParams = (disco?.params || {}) as Partial<DiscoParams>;
  const visualizer = ownerOf('ldj.visualizer');
  const trigger = visualizer ? visualizer.params.trigger : ldjTrigger;
  return {
    disco: {
      owner: disco ? disco.owner : FALLBACK,
      bands: discoParams.bands ?? DISCO_DEFAULTS.bands,
      globals: discoParams.globals ?? DISCO_DEFAULTS.globals,
    },
    spl: {
      owner: visualizer ? visualizer.owner : FALLBACK,
      trigger: typeof trigger === 'number' && Number.isFinite(trigger) ? unit(trigger) : VISUALIZER_DEFAULTS.trigger,
    },
  };
}

export interface AudioFeed {
  t: number;
  party: AudioFrame['party'];
  disco: Pick<AudioFrame['disco'], 'gate' | 'level' | 'hit'>;
  spl: AudioFrame['spl'];
}

export function feedOf(frame: AudioFrame | null): AudioFeed | null {
  if (!frame) return null;
  const { gate, level, hit } = frame.disco;
  return { t: frame.t, party: frame.party, disco: { gate, level, hit }, spl: frame.spl };
}

export { AudioFeatures };
