// The photosensitivity limit (src/server/flash-limit.ts): with it on, the rig
// never flashes more than three times a second over its whole area, whatever
// the look or the strobe asks for; with it off, nothing changes.

import test from 'node:test';
import assert from 'node:assert';

import { createFlashLimiter, lightLuminance, SWING, DARKER, FLASHES_PER_SECOND } from '../../src/server/flash-limit.ts';
import { createRenderer } from '../../src/server/renderer.ts';
import * as universes from '../../src/server/universes.ts';
import { getProfile, profilesRevision, registerProfile, unregisterProfile, BUILTIN_PROFILE_ID } from '../../src/server/profiles.ts';
import { barProfile } from '../../src/server/bar-profile.ts';
import { STROBE_FUNCTIONS } from '../../src/server/presets.ts';
import { FRAME_MS } from '../../src/server/frame-clock.ts';

/**
 * The most flashes any one second of `levels` holds — counted independently
 * of the limiter, from the WCAG definition: a pair of opposing changes of a
 * tenth of full or more, the darker side under 0.8.
 */
function worstSecond(levels, frameMs = FRAME_MS) {
  const changes = [];
  let extreme = levels[0];
  let rising = true;
  levels.forEach((l, i) => {
    if (rising) {
      if (l >= extreme) extreme = l;
      else if (extreme - l >= SWING && l < DARKER) { changes.push(i * frameMs); rising = false; extreme = l; }
    } else if (l <= extreme) extreme = l;
    else if (l - extreme >= SWING && extreme < DARKER) { changes.push(i * frameMs); rising = true; extreme = l; }
  });
  let worst = 0;
  for (const start of changes) worst = Math.max(worst, changes.filter((t) => t >= start && t < start + 1000).length);
  return worst / 2;
}

test('a ten-hertz flicker is held to three flashes a second, and still moves', () => {
  const limiter = createFlashLimiter();
  const out = [];
  for (let t = 0; t < 4000; t += FRAME_MS) {
    const asked = Math.floor(t / 50) % 2 ? 1 : 0;
    const level = limiter.target(asked, t);
    limiter.commit(level, t);
    out.push(level);
  }
  assert.ok(worstSecond(out) <= FLASHES_PER_SECOND, `${worstSecond(out)} flashes in a second`);
  assert.ok(worstSecond(out.map((_, i) => (Math.floor((i * FRAME_MS) / 50) % 2 ? 1 : 0))) > FLASHES_PER_SECOND, 'the input did flash faster');
  assert.ok(new Set(out.map((l) => l.toFixed(2))).size > 2, 'held to a flicker, not frozen');
});

test('two flashes a second go through untouched', () => {
  const limiter = createFlashLimiter();
  for (let t = 0; t < 4000; t += FRAME_MS) {
    const asked = Math.floor(t / 250) % 2 ? 1 : 0;
    const level = limiter.target(asked, t);
    limiter.commit(level, t);
    assert.strictEqual(level, asked, `at ${t} ms`);
  }
});

test('brightness is luminance: white counts in full, blue barely', () => {
  assert.ok(Math.abs(lightLuminance({ r: 255, g: 255, b: 255, w: 0 }, 255) - 1) < 1e-9);
  assert.ok(lightLuminance({ r: 0, g: 0, b: 255, w: 0 }, 255) < 0.1);
  assert.strictEqual(lightLuminance({ r: 255, g: 255, b: 255, w: 0 }, 0), 0);
});

// ── Through the renderer ────────────────────────────────────────────────────

const PAR = BUILTIN_PROFILE_ID;
const BAR = barProfile({ id: 'flash-limit-bar', name: 'No-strobe Bar', cells: 4, firstChannel: 2, order: 'RGB', dimmer: 1 });
const fixture = (id, address, profileId) => ({
  id, address, universe: 0, profileId, maxBrightness: 255, override: null, position: null, group: null, geometry: null,
});

/** Render `seconds` of frames and return the rig's brightness on each, read back off the DMX. */
function render(patch, { seconds = 3, bpm = 180 } = {}) {
  registerProfile(BAR);
  try {
    const fixtures = [fixture(0, 1, PAR), fixture(1, 20, PAR), fixture(2, 40, BAR.id)];
    const store = universes.createUniverseStore(universes.allocateShared());
    const renderer = createRenderer({ profileOf: getProfile, profilesRevision, now: 0 });
    const input = {
      running: true, pattern: 'hit', colorA: 1, colorB: 1, colorC: 1, colorD: 1, split: null, pixelMap: 'stage',
      beatDivision: 4, strobeSpeed: 0, strobeFunction: 'standard', masterDimmer: 255, masterBlackout: false,
      energy: null, showDynamics: null, patternAnchor: null, fade: null, syncTest: null, universes: [0], fixtures,
      ...patch,
    };
    const levels = [];
    const strobes = [];
    for (let t = 0; t < seconds * 1000; t += FRAME_MS) {
      renderer.frame(input, { beatPos: (t / 60000) * bpm, bpm, epoch: 0 }, t, store);
      const dmx = store.getBuffer(0);
      const lum = fixtures.map((f) => {
        const p = getProfile(f);
        const cells = p.cells ? p.cells.map((c) => c.channelMap) : [p.channelMap];
        const master = p.channelMap.dimmer !== undefined ? dmx[f.address - 1 + p.channelMap.dimmer] : 255;
        const each = cells.map((ch) => lightLuminance({ r: dmx[f.address - 1 + ch.red], g: dmx[f.address - 1 + ch.green], b: dmx[f.address - 1 + ch.blue], w: ch.white !== undefined ? dmx[f.address - 1 + ch.white] : 0 }, master));
        return each.reduce((a, b) => a + b, 0) / each.length;
      });
      levels.push(lum.reduce((a, b) => a + b, 0) / lum.length);
      const ch = getProfile(fixtures[0]).channelMap;
      strobes.push(ch.strobe !== undefined ? dmx[ch.strobe] : 0);
    }
    return { levels, strobes };
  } finally {
    unregisterProfile(BAR.id);
  }
}

test('a hit at sixteenths flashes the whole rig, and the limit holds it to three a second', () => {
  const free = render({});
  assert.ok(worstSecond(free.levels) > FLASHES_PER_SECOND, `off: ${worstSecond(free.levels)} flashes a second`);
  const held = render({ flashLimit: true });
  assert.ok(worstSecond(held.levels) <= FLASHES_PER_SECOND, `on: ${worstSecond(held.levels)} flashes a second`);
  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  assert.ok(mean(held.levels) > 0.25 * mean(free.levels), 'the rig stays lit: limited, not blacked out');
});

test('a strobe at full speed is capped at three flashes a second', () => {
  const standard = STROBE_FUNCTIONS.find((f) => f.id === 'standard');
  const valueAt = (hz) => standard.lo + Math.round((((hz - 1) / 19) * 255 / 255) * (standard.hi - standard.lo));
  const free = render({ pattern: 'strobe', strobeSpeed: 255 }, { seconds: 1 });
  const held = render({ pattern: 'strobe', strobeSpeed: 255, flashLimit: true }, { seconds: 1 });
  assert.ok(Math.max(...free.strobes) > valueAt(10), 'off: the fixture strobes as fast as asked');
  assert.ok(Math.max(...held.strobes) <= valueAt(3) + 1, `on: strobe channel at ${Math.max(...held.strobes)}`);
});

test('with the limit off, a frame is exactly what it was', () => {
  const a = render({}, { seconds: 1 });
  const b = render({ flashLimit: false }, { seconds: 1 });
  assert.deepStrictEqual(a, b);
});
