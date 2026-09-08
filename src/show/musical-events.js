'use strict';

/**
 * The musical event stream, as the show engine sees it.
 *
 * The analyser produces this stream (see `src/analysis/events.py`) and the
 * director consumes it. This module is the boundary: it defines the vocabulary,
 * normalises whatever the analyser handed over, and — importantly — synthesises
 * an equivalent stream from an older analysis document that predates the event
 * layer.
 *
 * That last part is not decoration. Analyses are cached on disk between runs
 * and a cache is worth nothing if a schema change invalidates it, so a 1.x
 * document still produces a full show; it just produces one without the events
 * only the new pipeline can find (vocal spans, melody changes, per-band hits).
 *
 * Every event has the same shape:
 *
 *   { t, type, confidence, intensity, duration, effect, data }
 *
 * `t` is seconds from the start of the track. `intensity` is a musical
 * magnitude, not a brightness — the director decides what to spend on it.
 */

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

const num = (v, fallback = 0) => (Number.isFinite(Number(v)) ? Number(v) : fallback);
const clamp01 = (v) => Math.max(0, Math.min(1, num(v, 0)));

/**
 * Normalise one event, filling in anything the producer left out.
 * Returns null for an event with no usable timestamp — a NaN `t` would sort
 * unpredictably and then fire at a moment nobody can reason about.
 */
function normalise(raw) {
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
    data: raw.data && typeof raw.data === 'object' ? raw.data : {},
  };
}

/**
 * The event stream for an analysis document.
 *
 * Prefers the analyser's own stream; falls back to synthesising one. Always
 * returns a time-sorted array, and never throws on a malformed document — a
 * bad analysis should cost the show its nuance, not its existence.
 */
function deriveEvents(analysis) {
  if (!analysis || typeof analysis !== 'object') return [];
  const supplied = Array.isArray(analysis.events) ? analysis.events : null;
  const events = supplied && supplied.length
    ? supplied.map(normalise).filter(Boolean)
    : synthesise(analysis);
  events.sort((a, b) => a.t - b.t || priority(a.type) - priority(b.type));
  return events;
}

// Ties at the same instant resolve in this order, so a director processing the
// stream in sequence sees context (the section) before the thing that happens
// inside it (the drop), and the drop last of all — it must win.
const ORDER = [EVENT.SECTION, EVENT.TRANSITION, EVENT.BAR, EVENT.BEAT,
  EVENT.BASS_HIT, EVENT.MELODY_CHANGE, EVENT.VOCAL_SECTION, EVENT.BREAK,
  EVENT.SILENCE, EVENT.ENERGY_SPIKE, EVENT.BUILDUP, EVENT.DROP];

function priority(type) {
  const index = ORDER.indexOf(type);
  return index < 0 ? ORDER.length : index;
}

/**
 * Build an event stream from a pre-event-layer analysis document.
 *
 * Only the types the old document can support are produced. There is no
 * guessing at vocal spans or melodic movement from fields that never carried
 * them — a missing event type is a show with less nuance, an invented one is a
 * show that lights the wrong moments confidently.
 */
function synthesise(analysis) {
  const events = [];
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
    // Pre-2.0 documents have no section roles; `level` is all they carry, and
    // inventing "chorus" from an energy tier would be a guess the director
    // would then trust. `unknown` is the honest answer and the director has a
    // path for it.
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

  for (const drop of (Array.isArray(analysis.drops) ? analysis.drops : [])) {
    // Older documents used `t`; a couple of fixtures in the wild use `time`.
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

  for (const build of (Array.isArray(analysis.buildups) ? analysis.buildups : [])) {
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

/** Group a stream by type, for the director's lookups. */
function byType(events) {
  const map = new Map();
  for (const event of events) {
    if (!map.has(event.type)) map.set(event.type, []);
    map.get(event.type).push(event);
  }
  return map;
}

/** Does `t` fall inside any of these span events (with an optional margin)? */
function inSpan(spans, t, marginBefore = 0, marginAfter = 0) {
  for (const span of spans) {
    const end = span.data && span.data.end != null ? span.data.end : span.t + span.duration;
    if (t >= span.t - marginBefore && t <= end + marginAfter) return true;
  }
  return false;
}

/** Is `t` within `window` seconds of any of these instant events? */
function nearAny(events, t, window) {
  for (const event of events) {
    if (Math.abs(event.t - t) <= window) return true;
  }
  return false;
}

module.exports = { EVENT, deriveEvents, synthesise, normalise, byType, inSpan, nearAny };
