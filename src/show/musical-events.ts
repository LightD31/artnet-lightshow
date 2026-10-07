import type { Drop, MusicalEvent, Span } from '../types/analysis.ts';
import type { Analysis } from './score.ts';

export interface ShowEvent {
  t: number;
  type: string;
  confidence: number;
  intensity: number;
  duration: number;
  effect: string;
  data: Record<string, unknown>;
}

type LegacyDrop = Drop & { time?: number };
type LegacyBuildup = Span & { strength?: number };

const EVENT = Object.freeze({
  BEAT: 'BEAT',
  BAR: 'BAR',
  DROP: 'DROP',
  BUILDUP: 'BUILDUP',
  ENERGY_SPIKE: 'ENERGY_SPIKE',
  BASS_HIT: 'BASS_HIT',
  VOCAL_SECTION: 'VOCAL_SECTION',
  MELODY_CHANGE: 'MELODY_CHANGE',
  SILENCE: 'SILENCE',
  TRANSITION: 'TRANSITION',
  BREAK: 'BREAK',
  SECTION: 'SECTION',
});

const num = (v: unknown, fallback = 0): number => (Number.isFinite(Number(v)) ? Number(v) : fallback);
const clamp01 = (v: unknown): number => Math.max(0, Math.min(1, num(v, 0)));

function normalise(raw: Partial<MusicalEvent> | null | undefined): ShowEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const t = Number(raw.t);
  if (!Number.isFinite(t) || t < 0) return null;
  return {
    t,
    type: String(raw.type || '').toUpperCase(),
    confidence: raw.confidence == null ? 1 : clamp01(raw.confidence),
    intensity: raw.intensity == null ? 0.5 : clamp01(raw.intensity),
    duration: Math.max(0, num(raw.duration, 0)),
    effect: raw.effect || 'accent',
    data: raw.data && typeof raw.data === 'object' ? raw.data as Record<string, unknown> : {},
  };
}

// Degrade malformed or old analysis into fewer events so missing nuance cannot stop the show.
function deriveEvents(analysis: Analysis | null | undefined): ShowEvent[] {
  if (!analysis || typeof analysis !== 'object') return [];
  const supplied = Array.isArray(analysis.events) ? analysis.events : null;
  const events = supplied && supplied.length
    ? supplied.map((raw) => normalise(raw)).filter((e): e is ShowEvent => e !== null)
    : synthesise(analysis);
  events.sort((a, b) => a.t - b.t || priority(a.type) - priority(b.type));
  return events;
}

// Process section context before drops at equal timestamps so the drop wins the resulting look.
const ORDER: readonly string[] = [EVENT.SECTION, EVENT.TRANSITION, EVENT.BAR, EVENT.BEAT,
  EVENT.BASS_HIT, EVENT.MELODY_CHANGE, EVENT.VOCAL_SECTION, EVENT.BREAK,
  EVENT.SILENCE, EVENT.ENERGY_SPIKE, EVENT.BUILDUP, EVENT.DROP];

function priority(type: string): number {
  const index = ORDER.indexOf(type);
  return index < 0 ? ORDER.length : index;
}

// Synthesize only evidence supported by old documents so missing fields cannot invent musical events.
function synthesise(analysis: Analysis): ShowEvent[] {
  const events: ShowEvent[] = [];
  const beats = Array.isArray(analysis.beats) ? analysis.beats : [];
  const strengths = Array.isArray(analysis.beatStrengths) ? analysis.beatStrengths : [];
  const downbeats = Array.isArray(analysis.downbeats) ? analysis.downbeats : [];
  const meter = num(analysis.meter, 4) || 4;
  const downbeatSet = new Set(downbeats.map((t) => num(t).toFixed(3)));
  const downbeatConfidence = analysis.downbeatConfidence == null
    ? 0.5 : clamp01(analysis.downbeatConfidence);

  let barIndex = 0;
  const firstDownbeat = beats.findIndex((t) => downbeatSet.has(num(t).toFixed(3)));
  for (let i = 0; i < beats.length; i++) {
    const t = num(beats[i], -1);
    if (t < 0) continue;
    const isDownbeat = downbeatSet.has(t.toFixed(3));
    const strength = strengths[i] == null ? 0.5 : clamp01(strengths[i]);
    const inBar = firstDownbeat >= 0 ? ((i - firstDownbeat) % meter + meter) % meter : i % meter;
    events.push({
      t, type: EVENT.BEAT, confidence: strength, intensity: strength,
      duration: 0, effect: isDownbeat ? 'pulse' : 'accent',
      data: { index: i, inBar, downbeat: isDownbeat },
    });
  }
  for (const t of downbeats) {
    const time = num(t, -1);
    if (time < 0) continue;
    events.push({
      t: time, type: EVENT.BAR, confidence: downbeatConfidence, intensity: 0.5,
      duration: 0, effect: 'pulse',
      data: { index: barIndex, phrase: barIndex % 4, phraseStart: barIndex % 4 === 0, meter },
    });
    barIndex++;
  }

  const segments = Array.isArray(analysis.segments) ? analysis.segments : [];
  segments.forEach((segment, i) => {
    const t = num(segment.start, -1);
    if (t < 0) return;
    const role = segment.role || 'unknown';
    const shared = {
      role, label: segment.label || null, level: segment.level || 'mid',
      end: num(segment.end, t), brightness: clamp01(segment.brightness),
      energy: clamp01(segment.energy), bass: clamp01(segment.bass),
    };
    events.push({
      t, type: EVENT.TRANSITION, confidence: clamp01(segment.confidence || 0.5),
      intensity: clamp01(segment.energy), duration: Math.max(0, shared.end - t),
      effect: 'scene-change',
      data: Object.assign({ from: i > 0 ? (segments[i - 1].role || 'unknown') : null, to: role }, shared),
    });
    events.push({
      t, type: EVENT.SECTION, confidence: clamp01(segment.confidence || 0.5),
      intensity: clamp01(segment.energy), duration: Math.max(0, shared.end - t),
      effect: 'hold', data: shared,
    });
  });

  for (const drop of (Array.isArray(analysis.drops) ? analysis.drops : []) as LegacyDrop[]) {
    const t = num(drop.t != null ? drop.t : drop.time, -1);
    if (t < 0) continue;
    const confidence = clamp01(drop.confidence == null ? 0.5 : drop.confidence);
    const breakdown = drop.breakdownScore == null ? 0.5 : clamp01(drop.breakdownScore);
    const sustain = drop.sustainScore == null ? 0.5 : clamp01(drop.sustainScore);
    const kind = drop.kind || ((breakdown >= 0.4 && sustain >= 0.6) ? 'proper' : 'hype');
    events.push({
      t, type: EVENT.DROP, confidence, intensity: clamp01(0.6 + 0.4 * confidence),
      duration: 0, effect: kind === 'proper' ? 'blinder' : 'flash',
      data: { kind, breakdown, sustain, snapTo: drop.snapTo || 'raw' },
    });
  }

  for (const build of (Array.isArray(analysis.buildups) ? analysis.buildups : []) as LegacyBuildup[]) {
    const t = num(build.start, -1);
    const end = num(build.end, -1);
    if (t < 0 || end <= t) continue;
    events.push({
      t, type: EVENT.BUILDUP, confidence: 0.8,
      intensity: clamp01(build.intensity == null ? (build.strength == null ? 0.7 : build.strength) : build.intensity),
      duration: end - t, effect: 'ramp',
      data: { end, subdivision: num(build.subdivision, 1) || 1 },
    });
  }

  for (const t of (Array.isArray(analysis.kickOnsets) ? analysis.kickOnsets : [])) {
    const time = num(t, -1);
    if (time < 0) continue;
    events.push({
      t: time, type: EVENT.BASS_HIT, confidence: 0.6, intensity: 0.6,
      duration: 0, effect: 'pulse', data: { onBeat: false },
    });
  }

  return events;
}

function byType(events: readonly ShowEvent[]): Map<string, ShowEvent[]> {
  const map = new Map<string, ShowEvent[]>();
  for (const event of events) {
    let group = map.get(event.type);
    if (!group) {
      group = [];
      map.set(event.type, group);
    }
    group.push(event);
  }
  return map;
}

function inSpan(spans: readonly ShowEvent[], t: number, marginBefore = 0, marginAfter = 0): boolean {
  for (const span of spans) {
    const end = span.data && span.data.end != null ? span.data.end as number : span.t + span.duration;
    if (t >= span.t - marginBefore && t <= end + marginAfter) return true;
  }
  return false;
}

function nearAny(events: readonly ShowEvent[], t: number, window: number): boolean {
  for (const event of events) {
    if (Math.abs(event.t - t) <= window) return true;
  }
  return false;
}

export {
  EVENT,
  deriveEvents,
  synthesise,
  normalise,
  byType,
  inSpan,
  nearAny,
};
