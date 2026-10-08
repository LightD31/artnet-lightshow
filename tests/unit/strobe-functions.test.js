// The strobe voice's functions: its own palette flashes (Hue Dynamics'), or
// one of the ROOT PAR programs the look's strobe draws (shared/strobe-fx.ts),
// drawn by the same code, every lamp held to five flashes a second.

import test from 'node:test';
import assert from 'node:assert';

import { STROBE_FUNCTION_IDS, STROBE_PARAMS_SCHEMA, STROBE_PARAMS_EDIT_SCHEMA, STROBE_PROGRAM_KIND } from '../../src/shared/effects/strobe.ts';
import { DRAWN_STROBE_FUNCTIONS, strobeLevel } from '../../src/shared/strobe-fx.ts';
import { STROBE_FUNCTIONS } from '../../src/server/presets.ts';
import { validateSpec } from '../../src/shared/effects/registry.ts';
import { renderEffect } from '../../src/shared/effects/render.ts';
import { EffectStepper } from '../../src/shared/effects/stepper.ts';
import { parseHex } from '../../src/shared/effects/palette.ts';
import { HD_MASTER_DEFAULTS } from '../../src/shared/effects/types.ts';
import { seedFrom } from '../../src/shared/effects/hash.ts';
import { buildRoom } from '../../src/shared/room.ts';
import { HOLD_STROBE_MAX_HZ } from '../../src/shared/look-math.ts';
import { createRenderer } from '../../src/server/renderer.ts';
import * as universes from '../../src/server/universes.ts';
import { getProfile, profilesRevision, BUILTIN_PROFILE_ID } from '../../src/server/profiles.ts';
import { FRAME_MS } from '../../src/server/frame-clock.ts';

const RED = parseHex('#FF0000'), GREEN = parseHex('#00FF00'), WHITE = parseHex('#FFFFFF');

const roomOf = (hue) => buildRoom(hue.length, (i) => (hue.length > 1 ? i / (hue.length - 1) : 0.5), () => 0.5, () => 0.5, null, hue);
const frame = (over = {}) => ({ beatPos: 0, bpm: 120, nowMs: 0, dtMs: 0, anchorBeat: 0, lookPalette: [WHITE], paletteOverride: null,
  audio: null, audioMode: 'tempo', master: HD_MASTER_DEFAULTS, seed: seedFrom('caller'), acknowledged: true, hueStrobe: 'flash', ...over });
const strobe = (params = {}, palette = ['#FFFFFF']) => ({ id: 'strobe', spec: validateSpec({ kind: 'strobe', palette, params }),
  seed: seedFrom('strobe'), anchorBeat: 0, startedAtMs: 0, targets: null });

/** One running instance, sampled in time order at a steady tempo. */
function sampler(inst, room, bpm = 120) {
  const stepper = new EffectStepper();
  return (nowMs) => {
    const out = [];
    renderEffect(inst, frame({ nowMs, beatPos: (nowMs * bpm) / 60000, bpm }), room, stepper, out);
    return out;
  };
}
const levelOf = (slot) => (slot && slot.strength > 0 ? slot.level : 0);
/** Nothing drawn: the layer below shows through. */
const clear = (slot) => !slot || slot.strength === 0;

test('the strobe offers its palette flashes and every function the look draws, but the fixture\'s own', () => {
  assert.deepStrictEqual(STROBE_FUNCTION_IDS, ['palette', ...DRAWN_STROBE_FUNCTIONS]);
  const look = STROBE_FUNCTIONS.map((f) => f.id).filter((id) => id !== 'standard');
  assert.deepStrictEqual([...DRAWN_STROBE_FUNCTIONS].sort(), look.sort(), 'the same programs as the look\'s strobe functions');
  assert.throws(() => validateSpec({ kind: 'strobe', params: { function: 'standard' } }), 'the standard strobe is the fixture\'s, not the voice\'s');
});

test('a strobe saved before the functions is the palette strobe it was; an edit leaves the rest alone', () => {
  const old = { flashesPerSecond: 3, continueBetween: true, clock: 'beat', brightness: 1, onMs: 100, blackMs: 100 };
  const read = STROBE_PARAMS_SCHEMA.parse(old);
  assert.deepStrictEqual([read.function, read.speed], ['palette', 128]);
  assert.deepStrictEqual(validateSpec({ kind: 'strobe' }).params.function, 'palette');
  assert.deepStrictEqual(STROBE_PARAMS_EDIT_SCHEMA.parse({ speed: 200 }), { speed: 200 }, 'nothing filled in');
  assert.throws(() => STROBE_PARAMS_EDIT_SCHEMA.parse({ speed: 0 }));
});

test('a program draws each lamp at the look\'s level for it, on the beat', () => {
  const room = roomOf([false, false, false]);
  // All but the burst: the look's packs its flashes eleven a second, the voice's five.
  for (const fn of DRAWN_STROBE_FUNCTIONS.filter((id) => id !== 'break')) {
    // Speed 1: the slowest rung, well over five a second, so the pace never steps in.
    const at = sampler(strobe({ function: fn, speed: 1 }), room);
    for (const ms of [0, 130, 410, 777, 1500, 2950]) {
      const out = at(ms);
      for (let i = 0; i < 3; i++) {
        assert.ok(Math.abs(levelOf(out[i]) - strobeLevel(fn, 1, ms / 500, 120, i)) < 1e-9, `${fn} lamp ${i} at ${ms} ms`);
      }
    }
  }
});

test('a program lights the lamps in the palette\'s colours in turn and tags its slots as paced', () => {
  const at = sampler(strobe({ function: 'ramp-up-down', speed: 1 }, ['#FF0000', '#00FF00']), roomOf([false, false, false]));
  const out = at(0);
  assert.deepStrictEqual(out.map((s) => s.colour), [RED, GREEN, RED]);
  assert.ok(out.every((s) => s.kind === STROBE_PROGRAM_KIND && s.level === 1));
});

test('a program leaves a Hue lamp to what plays below, as the look\'s strobe functions do', () => {
  const at = sampler(strobe({ function: 'random', speed: 255 }), roomOf([false, true]));
  for (let ms = 0; ms < 2000; ms += 10) assert.ok(clear(at(ms)[1]), `${ms} ms`);
});

test('between swells the look shows through, or black holds', () => {
  const room = roomOf([false]);
  // Ramp Up at the slowest is dark only at the very top of its cycle: Random is dark most of the time.
  const shows = sampler(strobe({ function: 'random', speed: 1, continueBetween: true }), room);
  const black = sampler(strobe({ function: 'random', speed: 1, continueBetween: false }), room);
  let dark = 0;
  for (let ms = 0; ms < 4000; ms += 25) {
    const a = shows(ms)[0], b = black(ms)[0];
    if (levelOf(b) > 0) continue;
    dark++;
    assert.ok(clear(a), 'nothing drawn: the layer below shows');
    assert.deepStrictEqual([b.level, b.strength], [0, 1], 'black held');
  }
  assert.ok(dark > 10);
});

test('no program flashes a lamp more than five times a second, at any speed or tempo', () => {
  const room = roomOf([false, false, false, false]);
  const window = 1000;
  for (const fn of DRAWN_STROBE_FUNCTIONS) {
    for (const bpm of [90, 128, 174, 200]) {
      const at = sampler(strobe({ function: fn, speed: 255 }), room, bpm);
      const rises = room.n ? Array.from({ length: room.n }, () => []) : [];
      const last = new Array(room.n).fill(0);
      const rising = new Array(room.n).fill(false);
      for (let ms = 0; ms <= 6000; ms += 2) {
        const out = at(ms);
        for (let i = 0; i < room.n; i++) {
          const level = levelOf(out[i]);
          // A flash is a light coming up from dark, or a swell turning from falling to rising.
          const up = level > last[i] + 1e-9;
          if (up && (!rising[i] || last[i] === 0)) rises[i].push(ms);
          if (level !== last[i]) rising[i] = up;
          last[i] = level;
        }
      }
      for (let i = 0; i < room.n; i++) {
        for (let k = HOLD_STROBE_MAX_HZ; k < rises[i].length; k++) {
          assert.ok(rises[i][k] - rises[i][k - HOLD_STROBE_MAX_HZ] >= window - 2,
            `${fn} at ${bpm} BPM, lamp ${i}: ${HOLD_STROBE_MAX_HZ + 1} flashes within ${rises[i][k] - rises[i][k - HOLD_STROBE_MAX_HZ]} ms`);
        }
      }
    }
  }
});

test('through the renderer a program\'s ramp climbs frame by frame, where the palette strobe still keeps its guard', () => {
  const fixtures = [0, 1].map((id) => ({ id, address: 1 + 12 * id, universe: 0, profileId: BUILTIN_PROFILE_ID, maxBrightness: 255,
    override: null, position: null, group: null, geometry: null }));
  const voice = (params) => ({ id: 'strobe', spec: validateSpec({ kind: 'strobe', palette: ['#FFFFFF'], params }), targets: null,
    tier: 'strobe', launchSeq: 1, startedAtMs: 0, untilMs: null, anchorBeat: 0, seed: seedFrom('strobe') });
  const trace = (params) => {
    const store = universes.createUniverseStore(universes.allocateShared());
    const renderer = createRenderer({ profileOf: getProfile, profilesRevision, now: 0 });
    const ch = getProfile(fixtures[0]).channelMap;
    const dims = [];
    for (let k = 0; k * FRAME_MS <= 2000; k++) {
      const t = k * FRAME_MS;
      renderer.frame({
        running: true, pattern: 'solid', colorA: 0, colorB: 5, colorC: 0, colorD: 5, beatDivision: 1, split: null, pixelMap: 'stage',
        strobeSpeed: 0, strobeFunction: 'standard', masterDimmer: 255, masterBlackout: false, energy: null, showDynamics: null,
        patternAnchor: null, fade: null, syncTest: null, universes: [0], fixtures,
        safety: { hdFlashIntervalMs: 350, acknowledged: true }, voices: [voice(params)],
      }, { beatPos: t / 500, bpm: 120, epoch: 0 }, t, store, 0);
      dims.push(store.getBuffer(0)[fixtures[0].address - 1 + ch.dimmer]);
    }
    return dims;
  };
  // Ramp Up at the slowest: four beats, two seconds at 120 BPM, from black to full.
  const ramp = trace({ function: 'ramp-up', speed: 1, continueBetween: false });
  const climbing = ramp.slice(1, 80);
  assert.ok(climbing.every((d, k) => k === 0 || d >= climbing[k - 1]), 'never held back');
  assert.ok(ramp[80] > ramp[20] + 100, `${ramp[20]} → ${ramp[80]}: it climbs`);
  // The palette strobe at two a second on the beat: lit, then black, as before.
  const palette = trace({ function: 'palette', flashesPerSecond: 2, continueBetween: false });
  assert.strictEqual(palette[0], 255);
  assert.strictEqual(palette[Math.round(150 / FRAME_MS)], 0);
});
