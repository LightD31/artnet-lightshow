'use strict';

// The eight seconds before a drop used to get the same treatment whatever the
// music did: beat division 1, then 2, then 4. These cover measuring it instead.
//
// Two independent things happen in that window and they need separate answers:
// the roll (the subdivision doubling that an audience hears as "speeding up",
// at constant tempo) and the ramp (a real BPM change, which the beat clock has
// to follow or the rig drifts out of time exactly when it is most exposed).

const test = require('node:test');
const assert = require('node:assert');

const AutoShow = require('../../src/auto-show');
const { COLOR_PRESETS, PATTERNS } = require('../../src/server/presets');
const { patchSchema } = require('../../src/server/validation');

const BUILD = { start: 72, end: 80, strength: 0.8 };
const DROP_MS = 80000;

/** A show with no rig and no analyzer child process behind it. */
function show() {
  const s = new AutoShow(() => {}, COLOR_PRESETS, PATTERNS);
  // The constructor prewarms the Python analyzer; nothing here analyses
  // anything, and that child process would hold the event loop open.
  s._worker.shutdown();
  return s;
}

/** Onsets at `rate` per second across each [from, to, rate] span. */
function onsets(spans) {
  const out = [];
  for (const [from, to, rate] of spans) {
    for (let t = from; t < to; t += 1 / rate) out.push(+t.toFixed(3));
  }
  return out.sort((a, b) => a - b);
}

/** A 2 s tempo curve, optionally reshaped by `at(t, baseBpm)`. */
function curve(bpm, at) {
  return Array.from({ length: 60 }, (_, i) => {
    const t = i * 2;
    return { t, v: at ? at(t, bpm) : bpm };
  });
}

/** Climbs across the buildup, then holds `after` for the rest of the track. */
const rampTo = (peak, after) => (t, bpm) => (
  t < 72 ? bpm
    : t > 80 ? after
      : bpm + (peak - bpm) * ((t - 72) / 8)
);

function analysis(over = {}) {
  return {
    duration: 120, bpm: 128, tempoStability: 0.95, tempoCurve: curve(128),
    key: 'A', scale: 'minor', meter: 4,
    mood: { valence: 0.7, arousal: 0.9, danceability: 0.9 },
    genre: { label: 'edm', confidence: 0.9 },
    beats: Array.from({ length: 256 }, (_, i) => i * 0.469),
    beatStrengths: Array.from({ length: 256 }, (_, i) => (i % 4 === 0 ? 0.9 : 0.4)),
    downbeats: Array.from({ length: 64 }, (_, i) => i * 1.875),
    downbeatConfidence: 0.9,
    onsets: onsets([[0, 120, 2]]),
    segments: [
      { start: 0, end: 60, level: 'mid', energy: 0.5, brightness: 0.5, bass: 0.5, label: 'a' },
      { start: 60, end: 120, level: 'high', energy: 0.9, brightness: 0.8, bass: 0.8, label: 'b' },
    ],
    buildups: [BUILD],
    drops: [{ time: 80, confidence: 0.9, kind: 'proper' }],
    ...over,
  };
}

/** Build a timeline and return the patches inside the buildup window. */
function buildupPatches(a, intensity = 60) {
  const s = show();
  s.analysis = a;
  s.intensity = intensity;
  s.buildTimeline();
  return s.timeline.filter(
    (e) => e.action === 'patch' && e.timeMs >= 72000 && e.timeMs <= DROP_MS,
  );
}

const bpmPatches = (patches) => patches.filter((e) => e.data.bpm !== undefined);
const divisions = (patches) => patches
  .filter((e) => e.data.beatDivision !== undefined)
  .map((e) => e.data.beatDivision);

// ── The roll ────────────────────────────────────────────────────────────────

test('the beat division follows how far the roll actually subdivides', () => {
  const s = show();
  const at = (spans) => s._buildupAccel(BUILD, { onsets: onsets(spans), tempoCurve: [] }, 128);

  // A riser with no roll under it: the rig should not sprint through it.
  const none = at([[70, 80, 2]]);
  assert.strictEqual(none.peakDivision, 2, 'no roll, no escalation');

  // One doubling — eighths to sixteenths, the common case.
  const once = at([[70, 75.4, 2], [75.4, 80, 4]]);
  assert.strictEqual(once.peakDivision, 4);
  assert.strictEqual(once.riseDivision, 2, 'the rise sits one doubling below the peak');

  // Two doublings — all the way to thirty-seconds.
  const twice = at([[70, 75.4, 2], [75.4, 80, 8]]);
  assert.strictEqual(twice.peakDivision, 8);
  assert.strictEqual(twice.riseDivision, 4);
});

test('a buildup that starts from silence is not read as a roll', () => {
  // Nothing in the early third makes the ratio a division by ~zero, which would
  // read as an enormous acceleration and slam the rig to its fastest division.
  const s = show();
  const r = s._buildupAccel(BUILD, { onsets: onsets([[77, 80, 8]]), tempoCurve: [] }, 128);
  assert.strictEqual(r, null, 'nothing measurable, so the caller keeps its default');
});

test('a measured roll reaches the timeline', () => {
  const hard = buildupPatches(analysis({
    onsets: onsets([[0, 75.4, 2], [75.4, 80, 8], [80, 120, 4]]),
  }));
  assert.ok(divisions(hard).includes(8), `expected a 1/32 peak, got ${divisions(hard)}`);

  const soft = buildupPatches(analysis({ onsets: onsets([[0, 120, 2]]) }));
  assert.ok(!divisions(soft).includes(8), 'a flat buildup must not reach the fastest division');
});

test('a triple metre keeps beat division at 1 however hard the roll goes', () => {
  // Subdividing 3/4 by two puts the rig on the off-beats of the bar.
  const patches = buildupPatches(analysis({
    meter: 3,
    onsets: onsets([[0, 75.4, 2], [75.4, 80, 8], [80, 120, 4]]),
  }));
  assert.deepStrictEqual(
    [...new Set(divisions(patches))], [1],
    'every buildup division should stay at 1 in 3/4',
  );
});

// ── The ramp ────────────────────────────────────────────────────────────────

test('a steady track gets no tempo patches at all', () => {
  const patches = buildupPatches(analysis());
  assert.deepStrictEqual(bpmPatches(patches), [], 'nothing to follow, nothing emitted');
});

test('a tempo push that resolves is undone at the drop', () => {
  // Otherwise every pattern after the drop runs at the buildup's peak tempo.
  const patches = buildupPatches(analysis({
    tempoCurve: curve(128, rampTo(140, 128)),
  }));
  const bpms = bpmPatches(patches);
  assert.ok(bpms.length >= 2, `expected a ramp, got ${JSON.stringify(bpms)}`);
  assert.ok(bpms.some((e) => e.data.bpm > 130), 'the clock follows the push up');

  const last = bpms[bpms.length - 1];
  assert.strictEqual(last.timeMs, DROP_MS, 'the last word lands on the drop');
  assert.strictEqual(last.data.bpm, 128, 'and puts the clock back where the track is');
});

test('a genuine tempo change is kept past the drop', () => {
  const patches = buildupPatches(analysis({
    tempoCurve: curve(128, rampTo(140, 140)),
  }));
  const last = bpmPatches(patches).pop();
  assert.strictEqual(last.timeMs, DROP_MS);
  assert.strictEqual(last.data.bpm, 140, 'the track really did change tempo');
});

// The bug this guards against is a coin toss, which is worse than a wrong
// answer: a ramp point landing on the drop put two BPM patches on the same
// millisecond, and which one survived came down to the sort being stable. Lose
// it and the rig runs the whole rest of the track at the buildup's peak tempo.
test('no two tempo patches ever land on the same millisecond', () => {
  for (const after of [128, 140]) {
    const patches = buildupPatches(analysis({ tempoCurve: curve(128, rampTo(140, after)) }));
    const times = bpmPatches(patches).map((e) => e.timeMs);
    assert.strictEqual(
      new Set(times).size, times.length,
      `two tempo patches share a timestamp: ${times}`,
    );
  }
});

test('a drifting track leaves the tempo to the periodic path', () => {
  // Below 0.60 stability the builder already emits BPM across the whole track
  // from the same curve. A second source of truth for the beat clock would
  // fight the first, so the buildup stays out of it.
  //
  // The periodic path still emits here — the curve peaks at the drop — so the
  // tell is the *value*: it tracks the curve (140), where a buildup settle
  // would have forced the post-drop tempo (128) onto the same instant.
  const patches = buildupPatches(analysis({
    tempoStability: 0.3,
    tempoCurve: curve(128, rampTo(140, 128)),
  }));

  const atDrop = bpmPatches(patches).filter((e) => e.timeMs === DROP_MS);
  assert.strictEqual(atDrop.length, 1, `one source of truth, got ${JSON.stringify(atDrop)}`);
  assert.strictEqual(atDrop[0].data.bpm, 140, 'the curve, not a settle the buildup invented');
});

// ── Everything still has to be a patch the engine accepts ──────────────────

test('every buildup patch validates, at any roll and any intensity', () => {
  for (const intensity of [40, 60, 100]) {
    for (const spans of [[[0, 120, 2]], [[0, 75.4, 2], [75.4, 80, 8], [80, 120, 4]]]) {
      const patches = buildupPatches(
        analysis({ onsets: onsets(spans), tempoCurve: curve(128, rampTo(140, 128)) }),
        intensity,
      );
      for (const e of patches) {
        const result = patchSchema.safeParse(e.data);
        assert.ok(
          result.success,
          `intensity ${intensity}: ${JSON.stringify(e.data)} — ` +
          (result.error ? result.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ') : ''),
        );
      }
    }
  }
});
