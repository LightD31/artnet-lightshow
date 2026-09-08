'use strict';

// The generated timeline is fired from a timer, and applyPatch throws on a
// value the schema rejects. So an out-of-range number in here is not a bad
// look — it is an uncaught exception that ends the process mid-set, leaving the
// rig stuck on whatever it was last told.
//
// That is not hypothetical: the buildup peak scaled a strobe speed of 220 by an
// intensity factor of up to 1.5, so any intensity above 58 emitted 330 and
// killed the show the first time a track had a buildup in it.
//
// Rather than pin the one line that was wrong, these tests push every patch the
// builder can emit through the real schema, across the whole intensity range.

const test = require('node:test');
const assert = require('node:assert');

const AutoShow = require('../../src/auto-show');
const { COLOR_PRESETS, PATTERNS } = require('../../src/server/presets');
const { patchSchema } = require('../../src/server/validation');

/**
 * An analysis that exercises the paths that emit numbers: a buildup (tension /
 * rise / peak / gap), a drop, and segments at each energy level. Tempo is
 * marked unstable with a curve so the periodic-BPM path runs too.
 */
function analysis(overrides = {}) {
  return {
    duration: 200,
    bpm: 128,
    tempoStability: 0.4,
    tempoCurve: [{ t: 0, v: 128 }, { t: 60, v: 140 }, { t: 120, v: 124 }],
    key: 'A',
    scale: 'minor',
    keyStrength: 0.8,
    meter: 4,
    mood: { valence: 0.7, arousal: 0.9, danceability: 0.9 },
    genre: { label: 'edm', confidence: 0.9 },
    beats: Array.from({ length: 400 }, (_, i) => i * 0.46875),
    beatStrengths: Array.from({ length: 400 }, (_, i) => (i % 4 === 0 ? 0.9 : 0.4)),
    downbeats: Array.from({ length: 100 }, (_, i) => i * 1.875),
    downbeatConfidence: 0.9,
    onsets: Array.from({ length: 200 }, (_, i) => i * 0.9),
    segments: [
      { start: 0,   end: 40,  level: 'low',  energy: 0.2, brightness: 0.2, bass: 0.2, label: 'a' },
      { start: 40,  end: 80,  level: 'mid',  energy: 0.5, brightness: 0.5, bass: 0.5, label: 'b' },
      { start: 80,  end: 140, level: 'high', energy: 0.9, brightness: 0.8, bass: 0.8, label: 'c' },
      { start: 140, end: 200, level: 'high', energy: 0.75, brightness: 0.3, bass: 0.9, label: 'd' },
    ],
    buildups: [{ start: 70, end: 80 }, { start: 130, end: 132 }],
    drops: [{ time: 80, confidence: 0.9, kind: 'proper' },
            { time: 140, confidence: 0.6, kind: 'proper' }],
    ...overrides,
  };
}

/** A show wired to the real preset and pattern tables, with no live rig. */
function show() {
  const s = new AutoShow(() => {}, COLOR_PRESETS, PATTERNS);
  // The constructor prewarms the Python analyzer so the first real analyze does
  // not pay its cold start. Nothing here analyses anything, and that child
  // process would hold the event loop open and hang the run.
  s._worker.shutdown();
  return s;
}

/** Every patch the timeline would apply, as the engine would receive it. */
function patches(s) {
  return s.timeline.filter((e) => e.action === 'patch').map((e) => e.data);
}

test('every patch the timeline emits is one the engine will accept', () => {
  // 50 is the default; 100 is the slider hard over, which is where this broke.
  for (const intensity of [0, 25, 50, 58, 75, 100]) {
    for (const paletteSize of [2, 3, 4]) {
      const s = show();
      s.analysis = analysis();
      s.intensity = intensity;
      s.paletteSize = paletteSize;
      s.buildTimeline();

      const emitted = patches(s);
      assert.ok(emitted.length > 0, `intensity ${intensity} produced no patches`);

      for (const data of emitted) {
        const result = patchSchema.safeParse(data);
        assert.ok(
          result.success,
          `intensity ${intensity}, palette ${paletteSize}: ${JSON.stringify(data)} — ` +
          (result.error ? result.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ') : ''),
        );
      }
    }
  }
});

test('the intensity range emits a strobe speed the DMX channel can carry', () => {
  // The specific regression: strobeSpeed is one byte, and the buildup peak
  // multiplies its base by an intensity factor before sending it.
  const seen = new Set();
  for (let intensity = 0; intensity <= 100; intensity += 5) {
    const s = show();
    s.analysis = analysis();
    s.intensity = intensity;
    s.buildTimeline();

    for (const data of patches(s)) {
      if (data.strobeSpeed === undefined) continue;
      seen.add(data.strobeSpeed);
      assert.ok(
        Number.isInteger(data.strobeSpeed) && data.strobeSpeed >= 0 && data.strobeSpeed <= 255,
        `intensity ${intensity} emitted strobeSpeed ${data.strobeSpeed}`,
      );
    }
  }
  assert.ok(seen.size > 1, 'intensity should still change the strobe speed, not just clamp it flat');
});

test('a nonsense tempo out of the analyser does not produce an invalid patch', () => {
  // The analyser is a separate process doing signal processing on arbitrary
  // audio. A tempo of 0 or 900 is a bad analysis; it should not be fatal.
  for (const bpm of [0, 5, 900, NaN, undefined]) {
    const s = show();
    s.analysis = analysis({ bpm, tempoStability: 1 });
    s.buildTimeline();

    for (const data of patches(s)) {
      if (data.bpm === undefined) continue;
      assert.ok(
        patchSchema.safeParse({ bpm: data.bpm }).success,
        `bpm ${bpm} from the analyser became ${data.bpm} in a patch`,
      );
    }
  }
});

// Belt and braces for everything above: even if some future path does emit
// something the schema rejects, it must cost that one event, not the process.
test('an event the engine rejects is skipped rather than ending the show', () => {
  const applied = [];
  const s = new AutoShow((patch) => {
    applied.push(patch);
    if (patch.pattern === 'poison') throw new Error('patch: rejected');
  }, COLOR_PRESETS, PATTERNS);
  s._worker.shutdown();

  let position = 0;
  s.timeline = [
    { timeMs: 0, action: 'patch', data: { pattern: 'chase' } },
    { timeMs: 100, action: 'patch', data: { pattern: 'poison' } },
    { timeMs: 200, action: 'patch', data: { pattern: 'split' } },
  ];
  s.start(() => position);
  clearInterval(s._loopTimer);
  s._loopTimer = null;

  position = 1000;
  assert.doesNotThrow(() => s._tick(), 'a rejected patch must not escape the tick');
  assert.deepStrictEqual(
    applied.map((p) => p.pattern), ['chase', 'poison', 'split'],
    'the show carries on past the event it could not apply',
  );
  s.stop();
});
