// Accents on the drums as they were played: on the kick or the snare that
// marks a bar rather than on the grid's idea of the bar line, none on a bar
// nothing was hit on, and one on the last hit of a fill into a new section.
// Only for lanes the analyser found with the rules measured on real drumming
// (src/analysis/pulse.py, scripts/eval-drums.py), and only their strong hits.

import test from 'node:test';
import assert from 'node:assert';

import { ShowDirector } from '../../src/show/director.ts';
import { INTENT } from '../../src/show/intents.ts';
import { COLOR_PRESETS, PATTERNS } from '../../src/server/presets.ts';

const BPM = 128;
const BEAT = 60 / BPM;
const BAR = BEAT * 4;
const at = (bar) => +(bar * BAR).toFixed(3);
// The kick lands a little after the tracker's downbeat, as a real one does.
const LATE = 0.025;

/** A dance track: intro, verse, chorus, verse, chorus, outro — and its drums. */
function analysis({ lanes = true, detector = 2, source = 'stems', silentBars = [], fillBefore = null } = {}) {
  const bars = 96;
  const beats = [];
  const downbeats = [];
  for (let bar = 0; bar < bars; bar++) {
    downbeats.push(at(bar));
    for (let b = 0; b < 4; b++) beats.push(+((bar * 4 + b) * BEAT).toFixed(3));
  }
  const kick = { t: [], s: [] };
  const snare = { t: [], s: [] };
  const hats = { t: [], s: [] };
  for (let bar = 8; bar < 88; bar++) {
    if (silentBars.includes(bar)) continue;
    for (let b = 0; b < 4; b++) {
      const t = +((bar * 4 + b) * BEAT + LATE).toFixed(3);
      kick.t.push(t); kick.s.push(b === 0 ? 0.95 : 0.8);
      if (b % 2 === 1) { snare.t.push(t); snare.s.push(0.85); }
      hats.t.push(+(t + BEAT / 2).toFixed(3)); hats.s.push(0.5);
    }
  }
  if (fillBefore != null) {
    // Four snare hits across the second half of the bar before the section.
    for (let k = 0; k < 4; k++) { snare.t.push(+(at(fillBefore) - BAR / 2 + k * BEAT / 2 + LATE).toFixed(3)); snare.s.push(0.8); }
    snare.t.sort((a, b) => a - b);
  }
  const doc = {
    duration: bars * BAR, bpm: BPM, meter: 4, tempoStability: 0.95, tempoCurve: [],
    key: 'A', scale: 'minor',
    mood: { valence: 0.6, arousal: 0.85, danceability: 0.85 },
    genre: { label: 'edm', confidence: 0.9, style: 'dance' },
    beats, beatStrengths: beats.map((_, i) => (i % 4 === 0 ? 0.9 : 0.4)),
    downbeats, downbeatConfidence: 0.9, onsets: beats.slice(),
    segments: [
      { start: at(0), end: at(8), role: 'intro', level: 'low', label: 'A' },
      { start: at(8), end: at(24), role: 'verse', level: 'mid', label: 'B' },
      { start: at(24), end: at(40), role: 'chorus', level: 'high', label: 'C' },
      { start: at(40), end: at(56), role: 'verse', level: 'mid', label: 'B' },
      { start: at(56), end: at(88), role: 'chorus', level: 'high', label: 'C' },
      { start: at(88), end: at(96), role: 'outro', level: 'low', label: 'D' },
    ],
    drops: [], buildups: [],
  };
  if (lanes) {
    doc.pulse = {
      rate: 50, encoding: 'u8-base64', source, envelopes: { mix: '' }, lanes: { kick, snare, hats },
      ...(detector != null ? { detector } : {}),
    };
  }
  return doc;
}

function accents(doc, intensity = 75) {
  const director = new ShowDirector({ patterns: PATTERNS, colorPresets: COLOR_PRESETS, paletteSize: 4, intensity });
  return director.plan(doc).intents.filter((i) => i.kind === INTENT.ACCENT);
}

test('a bar accent lands on the kick that marks the bar, not on the grid', () => {
  const doc = analysis();
  const kicks = new Set(doc.pulse.lanes.kick.t.map((t) => Math.round(t * 1000)));
  const bars = accents(doc).filter((a) => a.source === 'bar');
  assert.ok(bars.length >= 6, `the choruses are accented (${bars.length})`);
  for (const a of bars) assert.ok(kicks.has(a.timeMs), `${a.timeMs} ms is a kick`);
});

test('a bar line nothing was hit on gets no accent', () => {
  const silent = [];
  for (let bar = 60; bar < 72; bar++) silent.push(bar);
  const bars = accents(analysis({ silentBars: silent })).filter((a) => a.source === 'bar');
  assert.ok(bars.length >= 4, 'the rest of the track still gets its accents');
  for (const a of bars) {
    assert.ok(a.timeMs < at(60) * 1000 - 100 || a.timeMs >= at(72) * 1000 - 100, `an accent at ${a.timeMs} ms, in the bars the drums sat out`);
  }
});

test('a fill into a new section is marked on its last hit', () => {
  const doc = analysis({ fillBefore: 56 });
  const fills = accents(doc).filter((a) => a.source === 'fill');
  assert.strictEqual(fills.length, 1, 'one fill, one accent');
  const lastHit = +(at(56) - BAR / 2 + 3 * BEAT / 2 + LATE).toFixed(3);
  assert.strictEqual(fills[0].timeMs, Math.round(lastHit * 1000));
});

test('lanes from the first rules, or no lanes at all, leave the accents on the grid', () => {
  const grid = accents(analysis({ lanes: false }));
  for (const doc of [analysis({ detector: null })]) {
    assert.deepStrictEqual(accents(doc).map((a) => [a.timeMs, a.burst]), grid.map((a) => [a.timeMs, a.burst]));
  }
  const downbeats = new Set(analysis().downbeats.map((t) => Math.round(t * 1000)));
  for (const a of grid.filter((x) => x.source === 'bar')) assert.ok(downbeats.has(a.timeMs));
});

test('without separation only the kick is trusted: no fills from the snare', () => {
  const fills = accents(analysis({ source: 'mix', fillBefore: 56 })).filter((a) => a.source === 'fill');
  assert.strictEqual(fills.length, 0);
});
