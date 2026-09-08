'use strict';

// The renderer is the last thing between the show's judgement and a DMX frame,
// so its job is narrow and its failures are loud: the timeline fires from a
// timer, and a value the patch schema rejects is an uncaught exception that
// ends the process mid-set with the rig stuck on whatever it was last told.

const test = require('node:test');
const assert = require('node:assert');

const { renderIntents, debounceBursts, DEBOUNCE_SAFETY_MS } =
  require('../../src/show/render');
const { scene, color, accent, tempo, dark, BURST } = require('../../src/show/intents');
const { patchSchema } = require('../../src/server/validation');

const patches = (events) => events.filter((e) => e.action === 'patch');
const bursts = (events) => events.filter((e) => e.action === 'energy');

test('a scene becomes one patch carrying the whole look', () => {
  const [event] = renderIntents([scene(1000, {
    pattern: 'chase', colors: [1, 2, 3, 4], beatDivision: 2,
    strobeSpeed: 100, strobeFunction: 'random',
  })]);
  assert.strictEqual(event.action, 'patch');
  assert.strictEqual(event.timeMs, 1000);
  assert.deepStrictEqual(event.data, {
    pattern: 'chase', colorA: 1, colorB: 2, colorC: 3, colorD: 4,
    beatDivision: 2, strobeSpeed: 100, strobeFunction: 'random',
    energyOverride: null,
  });
});

test('a colour move touches only the slots it was given', () => {
  const [event] = renderIntents([color(500, [7])]);
  assert.deepStrictEqual(event.data, { colorA: 7 });
});

test('an accent becomes an energy burst', () => {
  const [event] = renderIntents([accent(2000, BURST.BLINDER, 400)]);
  assert.strictEqual(event.action, 'energy');
  assert.deepStrictEqual(event.data, { id: 'blinder', durationMs: 400 });
});

test('going dark sets the blackout colour and stops everything moving', () => {
  const [event] = renderIntents([dark(300)], { blackoutIndex: 9 });
  assert.deepStrictEqual(event.data, { colorA: 9, strobeSpeed: 0, beatDivision: 1 });
});

test('build-up phases leave a running burst alone', () => {
  // They are layered *under* a burst that is already playing; clearing the
  // energy override there would cancel the thing they decorate.
  const events = renderIntents([
    scene(100, { pattern: 'strobe' }, { source: 'buildup:peak' }),
    scene(200, { pattern: 'chase' }, { source: 'section:chorus' }),
  ]);
  assert.ok(!('energyOverride' in events[0].data));
  assert.strictEqual(events[1].data.energyOverride, null);
});

// ── Clamping ────────────────────────────────────────────────────────────────

test('out-of-range values are clamped rather than passed to the schema', () => {
  // The bug this guards against is real: a build-up peak scaled a strobe speed
  // of 220 by an intensity factor of 1.5, and any intensity above 58 emitted
  // 330 and killed the show the first time a track had a build-up in it.
  const [event] = renderIntents([scene(0, {
    pattern: 'strobe', strobeSpeed: 330, beatDivision: 64, bpm: 1e9,
  })]);
  assert.ok(patchSchema.safeParse(event.data).success,
    JSON.stringify(event.data));
  assert.strictEqual(event.data.strobeSpeed, 255);
  assert.strictEqual(event.data.beatDivision, 16);
  assert.strictEqual(event.data.bpm, 300);
});

test('every patch a plausible intent stream produces is one the engine accepts', () => {
  const intents = [];
  for (let i = 0; i < 50; i++) {
    intents.push(scene(i * 1000, {
      pattern: 'chase', colors: [i % 12, (i + 1) % 12, (i + 2) % 12, (i + 3) % 12],
      beatDivision: [1, 2, 4, 8][i % 4], strobeSpeed: i * 13,
      strobeFunction: 'standard',
    }));
    intents.push(accent(i * 1000 + 500, BURST.COLOR_STROBE, 300));
    intents.push(tempo(i * 1000 + 750, 60 + i * 7));
  }
  for (const event of patches(renderIntents(intents))) {
    const result = patchSchema.safeParse(event.data);
    assert.ok(result.success,
      `${JSON.stringify(event.data)} — ${result.error && result.error.message}`);
  }
});

// ── Ordering ────────────────────────────────────────────────────────────────

test('at one instant a patch fires before a burst', () => {
  // A section boundary and a burst can land on the same downbeat, and the
  // boundary's `energyOverride: null` would otherwise cancel the burst.
  const events = renderIntents([
    accent(1000, BURST.COLOR_STROBE, 300),
    scene(1000, { pattern: 'chase' }),
  ]);
  assert.deepStrictEqual(events.map((e) => e.action), ['patch', 'energy']);
});

test('the timeline comes out in time order', () => {
  const events = renderIntents([
    scene(3000, { pattern: 'a' }), scene(1000, { pattern: 'b' }),
    accent(2000, BURST.COLOR_STROBE, 300),
  ]);
  assert.deepStrictEqual(events.map((e) => e.timeMs), [1000, 2000, 3000]);
});

// ── Debouncing ──────────────────────────────────────────────────────────────

test('a burst gets its full declared length before the next one starts', () => {
  const events = debounceBursts([
    { timeMs: 0, action: 'energy', data: { id: 'color-strobe', durationMs: 500 } },
    { timeMs: 200, action: 'energy', data: { id: 'color-strobe', durationMs: 300 } },
    { timeMs: 900, action: 'energy', data: { id: 'color-strobe', durationMs: 300 } },
  ]);
  assert.deepStrictEqual(events.map((e) => e.timeMs), [0, 900]);
});

test('a louder burst replaces a quieter one it collides with', () => {
  const events = debounceBursts([
    { timeMs: 0, action: 'energy', data: { id: 'color-strobe', durationMs: 500 } },
    { timeMs: 100, action: 'energy', data: { id: 'white-strobe', durationMs: 400 } },
  ]);
  assert.deepStrictEqual(events.map((e) => e.data.id), ['white-strobe']);
});

test('a quieter burst never replaces a louder one', () => {
  const events = debounceBursts([
    { timeMs: 0, action: 'energy', data: { id: 'white-strobe', durationMs: 500 } },
    { timeMs: 100, action: 'energy', data: { id: 'color-strobe', durationMs: 400 } },
  ]);
  assert.deepStrictEqual(events.map((e) => e.data.id), ['white-strobe']);
});

test('patches pass through the debouncer untouched', () => {
  const input = [
    { timeMs: 0, action: 'patch', data: { pattern: 'chase' } },
    { timeMs: 10, action: 'energy', data: { id: 'blinder', durationMs: 100 } },
    { timeMs: 20, action: 'patch', data: { pattern: 'hit' } },
  ];
  assert.strictEqual(patches(debounceBursts(input)).length, 2);
});

test('the safety gap is enforced, not just the burst length', () => {
  const events = debounceBursts([
    { timeMs: 0, action: 'energy', data: { id: 'color-strobe', durationMs: 300 } },
    { timeMs: 300 + DEBOUNCE_SAFETY_MS - 1, action: 'energy', data: { id: 'color-strobe', durationMs: 300 } },
    { timeMs: 300 + DEBOUNCE_SAFETY_MS, action: 'energy', data: { id: 'color-strobe', durationMs: 300 } },
  ]);
  assert.deepStrictEqual(events.map((e) => e.timeMs), [0, 300 + DEBOUNCE_SAFETY_MS]);
});

test('an empty plan renders to an empty timeline', () => {
  assert.deepStrictEqual(renderIntents([]), []);
});

test('an unknown intent kind is ignored rather than throwing', () => {
  const events = renderIntents([
    { timeMs: 0, kind: 'SOMETHING_NEW', priority: 1, source: 'x' },
    scene(100, { pattern: 'chase' }),
  ]);
  assert.strictEqual(events.length, 1);
});

test('a colour move with no usable colours emits nothing', () => {
  assert.deepStrictEqual(renderIntents([color(100, [])]), []);
  assert.deepStrictEqual(bursts(renderIntents([color(100, [null, null])])), []);
});
