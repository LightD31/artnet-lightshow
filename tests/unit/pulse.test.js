// The music at pixel rate: the analysis's stem envelopes and drum lanes, read
// at the playback position every frame, and the LED bar patterns that draw
// them — the kick filling a bar from its middle, the snare at its ends, the
// hats scattered, each stem in its own zone.

import test from 'node:test';
import assert from 'node:assert';

import { pulseTrack, DECAY_MS } from '../../src/show/pulse.ts';
import { PATTERN_FUNCS, CELL_PATTERNS } from '../../src/shared/patterns.ts';
import { COLOR_PRESETS, PATTERNS } from '../../src/server/presets.ts';
import { availableFor, pickPattern, PULSE_PATTERNS } from '../../src/show/look.ts';
import { renderInput, setPulseSource } from '../../src/server/engine.ts';
import AutoShow from '../../src/auto-show.ts';

const b64 = (values) => Buffer.from(Uint8Array.from(values)).toString('base64');

function block({ stems = true } = {}) {
  const envelopes = { mix: b64([0, 255, 128, 64]) };
  if (stems) Object.assign(envelopes, { drums: b64([255, 0, 0, 0]), bass: b64([10, 20, 30, 40]), vocals: b64([0, 0, 0, 0]), other: b64([128, 128, 128, 128]) });
  return {
    rate: 50, encoding: 'u8-base64', source: stems ? 'stems' : 'mix', envelopes,
    lanes: { kick: { t: [1.0, 2.0], s: [0.8, 1] }, snare: { t: [1.5], s: [0.6] }, hats: { t: [], s: [] } },
  };
}

test('the envelopes are read fifty times a second and interpolated between', () => {
  const track = pulseTrack(block());
  assert.strictEqual(track.stems, true);
  assert.strictEqual(track.at(0).mix, 0);
  assert.strictEqual(track.at(20).mix, 1, 'the second point, 20 ms in');
  assert.ok(Math.abs(track.at(10).mix - 0.5) < 1e-9, 'halfway between the first two');
  assert.strictEqual(track.at(9999).mix, 64 / 255, 'the last point holds past the end');
  assert.strictEqual(track.at(-50).mix, 0, 'and the first before the start');
  assert.strictEqual(track.at(0).drums, 1);
  assert.ok(Math.abs(track.at(20).other - 128 / 255) < 1e-9);
});

test('a drum hit is its strength on the hit and fades after it, a kick slower than a hat', () => {
  const track = pulseTrack(block());
  assert.strictEqual(track.at(999).kick, 0, 'nothing before the first kick');
  assert.strictEqual(track.at(1000).kick, 0.8);
  assert.ok(Math.abs(track.at(1000 + DECAY_MS.kick).kick - 0.8 / Math.E) < 1e-9);
  assert.strictEqual(track.at(2000).kick, 1, 'the next kick takes over');
  assert.strictEqual(track.at(1500).snare, 0.6);
  assert.strictEqual(track.at(1500).hats, 0, 'an empty lane is silent');
  assert.ok(DECAY_MS.kick > DECAY_MS.snare && DECAY_MS.snare > DECAY_MS.hats);
});

test('an unseparated track has the mix and the lanes but no stems, and a broken block is no pulse', () => {
  const plain = pulseTrack(block({ stems: false }));
  assert.strictEqual(plain.stems, false);
  const reading = plain.at(1000);
  assert.deepStrictEqual(Object.keys(reading).sort(), ['hats', 'kick', 'mix', 'snare']);
  assert.strictEqual(pulseTrack(null), null);
  assert.strictEqual(pulseTrack({ ...block(), encoding: 'f32' }), null, 'an encoding it cannot read');
  assert.strictEqual(pulseTrack({ ...block(), envelopes: { mix: '***not base64***' } }), null);
  assert.strictEqual(pulseTrack({ ...block(), envelopes: { drums: b64([1]) } }), null, 'no mix');
});

// ── The patterns ─────────────────────────────────────────────────────────────

const RED = COLOR_PRESETS[0];
const BLUE = COLOR_PRESETS[5];
const GREEN = COLOR_PRESETS[3];
const TRIO = [RED, BLUE, GREEN, RED];

function draw(id, { n = 17, colors = TRIO, ...ctx } = {}) {
  const out = [];
  PATTERN_FUNCS[id]({
    colors, fixtureCount: n, step: 0, hue: 0, twinkle: new Array(n).fill(0),
    write: (i, c, d) => { out[i] = [c, d]; }, ...ctx,
  });
  return out;
}
const quiet = { mix: 0.5, kick: 0, snare: 0, hats: 0 };

test('drums and stems are pixel patterns the picker lists', () => {
  for (const id of ['drums', 'stems']) {
    assert.ok(CELL_PATTERNS.has(id), id);
    assert.strictEqual(PATTERNS.find((p) => p.id === id).pixel, true, id);
    assert.ok(PULSE_PATTERNS.has(id));
  }
});

test('the kick fills the bar from its middle, the snare cracks at its ends', () => {
  const kick = draw('drums', { pulse: { ...quiet, kick: 1 } });
  assert.deepStrictEqual(kick[8], [RED, 255], 'the middle, full, in colour A');
  assert.ok(kick[0][1] < 255 && kick[16][1] < 255, 'a full kick reaches almost to the ends');
  const soft = draw('drums', { pulse: { ...quiet, kick: 0.3 } });
  assert.ok(soft[8][1] > soft[2][1], 'a soft one fills less of it');

  const snare = draw('drums', { pulse: { ...quiet, snare: 1 } });
  assert.deepStrictEqual([snare[0][0], snare[16][0]], [BLUE, BLUE], 'the ends, in colour B');
  assert.strictEqual(snare[0][1], 255);
  assert.ok(snare[8][1] < 100, 'and not the middle');

  const hats = draw('drums', { pulse: { ...quiet, hats: 1 }, stepPos: 3 });
  const lit = hats.filter(([c, d]) => c === GREEN && d === 255).length;
  assert.ok(lit >= 1 && lit <= 10, `a scatter of cells in colour C: ${lit}`);
  const moved = draw('drums', { pulse: { ...quiet, hats: 1 }, stepPos: 3.5 });
  assert.notDeepStrictEqual(moved, hats, 'that moves on with the next off-beat');

  const nothing = draw('drums', { pulse: quiet });
  assert.ok(nothing.every(([, d]) => d < 60), 'between hits, a dim bed');
});

test('without a pulse the kit is played by the clock', () => {
  const onTheStep = draw('drums', { step: 1, stepPhase: 0, stepPos: 1 });
  assert.strictEqual(onTheStep[8][1], 255, 'a kick on the step');
  assert.strictEqual(onTheStep[0][0], BLUE, 'and a snare on every other one');
  const later = draw('drums', { step: 2, stepPhase: 0.9, stepPos: 2.9 });
  assert.ok(later[8][1] < onTheStep[8][1], 'fading through the step');
});

test('each stem lights its own zone, the voice at the centre and the bass at the ends', () => {
  const vocal = draw('stems', { pulse: { ...quiet, vocals: 1, other: 0, drums: 0, bass: 0 } });
  assert.deepStrictEqual(vocal[8], [RED, 255]);
  assert.ok(vocal[0][1] < 20, 'the bass zone is dark');
  const bass = draw('stems', { pulse: { ...quiet, vocals: 0, other: 0, drums: 0, bass: 1 } });
  assert.strictEqual(bass[0][1], 255);
  assert.strictEqual(bass[0][0], TRIO[3], 'in the fourth colour');
  assert.ok(bass[8][1] < 20);
  const unseparated = draw('stems', { pulse: quiet, dynamics: { level: 0.5, bass: 0.9, vocal: 0.1, air: 0.2, width: 0.5, motion: 0.3, decay: 0.3 } });
  assert.ok(unseparated[0][1] > unseparated[8][1], 'the expression channel stands in for the stems');
});

test('the meter reads the bass stem and the kick when it has them', () => {
  const low = draw('meter', { pulse: { mix: 0.9, bass: 0.1, kick: 0, snare: 0, hats: 0 } });
  const high = draw('meter', { pulse: { mix: 0.9, bass: 1, kick: 1, snare: 0, hats: 0 } });
  const lit = (out) => out.filter(([, d]) => d === 255).length;
  assert.ok(lit(high) > lit(low) + 4, `${lit(high)} cells against ${lit(low)}`);
});

// ── The show ─────────────────────────────────────────────────────────────────

test('the show reaches for them only for a track that has a pulse', () => {
  const all = availableFor(PATTERNS, { pulse: block() });
  const none = availableFor(PATTERNS, {});
  assert.ok(all.has('drums') && all.has('stems'));
  assert.ok(!none.has('drums') && !none.has('stems'));
  assert.ok(none.has('comet'), 'the other pixel patterns stay');

  // A groove on a rig with bars: across seeds, the drums come up when they may.
  const groove = { kick: 0.9, bassline: 0.8, vocal: 0.1, energy: 0.7, pulse: 0.8, texture: 0.2, hats: 0.3 };
  const picks = (available) => new Set(Array.from({ length: 40 }, (_, seed) =>
    pickPattern({ character: groove, available, seed, drive: 0.6, dance: 0.7, pixels: true })));
  assert.ok(picks(all).has('drums'));
  assert.ok(!picks(none).has('drums'));
  const pars = new Set(Array.from({ length: 40 }, (_, seed) =>
    pickPattern({ character: groove, available: all, seed, drive: 0.6, dance: 0.7, pixels: false })));
  assert.ok(!pars.has('drums'), 'a rig of pars never sees them');
});

test('the engine reads the show\'s pulse into every frame\'s input', () => {
  setPulseSource(() => ({ mix: 0.4, kick: 1, snare: 0, hats: 0 }));
  try {
    assert.deepStrictEqual(renderInput().pulse, { mix: 0.4, kick: 1, snare: 0, hats: 0 });
    setPulseSource(() => { throw new Error('boom'); });
    assert.strictEqual(renderInput().pulse, null, 'a failing source costs the pulse, not the frame');
  } finally {
    setPulseSource(null);
  }
  assert.strictEqual(renderInput().pulse, null);
});

test('the auto show answers with the pulse where it is playing, and nothing when stopped', () => {
  const show = new AutoShow(() => {}, [{ name: 'Blackout' }], []);
  try {
    show.analysis = { duration: 10, bpm: 120, beats: [0, 0.5, 1, 1.5, 2], downbeats: [0, 2], segments: [], events: [], pulse: block() };
    show.buildTimeline();
    show.timeline = [{ timeMs: 60 * 60 * 1000, action: 'marker', data: {} }];
    assert.strictEqual(show.pulse(), null, 'not running');
    let position = 1000;
    show.useFrameClock();
    show.start(() => position);
    assert.strictEqual(show.pulse().kick, 0.8);
    position = 1500;
    assert.strictEqual(show.pulse().snare, 0.6);
    show.stop();
    assert.strictEqual(show.pulse(), null);
    show.reset();
    assert.strictEqual(show._pulse, null);
  } finally {
    show.stop();
    show._worker.shutdown();
  }
});
