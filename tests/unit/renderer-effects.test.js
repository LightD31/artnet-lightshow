// The renderer plays effects: a base effect in place of the look's pattern,
// voices over it by tier and launch, the energy burst as a voice of its own,
// and Hue Dynamics' flash limit on its own kinds. Driven as the engine drives
// it, one frame at a time into a universe store.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { z } from 'zod';

import { createRenderer, withInputDefaults, baseIntentOf } from '../../src/server/renderer.ts';
import * as universes from '../../src/server/universes.ts';
import { getProfile, profilesRevision, registerProfile, unregisterProfile, BUILTIN_PROFILE_ID, HUE_COLOR_PROFILE_ID } from '../../src/server/profiles.ts';
import { barProfile } from '../../src/server/bar-profile.ts';
import { COLOR_PRESETS } from '../../src/server/presets.ts';
import { FRAME_MS } from '../../src/server/frame-clock.ts';
import { presetById } from '../../src/shared/effects/catalogue.ts';
import { registerKind, validateSpec } from '../../src/shared/effects/registry.ts';
import { seedFrom } from '../../src/shared/effects/hash.ts';
import { voiceOrder } from '../../src/shared/effects/layer.ts';
import { HD_MASTER_DEFAULTS } from '../../src/shared/effects/types.ts';
import { HOLD_STROBE, resolveEnergyOverride } from '../../src/shared/look-math.ts';
import { resolveDetectors } from '../../src/server/audio-features.ts';

const fixture = (id, address, profileId = BUILTIN_PROFILE_ID, extra = {}) => ({
  id, address, universe: 0, profileId, maxBrightness: 255, override: null,
  position: null, group: null, geometry: null, hue: false, ...extra,
});

// As hold-strobe.test.js: a par at 1, a Hue lamp at 20.
const PAR = fixture(0, 1);
const LAMP = fixture(1, 20, HUE_COLOR_PROFILE_ID, { hue: true, output: { protocol: 'hue', channel: 1 } });
const PARS = [0, 1, 2, 3].map((i) => fixture(i, 1 + 12 * i));

const RED = COLOR_PRESETS[0];
const BLUE = COLOR_PRESETS[5];
// Red over blue, as the hold strobe's tests: colour A is told from colour B.
const LOOK = { pattern: 'solid', colorA: 0, colorB: 5, colorC: 0, colorD: 5, beatDivision: 1 };

const input = (patch = {}) => ({
  running: true, ...LOOK, split: null, pixelMap: 'stage', strobeSpeed: 0, strobeFunction: 'standard',
  masterDimmer: 255, masterBlackout: false, energy: null, showDynamics: null, patternAnchor: null,
  fade: null, syncTest: null, universes: [0], fixtures: [PAR, LAMP], ...patch,
});

const spec = (raw) => validateSpec(raw);
const preset = (id) => { const row = presetById(id); assert.ok(row && !row.legacy, id); return row.spec; };
const WHITE_TWINKLE = spec({ kind: 'hd.twinkle', palette: ['#FFFFFF'], brightness: 1,
  params: { probability: 1, attack: 0, hold: 0.0625, release: 0, loopLength: 0.125 } });

/** A voice as the engine would hand it over. */
const voice = (id, effect, extra = {}) => ({
  id, spec: effect, targets: null, tier: 'voice', launchSeq: 1, startedAtMs: 0, untilMs: null, anchorBeat: 0, seed: seedFrom(id), ...extra,
});

/** One renderer and its store, rendered frame by frame at 120 BPM unless the reading says otherwise. */
function rig(fixtures = [PAR, LAMP]) {
  const store = universes.createUniverseStore(universes.allocateShared());
  const renderer = createRenderer({ profileOf: getProfile, profilesRevision, now: 0 });
  const read = (fix) => {
    const ch = getProfile(fix).channelMap;
    const base = fix.address - 1;
    const dmx = store.getBuffer(fix.universe);
    const at = (name) => (ch[name] === undefined ? undefined : dmx[base + ch[name]]);
    return { dim: at('dimmer'), r: at('red'), g: at('green'), b: at('blue'), w: at('white'), a: at('amber'), uv: at('uv'), strobe: at('strobe') };
  };
  return {
    renderer,
    store,
    /** Render at `ms` and read every fixture: { [id]: { dim, r, g, b, … } }. */
    at(ms, patch = {}, { beatPos = ms / 500, bpm = 120, epoch = 0, anchorBeat, grid } = {}) {
      const given = input({ fixtures, ...patch });
      const reading = { beatPos, bpm, epoch, ...(anchorBeat === undefined ? {} : { anchorBeat }) };
      renderer.frame(given, reading, ms, store, grid);
      return Object.fromEntries(given.fixtures.map((f) => [f.id, read(f)]));
    },
    read,
  };
}

const lit = (out) => out.dim > 0 && (out.r > 0 || out.g > 0 || out.b > 0);

// ── A base effect, voices over it, the burst, the guard, Hue lamps ──────────

test('a base effect preset renders through the layout: ldj.StrobeCycle lights one par per beat', () => {
  const r = rig(PARS);
  const strobeCycle = preset('ldj.StrobeCycle');
  // Its own palette is two random colours: the step's par in one, the rest in the other.
  const picks = [];
  for (let beat = 0; beat < 8; beat++) {
    const out = r.at(beat * 500 + 10, { pattern: 'ldj.StrobeCycle', effect: strobeCycle });
    const colours = PARS.map((f) => `${out[f.id].r},${out[f.id].g},${out[f.id].b}`);
    const odd = colours.filter((c) => colours.filter((d) => d === c).length === 1);
    assert.strictEqual(odd.length, 1, `beat ${beat}: one par stands out (${colours.join(' | ')})`);
    picks.push(colours.indexOf(odd[0]));
    for (const f of PARS) assert.strictEqual(out[f.id].dim, 255, 'all at full');
  }
  assert.strictEqual(new Set(picks.slice(0, 4)).size, 4, 'every par in turn');
  assert.deepStrictEqual(picks.slice(4), picks.slice(0, 4), 'and round again');
  // One colour (an override of one): the rest go dark, one par lit per beat.
  const one = rig(PARS);
  for (let beat = 0; beat < 4; beat++) {
    const out = one.at(beat * 500 + 10, { pattern: 'ldj.StrobeCycle', effect: strobeCycle, paletteOverride: [RED] });
    assert.deepStrictEqual(PARS.map((f) => lit(out[f.id]) ? 1 : 0).reduce((a, b) => a + b), 1, `beat ${beat}`);
  }
});

// Taken on main (2c0c7d4) and on this branch's base (b0215e5), identical on
// both: four unplaced pars, chase on half beats, colours 0/5/0/5, 120 BPM,
// every 125 ms for two beats. The dimmer of each par.
const CHASE_ON_MAIN = [
  [255, 45, 45, 45], [255, 45, 45, 45], [45, 255, 45, 45], [45, 255, 45, 45], [45, 45, 255, 45], [45, 45, 255, 45], [45, 45, 45, 255], [45, 45, 45, 255],
  [255, 45, 45, 45], [255, 45, 45, 45], [45, 255, 45, 45], [45, 255, 45, 45], [45, 45, 255, 45], [45, 45, 255, 45], [45, 45, 45, 255], [45, 45, 45, 255],
];

test('a legacy pattern still renders unchanged', () => {
  const r = rig(PARS);
  const seen = [];
  for (let k = 0; k < 16; k++) {
    const out = r.at(k * 125, { pattern: 'chase', beatDivision: 2 }, { beatPos: k * 0.25 });
    seen.push(PARS.map((f) => out[f.id].dim));
  }
  assert.deepStrictEqual(seen, CHASE_ON_MAIN);
});

test('a voice over the base replaces only its targets', () => {
  const r = rig();
  const out = r.at(100, { voices: [voice('pad:1', preset('energy.blinder'), { targets: [PAR.id] })] });
  assert.deepStrictEqual([out[PAR.id].dim, out[PAR.id].r, out[PAR.id].g, out[PAR.id].b, out[PAR.id].w, out[PAR.id].a], [255, 255, 255, 255, 255, 255],
    'the par at full white, amber included');
  assert.deepStrictEqual([out[LAMP.id].dim, out[LAMP.id].r, out[LAMP.id].g, out[LAMP.id].b], [255, 255, 0, 0], 'the lamp shows the base (solid red)');
});

test('the strobe tier outranks a later pad voice; between two pads the later launch wins', () => {
  const kill = preset('energy.kill');
  const blinder = preset('energy.blinder');
  const uv = preset('energy.uvWash');
  const at = (voices) => rig().at(10, { voices })[PAR.id];
  // A strobe-tier kill against a later blinder pad: the strobe tier wins.
  assert.strictEqual(at([voice('pad:b', blinder, { launchSeq: 9 }), voice('strobe', kill, { tier: 'strobe', launchSeq: 1 })]).dim, 0);
  // Two pads: the later launch wins, whichever order they are listed in.
  assert.deepStrictEqual(at([voice('pad:a', blinder, { launchSeq: 2 }), voice('pad:b', uv, { launchSeq: 3 })]).uv, 255);
  assert.deepStrictEqual(at([voice('pad:b', uv, { launchSeq: 3 }), voice('pad:a', blinder, { launchSeq: 2 })]).r, 0);
  assert.deepStrictEqual(at([voice('pad:a', blinder, { launchSeq: 4 }), voice('pad:b', uv, { launchSeq: 3 })]).r, 255);
  // Same launch: chosen fixtures over the whole rig, then the later start, then the order given.
  assert.strictEqual(at([voice('pad:a', blinder), voice('pad:b', uv, { targets: [PAR.id] })]).uv, 255);
  assert.strictEqual(at([voice('pad:a', blinder, { startedAtMs: 5 }), voice('pad:b', uv)]).r, 255);
  assert.strictEqual(at([voice('pad:a', blinder), voice('pad:b', uv)]).r, 255, 'a full tie keeps the first listed');
  // A transparent slot is no ownership: a hold strobe between flashes shows the pad below it.
  const between = rig().at(450, { voices: [voice('strobe', preset(HOLD_STROBE), { tier: 'strobe' }), voice('pad:a', blinder)] }, { beatPos: 0.9 })[PAR.id];
  assert.strictEqual(between.w, 255, 'between flashes the blinder shows');
});

test('a voice beats a pinned override and a fixture blackout alike, as the energy burst does today', () => {
  const pinned = { ...PAR, override: { enabled: true, r: 10, g: 20, b: 30, w: 0, a: 0, uv: 0, dim: 90, strobe: 0, blackout: false } };
  const dark = { ...PAR, override: { enabled: false, r: 0, g: 0, b: 0, w: 0, a: 0, uv: 0, dim: 0, strobe: 0, blackout: true } };
  for (const fix of [pinned, dark]) {
    const viaVoice = rig([fix]).at(10, { voices: [voice('pad', preset('energy.blinder'))] })[fix.id];
    const viaEnergy = rig([fix]).at(10, { energy: 'blinder' })[fix.id];
    assert.deepStrictEqual(viaVoice, viaEnergy);
    assert.strictEqual(viaVoice.dim, 255);
    // And without a voice the override holds.
    assert.strictEqual(rig([fix]).at(10, { voices: [] })[fix.id].dim, fix === pinned ? 90 : 0);
  }
  // A voice's own black (kill) owns the lamp over a pinned colour too.
  assert.strictEqual(rig([pinned]).at(10, { voices: [voice('pad', preset('energy.kill'))] })[PAR.id].dim, 0);
});

test('input.energy without voices renders through the compatibility voice: energy "blinder" is full white on every fixture; "palette-strobe" flashes', () => {
  const blinder = rig().at(10, { energy: 'blinder' });
  for (const f of [PAR, LAMP]) assert.deepStrictEqual([blinder[f.id].dim, blinder[f.id].r, blinder[f.id].g, blinder[f.id].b], [255, 255, 255, 255]);
  // The hold strobe: colour A on the beat, black after, the look between, colour B on the half beat.
  const flashes = [0, 100, 200, 250].map((ms) => rig().at(ms, { energy: HOLD_STROBE })[PAR.id]);
  assert.deepStrictEqual(flashes.map((o) => [o.dim, o.r, o.g, o.b]), [[255, 255, 0, 0], [0, 0, 0, 0], [255, 255, 0, 0], [255, 0, 85, 255]]);
  // An empty voices field means the caller owns the voices: nothing is synthesized.
  assert.deepStrictEqual(rig().at(10, { energy: 'blinder', voices: [] })[PAR.id].g, 0, 'solid red, no blinder');
  assert.deepStrictEqual(rig().at(100, { energy: HOLD_STROBE, voices: [] })[PAR.id].dim, 255, 'the look, no strobe');
});

test('the HD guard zeroes a second bright rise inside 350 ms on an hd.* kind only', () => {
  // Sixteen events a second, each lit 31.25 ms: every 44 Hz frame sees each one.
  const risesOf = (effect, hdFlashIntervalMs, { acknowledged = false, seconds = 1, master = 255, trim = 255 } = {}) => {
    const fix = { ...PAR, maxBrightness: trim };
    const r = rig([fix]);
    const times = [];
    let before = 0;
    for (let k = 0; k <= 44 * seconds; k++) {
      const ms = k * FRAME_MS;
      const out = r.at(ms, { pattern: 'look', effect, masterDimmer: master, safety: { hdFlashIntervalMs, acknowledged } }, { grid: 0 })[fix.id];
      const level = out.dim / 255;
      if (level >= 0.55 * (master / 255) * (trim / 255) - 1e-9 && level > 0 && before === 0) times.push(ms);
      before = level > 0.3 * (master / 255) * (trim / 255) ? 1 : 0;
    }
    return times;
  };
  const guarded = risesOf(WHITE_TWINKLE, 350);
  assert.ok(guarded.length <= 3, `${guarded.length} rises in a second`);
  for (let i = 1; i < guarded.length; i++) assert.ok(guarded[i] - guarded[i - 1] >= 350 - 1e-9, `rises ${guarded[i - 1]} → ${guarded[i]}`);
  assert.ok(risesOf(WHITE_TWINKLE, 0).length >= 12, 'interval 0: every event');
  // Light DJ's TrueStrobe runs at its own rate under the same setting.
  const trueStrobe = risesOf(spec({ kind: 'ldj.TrueStrobe', palette: ['#FFFFFF'] }), 350, { acknowledged: true });
  assert.ok(trueStrobe.length >= 10, `TrueStrobe ${trueStrobe.length} a second`);
});

test('a Hue lamp is flashed black between strobe flashes with hueStrobe flash, and pulsed with pulse', () => {
  const strobe = voice('strobe', preset(HOLD_STROBE), { tier: 'strobe' });
  const lampAt150 = (hueStrobe) => {
    const r = rig();
    for (const ms of [0, 50, 100, 150]) {
      const out = r.at(ms, { voices: [strobe], hueStrobe, safety: { hdFlashIntervalMs: 350, acknowledged: true } }, { grid: 0 });
      if (ms === 150) return out[LAMP.id];
    }
    return null;
  };
  assert.strictEqual(lampAt150('flash').dim, 0, 'black after the flash');
  const pulsed = lampAt150('pulse');
  assert.ok(pulsed.dim > 40 && pulsed.dim < 255, `falling: ${pulsed.dim}`);
});

test('hand-built inputs without the new fields render as before', () => {
  // The hold strobe's own harness input, as it is.
  const out = rig().at(0, { energy: HOLD_STROBE });
  assert.deepStrictEqual([out[PAR.id].dim, out[PAR.id].r], [255, 255]);
  assert.deepStrictEqual([out[LAMP.id].dim, out[LAMP.id].r], [255, 255]);
  const filled = withInputDefaults(input());
  assert.deepStrictEqual([filled.effect, filled.voices, filled.paletteOverride, filled.safety, filled.hueStrobe],
    [null, [], null, { hdFlashIntervalMs: 350, acknowledged: false }, 'pulse']);
  assert.ok(!('voices' in input()) && !('safety' in input()), 'the caller\'s input is left as it was');
});

// ── A kind that shows what it is handed ─────────────────────────────────────

// The probe kind keeps every frame, room and command it was handed in its
// state, and leaves its state where a test finds it: a test tells a kept
// state from a new one by identity.
const WHITE = { r: 255, g: 255, b: 255, w: 0, a: 0, uv: 0 };

// A kind that is white on every slot, and keeps nothing a test reads.
registerKind({
  kind: 'test.plain', app: 'own', schema: z.object({}).strict(), defaults: { params: {} },
  init: () => ({ frames: 0 }),
  render(params, state, room, frame, out) { state.frames++; for (let i = 0; i < room.n; i++) out[i] = { colour: WHITE, level: 1, strength: 1 }; },
});

/** Render a probe base at `ms` and return the state it rendered into. */
function captureState(r, effect, ms, patch = {}, reading = {}) {
  r.at(ms, { pattern: 'look', effect, ...patch }, reading);
  return lastState;
}
let lastState = null;
registerKind({
  kind: 'test.last', app: 'own', schema: z.object({ tag: z.string() }).strict(), defaults: { params: { tag: '' } },
  init: (params, room, frame) => ({ born: frame.nowMs, startedAtMs: frame.startedAtMs, frames: [], commands: [] }),
  command: (state, cmd, arg) => { state.commands.push({ cmd, arg, after: state.frames.length }); },
  render(params, state, room, frame, out) {
    lastState = state;
    state.frames.push({ frame: { ...frame, paletteAccess: undefined }, room });
    for (let i = 0; i < room.n; i++) out[i] = { colour: frame.palette[0] ?? WHITE, level: 1, strength: 1 };
  },
});
const probe = (tag = '', extra = {}) => spec({ kind: 'test.last', params: { tag }, ...extra });

// A kind that notes the room each render is handed, by its tag.
const roomsSeen = [];
registerKind({
  kind: 'test.rooms', app: 'own', schema: z.object({ tag: z.string() }).strict(), defaults: { params: { tag: '' } },
  init: () => null,
  render(params, state, room, frame, out) { roomsSeen.push([params.tag, room]); for (let i = 0; i < room.n; i++) out[i] = { colour: WHITE, level: 1, strength: 1 }; },
});

// ── Identity, resets and clocks ─────────────────────────────────────────────

test('the base keeps its state frame to frame, and starts again on a new launch, revision, content or layout; a palette edit keeps it', () => {
  const r = rig(PARS);
  const at = (ms, patch = {}, reading = {}) => captureState(r, probe('a'), ms, patch, reading);
  const first = at(0);
  assert.strictEqual(at(25), first, 'the next frame keeps it');
  assert.strictEqual(at(50, { effect: probe('a', { palette: ['#00FF00'] }) }), first, 'a palette edit keeps it');
  assert.strictEqual(at(75, { effect: probe('a', { brightness: 0.5 }) }), first, 'so does a brightness edit');
  const revised = at(100, { effectRevision: 2 });
  assert.notStrictEqual(revised, first, 'a new revision starts it again');
  assert.strictEqual(at(125, { effectRevision: 2 }), revised);
  const edited = captureState(r, probe('b'), 150, { effectRevision: 2 });
  assert.notStrictEqual(edited, revised, 'new content starts it again, revision or not');
  const relaunched = captureState(r, probe('b'), 175, { effectRevision: 2, patternAnchor: { step: 3, epoch: 0, seq: 9 } });
  assert.notStrictEqual(relaunched, edited, 'a new launch of the look starts it again');
  assert.strictEqual(relaunched.frames[0].frame.instanceId, 'base:look:3', 'its public id names the launch');
  assert.deepStrictEqual(relaunched.frames[0].frame.seed, seedFrom('base:look:3'));
  assert.strictEqual(relaunched.frames[0].frame.anchorBeat, 3);
  const split = captureState(r, probe('b'), 200, { effectRevision: 2, patternAnchor: { step: 3, epoch: 0, seq: 9 }, split: 0 });
  assert.notStrictEqual(split, relaunched, 'a new split is a new layout');
  // Its wall origin is its first frame, never re-stamped.
  assert.strictEqual(split.born, split.frames[0].frame.startedAtMs);
  captureState(r, probe('b'), 400, { effectRevision: 2, patternAnchor: { step: 3, epoch: 0, seq: 9 }, split: 0 });
  assert.strictEqual(split.frames[1].frame.startedAtMs, split.born);
});

test('address, universe and trim edits do not restart an effect; another fixture or a changed id does', () => {
  const r = rig(PARS);
  const first = captureState(r, probe(), 0);
  const moved = PARS.map((f, i) => ({ ...f, address: 101 + 12 * i, maxBrightness: 100 + i }));
  assert.strictEqual(captureState(r, probe(), 25, { fixtures: moved }), first);
  const renamed = moved.map((f, i) => (i === 2 ? { ...f, id: 77 } : f));
  assert.notStrictEqual(captureState(r, probe(), 50, { fixtures: renamed }), first, 'a different fixture id is a different patch');
});

test('a changed patch starts a voice again once, on the frame it changes, and the next frame is handed the real time since', () => {
  const r = rig(PARS);
  const v = voice('pad', probe('v'));
  r.at(0, { voices: [v] });
  const first = lastState;
  const renamed = PARS.map((f, i) => (i === 2 ? { ...f, id: 77 } : f));
  r.at(25, { voices: [v], fixtures: renamed });
  const fresh = lastState;
  assert.notStrictEqual(fresh, first, 'another fixture: the voice starts again');
  r.at(50, { voices: [v], fixtures: renamed });
  assert.strictEqual(lastState, fresh, 'and plays on from there, not started a second time');
  assert.strictEqual(fresh.frames.at(-1).frame.dtMs, 25);
});

test('a jump in the music starts the base again; a voice keeps its launch, deadline and state and moves its beat anchor', () => {
  const r = rig(PARS);
  const v = voice('pad:1', probe('v'), { startedAtMs: 0, untilMs: 5000, anchorBeat: 0.5 });
  const base = probe('base');
  r.at(0, { pattern: 'look', effect: base, voices: [v] }, { beatPos: 0.5, epoch: 1 });
  const voiceState = lastState;
  r.at(25, { pattern: 'look', effect: base, voices: [v] }, { beatPos: 0.55, epoch: 1 });
  assert.strictEqual(lastState, voiceState, 'the voice renders last and keeps its state');
  const frames = voiceState.frames;
  assert.strictEqual(frames[frames.length - 1].frame.anchorBeat, 0.5, 'its own anchor in the first epoch');
  // A seek: epoch 2, the music is now at beat 40.3.
  r.at(50, { pattern: 'look', effect: base, voices: [v] }, { beatPos: 40.3, epoch: 2 });
  assert.strictEqual(lastState, voiceState, 'the same voice state, not a relaunch');
  const after = voiceState.frames[voiceState.frames.length - 1].frame;
  assert.strictEqual(after.anchorBeat, 40, 'anchored at the start of the beat it is now in');
  assert.strictEqual(after.startedAtMs, 0, 'its launch time stays');
  assert.deepStrictEqual(after.seed, seedFrom('pad:1'), 'and its seed');
  assert.strictEqual(v.anchorBeat, 0.5, 'the voice as handed over is untouched');
  // The deadline holds in wall time: gone at 5000 ms whatever the music did.
  const late = rig(PARS);
  late.at(4990, { voices: [voice('pad:1', preset('energy.blinder'), { untilMs: 5000 })] }, { epoch: 1 });
  assert.strictEqual(late.at(4999, { voices: [voice('pad:1', preset('energy.blinder'), { untilMs: 5000 })] }, { epoch: 7 })[0].w, 255);
  assert.strictEqual(late.at(5000, { voices: [voice('pad:1', preset('energy.blinder'), { untilMs: 5000 })] }, { epoch: 7 })[0].w, 0, 'half-open: off at its deadline');
});

test('a macro voice takes a jump in the music down to its step: the step plays on from the new beat, its state kept', () => {
  const r = rig(PARS);
  const macro = spec({ kind: 'macro', params: { steps: [{ effect: probe('step 0'), beats: 4 }, { effect: probe('step 1'), beats: 4 }], loopBeats: 8 } });
  const v = voice('pad:1', macro, { startedAtMs: 0, anchorBeat: 0 });
  r.at(0, { voices: [v] }, { beatPos: 0.5, epoch: 1 });
  const stepState = lastState;
  r.at(25, { voices: [v] }, { beatPos: 0.55, epoch: 1 });
  // A seek to beat 40.3: the voice anchors at 40, and its macro is in the same step, 0.3 beats in.
  r.at(50, { voices: [v] }, { beatPos: 40.3, epoch: 2 });
  assert.strictEqual(lastState, stepState, 'the step\'s state, not a new one');
  const after = stepState.frames.at(-1).frame;
  assert.strictEqual(after.anchorBeat, 40, 'counted from the new beat, not 40 beats on from the old one');
  assert.strictEqual(after.startedAtMs, stepState.frames[0].frame.startedAtMs, 'its wall start stays');
});

test('a jump in the music starts the base again, even back onto the step it was on', () => {
  const r = rig(PARS);
  const first = captureState(r, probe('b'), 0, {}, { beatPos: 0, epoch: 1 });
  assert.strictEqual(captureState(r, probe('b'), 25, {}, { beatPos: 0.05, epoch: 1 }), first);
  // A seek back to the top: a new epoch whose anchor is the same step 0.
  const again = captureState(r, probe('b'), 50, {}, { beatPos: 0, epoch: 2, anchorBeat: 0 });
  assert.notStrictEqual(again, first);
  assert.strictEqual(again.frames[0].frame.instanceId, first.frames[0].frame.instanceId, 'the same public id');
});

test('effects are handed the real time since their last frame, not the expression\'s clamped step', () => {
  const r = rig(PARS);
  captureState(r, probe(), 0);
  const s = captureState(r, probe(), 1000);
  assert.strictEqual(s.frames[1].frame.dtMs, 1000, 'a whole second, which a Light DJ fade must replay');
  captureState(r, probe(), 900);
  assert.strictEqual(s.frames[2].frame.dtMs, 0, 'never negative');
});

test('a voice before its start or at its end plays nothing; a relaunch under the same id starts it afresh, the same snapshot does not', () => {
  const blinder = preset('energy.blinder');
  const r = rig([PAR]);
  assert.strictEqual(r.at(99, { voices: [voice('pad', blinder, { startedAtMs: 100 })] })[0].w, 0, 'not yet');
  assert.strictEqual(r.at(100, { voices: [voice('pad', blinder, { startedAtMs: 100 })] })[0].w, 255, 'from its start');
  assert.strictEqual(r.at(150, { voices: [voice('pad', blinder, { startedAtMs: 100, untilMs: 150 })] })[0].w, 0, 'not at its end');
  const p = rig([PAR]);
  const v = voice('pad', probe('x'), { launchSeq: 4 });
  p.at(0, { voices: [v] });
  const kept = lastState;
  p.at(25, { voices: [structuredClone(v)] });
  assert.strictEqual(lastState, kept, 'a snapshot rebuilt in the worker is the same launch');
  p.at(50, { voices: [{ ...v, launchSeq: 5 }] });
  assert.notStrictEqual(lastState, kept, 'a new launch starts again');
  const relaunch = lastState;
  p.at(75, { voices: [{ ...v, launchSeq: 5, spec: probe('y') }] });
  assert.notStrictEqual(lastState, relaunch, 'so do new settings under the id');
});

// ── Cells, fixture ids and what a frame carries ─────────────────────────────

const BAR = barProfile({ id: 'effects-test-bar', name: 'Test Bar', cells: 4, firstChannel: 3, order: 'RGBW', dimmer: 1, strobe: 2 });

test('voice targets are fixture ids on every cell: odd ids, a bar\'s cells, a wash fixture, a missing id, none', () => {
  registerProfile(BAR);
  try {
    // Ids out of patch order and far apart; a bar of four cells among them.
    const fixtures = [fixture(51, 1), fixture(7, 13), fixture(30, 25, BAR.id)];
    const blinder = preset('energy.blinder');
    // The white of each cell of the bar, from its profile's cell maps.
    const cellWhites = (r) => getProfile(fixtures[2]).cells.map((cell) => r.store.getBuffer(0)[fixtures[2].address - 1 + cell.channelMap.white]);
    const dims = (patch) => {
      const r = rig(fixtures);
      const out = r.at(10, patch);
      return [out[51].w, out[7].w, Math.max(...cellWhites(r))];
    };
    assert.deepStrictEqual(dims({ voices: [voice('pad', blinder, { targets: [7] })] }), [0, 255, 0]);
    assert.deepStrictEqual(dims({ voices: [voice('pad', blinder, { targets: [51, 30] })] }), [255, 0, 255], 'the bar, every cell');
    const r = rig(fixtures);
    r.at(10, { voices: [voice('pad', blinder, { targets: [30] })] });
    assert.deepStrictEqual(cellWhites(r), [255, 255, 255, 255], 'all four cells white');
    assert.deepStrictEqual(dims({ voices: [voice('pad', blinder, { targets: [99] })] }), [0, 0, 0], 'an id nobody has: nothing, never a slot index');
    assert.deepStrictEqual(dims({ voices: [voice('pad', blinder, { targets: [0, 1, 2] })] }), [0, 0, 0], 'slot indices are not ids');
    assert.deepStrictEqual(dims({ voices: [voice('pad', blinder, { targets: [] })] }), [0, 0, 0], 'an empty selection covers nothing');
    assert.deepStrictEqual(dims({ voices: [voice('pad', blinder, { targets: null })] }), [255, 255, 255], 'null covers the rig');
    // A split look's wash fixture is still a fixture a voice can name.
    const placed = PARS.map((f, i) => ({ ...f, position: { x: 10 + 25 * i, y: 50 }, group: i < 2 ? 'front' : 'back' }));
    const washRig = rig(placed);
    const washed = washRig.at(10, { split: 1 });
    const washIds = placed.filter((f) => washed[f.id].b === BLUE.b && washed[f.id].r === BLUE.r).map((f) => f.id);
    assert.ok(washIds.length >= 1 && washIds.length < placed.length, `the split holds a wash (${washIds})`);
    const washOut = washRig.at(20, { split: 1, voices: [voice('pad', blinder, { targets: washIds })] });
    assert.deepStrictEqual(placed.map((f) => washOut[f.id].w), placed.map((f) => (washIds.includes(f.id) ? 255 : 0)), 'a voice on the wash fixtures only');
    // The same geometry with a fixture's id changed: the voice follows the new id.
    const renamed = [fixture(51, 1), fixture(8, 13), fixture(30, 25, BAR.id)];
    const rr = rig(fixtures);
    rr.at(10, { voices: [voice('pad', blinder, { targets: [8] })] });
    const after = (() => { const g = input({ fixtures: renamed, voices: [voice('pad', blinder, { targets: [8] })] }); rr.renderer.frame(g, { beatPos: 0, bpm: 120, epoch: 0 }, 20, rr.store); return rr.read(renamed[1]).w; })();
    assert.strictEqual(after, 255);
  } finally {
    unregisterProfile(BAR.id);
  }
});

test('the base plays on the look\'s split cells; the wash holds colour B and a split change leaves the voices be', () => {
  const placed = PARS.map((f, i) => ({ ...f, position: { x: 10 + 25 * i, y: 50 }, group: i < 2 ? 'front' : 'back' }));
  const r = rig(placed);
  const v = voice('pad', probe('v'), { targets: [] });
  r.at(0, { pattern: 'look', effect: spec({ kind: 'test.plain' }), split: 1, voices: [v] });
  const voiceState = lastState;
  const out = r.at(25, { pattern: 'look', effect: spec({ kind: 'test.plain' }), split: 1, voices: [v] });
  const colours = placed.map((f) => [out[f.id].r, out[f.id].g, out[f.id].b]);
  const blue = [BLUE.r, BLUE.g, BLUE.b];
  const washed = colours.filter((c) => c.join() === blue.join()).length;
  assert.ok(washed >= 1 && washed < placed.length, `the wash in colour B on its lamps only (${JSON.stringify(colours)})`);
  assert.ok(colours.some((c) => c.join() === '255,255,255'), 'the effect on the rest');
  r.at(50, { pattern: 'look', effect: spec({ kind: 'test.plain' }), split: 0, voices: [v] });
  assert.strictEqual(lastState, voiceState, 'the voice\'s layout is the whole rig: a new split does not restart it');
});

test('a frame carries each cell\'s fixture id, the room\'s Hue lamps (profile-only included), the Hue strobe and the same audio frame', () => {
  registerProfile(BAR);
  try {
    const profileOnly = fixture(9, 40, HUE_COLOR_PROFILE_ID);
    const fixtures = [fixture(51, 1), fixture(30, 13, BAR.id), LAMP, profileOnly];
    const audio = { t: 3.25, generation: 2, rms: 0.1, power: 1, dominantHz: 100, party: { full: 0.5, bass: 0.5, mid: 0.5, high: 0.5 },
      disco: { hit: [false, false, false], gate: [0, 0, 0], level: [0, 0, 0], peakHit: false, neural: { mainFrequency: 0, amplitude: 0 } },
      spl: { db: -40, level: 0, beat: null, section: null } };
    const r = rig(fixtures);
    const state = captureState(r, probe(), 0, { audio, audioMode: 'reactive', hueStrobe: 'flash' });
    captureState(r, probe(), 25, { audio, audioMode: 'reactive', hueStrobe: 'flash' });
    const [{ frame, room }, second] = state.frames;
    // Stage order on an unplaced rig: the par, the bar's four cells, the lamps.
    assert.deepStrictEqual([...frame.fixtureIds].sort((a, b) => a - b), [1, 9, 30, 30, 30, 30, 51]);
    assert.strictEqual(frame.fixtureIds.filter((id) => id === 30).length, 4, 'one id per cell of the bar');
    const hueIds = frame.fixtureIds.filter((id, k) => room.hue[k]);
    assert.deepStrictEqual(hueIds.sort((a, b) => a - b), [1, 9], 'the lamp by its output, the other by its profile alone');
    assert.strictEqual(frame.hueStrobe, 'flash');
    assert.strictEqual(frame.audio, audio, 'the frame as heard, not a copy and not re-stamped');
    assert.strictEqual(second.frame.audio, audio, 'again on the next frame: one hop is one event');
    assert.strictEqual(frame.audioMode, 'reactive');
    assert.strictEqual(frame.expressionLevel, 1);
    assert.strictEqual(frame.acknowledged, false);
    assert.strictEqual(frame.manualStrobeActive, false);
    // A hand-built input without audio fields reads none, 'tempo' and the master's defaults (12a reads them first).
    const bare = captureState(rig(fixtures), probe(), 0);
    assert.deepStrictEqual([bare.frames[0].frame.audio, bare.frames[0].frame.audioMode, bare.frames[0].frame.master], [null, 'tempo', HD_MASTER_DEFAULTS]);
    assert.strictEqual(bare.frames[0].frame.hueStrobe, 'pulse', 'absent: as before the setting');
  } finally {
    unregisterProfile(BAR.id);
  }
});

test('on a placed rig with a Hue lamp each layer keeps its room frame after frame, under a base effect and under a party look', () => {
  // The look, the base effect and the voices all read the plan; a room built
  // afresh each frame would lose what is kept with it (Light DJ's channels).
  const placed = [...PARS, { ...LAMP, address: 60 }].map((f, i) => ({ ...f, position: { x: 10 + 20 * i, y: 30 + 10 * i } }));
  const roomsOf = (patch) => {
    const r = rig(placed);
    const seen = { base: [], voice: [] };
    for (let k = 0; k < 3; k++) {
      roomsSeen.length = 0;
      r.at(k * 25, { voices: [voice('pad', spec({ kind: 'test.rooms', params: { tag: 'voice' } }))], ...patch });
      for (const [tag, room] of roomsSeen) seen[tag].push(room);
    }
    return seen;
  };
  const same = (rooms) => rooms.length === 3 && rooms.every((room) => room === rooms[0]);
  const underBase = roomsOf({ pattern: 'look', effect: spec({ kind: 'test.rooms', params: { tag: 'base' } }) });
  assert.ok(same(underBase.voice), 'the voices\' room under a base effect');
  assert.ok(same(underBase.base), 'the base effect\'s room');
  assert.ok(underBase.voice[0].hue.some(Boolean), 'the lamp is the room\'s Hue lamp');
  const underLook = roomsOf({ pattern: 'ring-strobe' });
  assert.ok(same(underLook.voice), 'the voices\' room under a party look that reads the plan too');
});

test('a hand-built input without audio, mode or master renders an effect as the explicit defaults do', () => {
  const run = (patch) => {
    const r = rig(PARS);
    const frames = [];
    for (let k = 0; k < 30; k++) {
      const out = r.at(k * 50, { pattern: 'look', effect: preset('hd.velvetBreath'), ...patch });
      frames.push(PARS.map((f) => [out[f.id].dim, out[f.id].r, out[f.id].g, out[f.id].b]));
    }
    return frames;
  };
  const bare = run({});
  assert.deepStrictEqual(bare, run({ audio: null, audioMode: 'tempo', master: { ...HD_MASTER_DEFAULTS } }));
  assert.ok(bare.some((f) => f.some(([dim]) => dim > 0)), 'and it plays: tempo, not black');
});

test('Disco\'s automatic strobe stands down for any playing manual strobe, on top or not; one ended or still to come does not count', () => {
  const r = rig(PARS);
  const flag = (voices) => captureState(r, probe(), 0, { voices }).frames.at(-1).frame.manualStrobeActive;
  const strobe = (extra) => voice('strobe', preset(HOLD_STROBE), { tier: 'strobe', ...extra });
  assert.strictEqual(flag([]), false);
  assert.strictEqual(flag([strobe()]), true);
  assert.strictEqual(flag([strobe(), voice('pad', preset('energy.kill'), { launchSeq: 9 })]), true, 'hidden under a later voice, still a strobe playing');
  assert.strictEqual(flag([strobe({ startedAtMs: 10 })]), false, 'not started');
  assert.strictEqual(flag([strobe({ untilMs: 0 })]), false, 'ended');
  assert.strictEqual(flag([strobe({ targets: [99] })]), false, 'on no fixture of the patch');
  assert.strictEqual(flag([voice('pad', preset('energy.whiteStrobe'))]), false, 'a strobe-channel energy is not the manual strobe');
  // The hold strobe as the energy burst counts too, when the renderer plays it.
  assert.strictEqual(captureState(r, probe(), 0, { energy: HOLD_STROBE }).frames.at(-1).frame.manualStrobeActive, true);
});

test('an empty rig renders no effect and initializes nothing', () => {
  const r = rig([]);
  lastState = null;
  r.at(0, { pattern: 'look', effect: probe(), voices: [voice('pad', probe('v'))], universes: [] });
  assert.strictEqual(lastState, null);
});

// ── The energy burst as a voice, and who may see a fast flash ───────────────

// Universe 0's first 47 bytes (a par, a Hue lamp, a four-cell bar) after
// each energy, captured with this branch's base (b0215e5), where the burst
// was resolved per fixture: the warm white colour A carries white and amber,
// glow rides the expression level, and the hold strobe flashes per lamp.
const BURST = JSON.parse(fs.readFileSync(new URL('../fixtures/golden/energy-burst.json', import.meta.url), 'utf8'));

test('every energy and the hold strobe play exactly as the burst always did, extra emitters and strobe channel included', () => {
  registerProfile(BAR);
  try {
    const FIX = [PAR, LAMP, fixture(2, 30, BAR.id)];
    const bytes = (patch, times) => {
      const r = rig(FIX);
      for (const ms of times) r.at(ms, { pattern: 'chase', colorA: 9, colorB: 5, colorC: 9, colorD: 5, ...patch });
      return Array.from(r.store.getBuffer(0).subarray(0, 47));
    };
    const settle = Array.from({ length: 81 }, (_, k) => k * 25);
    for (const e of ['white-strobe', 'color-strobe', 'blinder', 'uv-wash', 'kill', 'glow']) assert.deepStrictEqual(bytes({ energy: e }, [10]), BURST[e], e);
    for (const level of [0, 0.5, 1]) assert.deepStrictEqual(bytes({ energy: 'glow', showDynamics: { level } }, settle), BURST[`glow@${level}`], `glow at ${level}`);
    assert.deepStrictEqual(bytes({ energy: 'blinder', showDynamics: { level: 0.3 } }, settle), BURST['blinder@0.3'], 'the burst bypasses the expression');
    assert.deepStrictEqual(bytes({ energy: 'blinder', masterDimmer: 128 }, [10]), BURST['blinder-master'], 'and follows the master');
    for (const ms of [0, 60, 100, 170, 200, 250, 320, 480, 760]) assert.deepStrictEqual(bytes({ energy: HOLD_STROBE }, [ms]), BURST[`hold@${ms}`], `the hold strobe at ${ms} ms`);
    // Glow's own curve: 150, 203 and 255 at levels 0, .5 and 1, never multiplied by the level again.
    assert.deepStrictEqual([0, 0.5, 1].map((level) => BURST[`glow@${level}`][0]), [150, 203, 255]);
    assert.deepStrictEqual([0, 0.5, 1].map((level) => resolveEnergyOverride('glow', COLOR_PRESETS[9], level).dim), [150, 203, 255]);
    assert.strictEqual(bytes({ energy: 'no-such-energy' }, [10])[0], bytes({}, [10])[0], 'an unknown energy is no burst');
  } finally {
    unregisterProfile(BAR.id);
  }
});

test('the hold strobe is the catalogue\'s palette-strobe row: five a second on the beat grid, the look\'s colours, the look between', () => {
  const row = preset(HOLD_STROBE);
  assert.strictEqual(row.params.flashesPerSecond, 5, 'not the strobe kind\'s own default of two');
  assert.deepStrictEqual([row.kind, row.params.clock, row.params.continueBetween, row.palette], ['strobe', 'beat', true, null]);
  // At 128 BPM five a second is a flash every half beat (234.375 ms); two a second would be every two beats.
  // Each flash is followed by its 100 ms of black, the one time the solid look below is dark.
  const r = rig([PAR]);
  const flashes = [];
  let before = false;
  for (let k = 0; k <= 88; k++) {
    const ms = k * FRAME_MS;
    const out = r.at(ms, { energy: HOLD_STROBE }, { beatPos: ms * 128 / 60000, bpm: 128, grid: 0 })[PAR.id];
    const black = out.dim === 0;
    if (black && !before) flashes.push(Math.round(ms));
    before = black;
  }
  assert.strictEqual(flashes.length, 9, `nine flashes in two seconds: ${flashes}`);
  for (let i = 1; i < flashes.length; i++) assert.ok(Math.abs(flashes[i] - flashes[i - 1] - 234.375) < FRAME_MS, `${flashes[i - 1]} → ${flashes[i]}`);
});

test('only the renderer\'s own burst, on an input that says nothing of safety, keeps the old admission', () => {
  const white = (patch) => rig([PAR]).at(10, { pattern: 'solid', colorA: 0, ...patch })[PAR.id];
  // The strobe-channel energies, the hold strobe: rapid kinds.
  assert.strictEqual(white({ energy: 'white-strobe' }).g, 255, 'no safety field: as it always played');
  assert.strictEqual(white({ energy: 'white-strobe', safety: { hdFlashIntervalMs: 350, acknowledged: false } }).g, 0, 'safety present, not acknowledged: the look');
  assert.strictEqual(white({ energy: 'white-strobe', safety: { hdFlashIntervalMs: 350, acknowledged: true } }).g, 255, 'acknowledged');
  assert.strictEqual(rig([PAR]).at(100, { energy: HOLD_STROBE, safety: { hdFlashIntervalMs: 350, acknowledged: false } })[PAR.id].dim, 255,
    'no hold strobe either: the look shows where it would have been black');
  // A caller's own voice gets no exception, however it is named, with or without safety.
  assert.strictEqual(white({ voices: [voice('energy:white-strobe', preset('energy.whiteStrobe'))] }).g, 0);
  assert.strictEqual(white({ effect: preset('energy.whiteStrobe') }).g, 0, 'nor a base effect');
  // A steady energy needs nothing.
  assert.strictEqual(white({ energy: 'blinder', safety: { hdFlashIntervalMs: 350, acknowledged: false } }).g, 255);
});

// ── Hue Dynamics' flash limit: its own kinds, the winner's kind, the output ──

/** Frame times at which the par rises to bright (≥ 55 % after the masters), over `seconds`, each frame given `patch(k)`. */
function brightRises(fixtures, patch, { seconds = 1, from = 0 } = {}) {
  const r = rig(fixtures);
  const fix = fixtures[0];
  const times = [];
  let bright = false;
  for (let k = 0; k <= 44 * seconds; k++) {
    const ms = from + k * FRAME_MS;
    const out = r.at(ms, patch(k, ms), { grid: 0 })[fix.id];
    const now = out.dim / 255 >= 0.5;
    if (now && !bright) times.push(Math.round(ms * 10) / 10);
    bright = now;
  }
  return times;
}
const SAFETY = (hdFlashIntervalMs = 350, acknowledged = true) => ({ safety: { hdFlashIntervalMs, acknowledged } });

test('Disco is outside the limit: its reactive hits flash at their own rate under 350 ms', () => {
  // A bass hit every 100 ms of stream time, each a new hop.
  const hop = (t) => ({ t, generation: 1, rms: 0.2, power: 1, dominantHz: 80, party: { full: 0.8, bass: 0.9, mid: 0.2, high: 0.1 },
    disco: { hit: [true, false, false], gate: [0, 0, 0], level: [1, 0, 0], peakHit: false, neural: { mainFrequency: 0, amplitude: 0 } },
    spl: { db: -20, level: 20, beat: null, section: null } });
  const disco = preset('hd.disco.dance');
  const run = (interval) => brightRises([PAR], (k, ms) => ({ pattern: 'look', effect: disco, audioMode: 'reactive', audio: hop(Math.floor(ms / 100) / 10), ...SAFETY(interval) }));
  const limited = run(350);
  assert.deepStrictEqual(limited, run(0), 'the same with and without the limit');
  assert.ok(limited.length > 3, `${limited.length} hits a second`);
});

test('the limit reads the winning slot\'s kind: a macro\'s Hue Dynamics step is held, another layer on top is not', () => {
  const twinkleMacro = spec({ kind: 'macro', params: { steps: [{ effect: WHITE_TWINKLE, beats: 4 }], loopBeats: 4 } });
  const macro = brightRises([PAR], () => ({ pattern: 'look', effect: twinkleMacro, ...SAFETY() }));
  assert.ok(macro.length <= 3, `a macro step of twinkle: ${macro.length} rises`);
  // An LDJ base under a Hue Dynamics voice that draws nothing (an empty target list): the LDJ base is not held.
  const trueStrobe = spec({ kind: 'ldj.TrueStrobe', palette: ['#FFFFFF'] });
  const quietVoice = voice('pad', WHITE_TWINKLE, { targets: [] });
  assert.ok(brightRises([PAR], () => ({ pattern: 'look', effect: trueStrobe, voices: [quietVoice], ...SAFETY() })).length >= 10);
  // An LDJ voice over a Hue Dynamics base: the LDJ voice wins the lamp and is not held.
  assert.ok(brightRises([PAR], () => ({ pattern: 'look', effect: WHITE_TWINKLE, voices: [voice('pad', trueStrobe)], ...SAFETY() })).length >= 10);
  // A Hue Dynamics voice over a dark base is held; where it is transparent the base (not Hue Dynamics) shows, unheld.
  assert.ok(brightRises([PAR], () => ({ pattern: 'look', effect: preset('energy.kill'), voices: [voice('pad', WHITE_TWINKLE)], ...SAFETY() })).length <= 3);
  // Kill over the twinkle owns the lamp black and spends nothing: the twinkle rises at once when the kill lets go.
  const kill = voice('pad', preset('energy.kill'), { startedAtMs: 0, untilMs: 200 });
  const after = brightRises([PAR], () => ({ pattern: 'look', effect: WHITE_TWINKLE, voices: [kill], ...SAFETY() }));
  assert.ok(after[0] >= 200 && after[0] < 270, `first rise after the kill at ${after[0]} ms`);
});

test('a lamp a low master or trim keeps dim spends no rise; another layer between rises ends a held one; a new interval keeps the history', () => {
  // At master 100 the twinkle never reaches 55 %: nothing is held back, every event shows.
  const r = rig([PAR]);
  const lows = [];
  let before = 0;
  for (let k = 0; k <= 44; k++) {
    const out = r.at(k * FRAME_MS, { pattern: 'look', effect: WHITE_TWINKLE, masterDimmer: 100, ...SAFETY() }, { grid: 0 })[PAR.id];
    if (out.dim > 0 && before === 0) lows.push(k);
    before = out.dim;
  }
  assert.ok(lows.length >= 12, `${lows.length} dim flashes`);
  const trimmed = brightRises([{ ...PAR, maxBrightness: 120 }], () => ({ pattern: 'look', effect: WHITE_TWINKLE, ...SAFETY() }));
  assert.deepStrictEqual(trimmed, [], 'never bright through a 120 trim, so never counted');
  // A blinder pad over the twinkle at 100..150 ms: when it lets go the twinkle's next bright frame is a new rise, refused inside 350 ms.
  const pad = voice('pad', preset('energy.blinder'), { startedAtMs: 100, untilMs: 150 });
  const g = rig([PAR]);
  const dims = [];
  for (let k = 0; k <= 22; k++) dims.push(g.at(k * FRAME_MS, { pattern: 'look', effect: WHITE_TWINKLE, voices: [pad], ...SAFETY() }, { grid: 0 })[PAR.id].dim);
  assert.ok(dims[0] > 140, 'the first event rises');
  assert.strictEqual(dims[5], 255, 'the pad at full');
  assert.ok(dims.slice(7, 15).every((d) => d === 0), `after the pad, held dark until 350 ms: ${dims.slice(7, 16)}`);
  // The interval changed mid-run applies at once, and the rise at 0 still counts.
  const h = rig([PAR]);
  const seen = [];
  for (let k = 0; k <= 22; k++) {
    const interval = k < 5 ? 350 : 200;
    seen.push(h.at(k * FRAME_MS, { pattern: 'look', effect: WHITE_TWINKLE, ...SAFETY(interval) }, { grid: 0 })[PAR.id].dim > 140);
  }
  const risesAt = seen.flatMap((on, k) => (on && !seen[k - 1] ? [k] : []));
  assert.strictEqual(risesAt[0], 0);
  assert.ok(risesAt[1] * FRAME_MS >= 200 && risesAt[1] * FRAME_MS < 350, `the next rise at ${risesAt[1] * FRAME_MS} ms, on the new 200 ms`);
});

// ── The strobe's permit: on the engine's frame grid, through relaunches ─────

const WALL_STROBE = spec({ kind: 'strobe', palette: ['#FFFFFF'], params: { flashesPerSecond: 5, clock: 'wall', continueBetween: false } });

/** Rises of the par (dark → lit) for frames at `times`, each rendered with `patch(ms, k)` and `grid`. */
function strobeRises(times, patch, grid) {
  const r = rig([PAR]);
  const rises = [];
  let lit = false;
  times.forEach((ms, k) => {
    const out = r.at(ms, patch(ms, k), { grid })[PAR.id];
    const on = out.dim === 255 && out.r === 255;
    if (on && !lit) rises.push(k);
    lit = on;
  });
  return rises;
}

test('the effects count frames from the grid\'s origin: at any phase, with timer jitter, five a second shows all fifty flashes', () => {
  for (const phase of [0, 7.3, FRAME_MS / 2 - 1, FRAME_MS / 2 + 1, FRAME_MS - 0.5]) {
    for (const jitter of ['late', 'both']) {
      const origin = 123456.789 + phase;
      let seed = 7;
      const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
      const times = Array.from({ length: 441 }, (_, k) => origin + k * FRAME_MS + (jitter === 'late' ? 2 * rand() : 4 * rand() - 2));
      const launch = times[0];
      const rises = strobeRises(times, () => ({ voices: [voice('strobe', WALL_STROBE, { tier: 'strobe', startedAtMs: launch })], ...SAFETY() }), origin);
      assert.strictEqual(rises.length, 50, `phase ${phase.toFixed(2)} ms, ${jitter}: ${rises.length} of 50`);
      for (let i = 1; i < rises.length; i++) assert.ok(rises[i] - rises[i - 1] >= 8, `(a) at phase ${phase}: frames ${rises[i - 1]} → ${rises[i]}`);
      for (let i = 5; i < rises.length; i++) assert.ok(rises[i] - rises[i - 5] >= 44, `(b) at phase ${phase}`);
    }
  }
});

test('the strobe\'s permit carries through a relaunch under its voice id and a relaunch of a strobe look', () => {
  const frames = Array.from({ length: 30 }, (_, k) => k * FRAME_MS);
  // Relaunched six frames (136 ms) after its first flash, dark by then: the new grid's first flash waits out the permit.
  const relaunchAt = 6;
  const viaVoice = strobeRises(frames, (ms, k) => ({ voices: [voice('strobe', WALL_STROBE, { tier: 'strobe', launchSeq: k < relaunchAt ? 1 : 2,
    startedAtMs: k < relaunchAt ? 0 : frames[relaunchAt] })], ...SAFETY() }), 0);
  assert.strictEqual(viaVoice[0], 0);
  assert.ok(viaVoice[1] >= 8, `the relaunch waits: second rise on frame ${viaVoice[1]}`);
  // The same look launched again (a new anchor step): the base keeps its permit too.
  const viaBase = strobeRises(frames, (ms, k) => ({ pattern: 'strobe-look', effect: WALL_STROBE,
    patternAnchor: { step: k < relaunchAt ? 0 : 1, epoch: 0, seq: k < relaunchAt ? 1 : 2 }, ...SAFETY() }), 0);
  assert.strictEqual(viaBase[0], 0);
  assert.ok(viaBase[1] >= 8, `the relaunched look waits: second rise on frame ${viaBase[1]}`);
  // Without the carry two instances would each flash at once: a fresh id is a fresh permit.
  const fresh = strobeRises(frames, (ms, k) => ({ voices: [voice(k < relaunchAt ? 'strobe' : 'other', WALL_STROBE, { tier: 'strobe',
    startedAtMs: k < relaunchAt ? 0 : frames[relaunchAt] })], ...SAFETY() }), 0);
  assert.strictEqual(fresh[1], relaunchAt, 'a different id flashes on its launch frame');
});

test('two strobe voices on one lamp never interleave: the higher one covers it, flashing or not', () => {
  const frames = Array.from({ length: 88 }, (_, k) => k * FRAME_MS);
  const a = voice('strobe', WALL_STROBE, { tier: 'strobe', launchSeq: 2 });
  const b = voice('energy:palette-strobe', spec({ kind: 'strobe', palette: ['#FF0000'], params: { flashesPerSecond: 5, clock: 'wall', continueBetween: true } }),
    { tier: 'strobe', launchSeq: 1, startedAtMs: 100 });
  const rises = strobeRises(frames, () => ({ voices: [a, b], ...SAFETY() }), 0);
  assert.strictEqual(rises.length, 10, `five a second, not ten: ${rises}`);
  for (let i = 1; i < rises.length; i++) assert.ok(rises[i] - rises[i - 1] >= 8);
});

// ── Commands for the base effect ────────────────────────────────────────────

test('commands reach the base\'s state once each, in order, after it starts and before it first draws', () => {
  const r = rig(PARS);
  const base = probe('studio-like');
  const intent = baseIntentOf({ pattern: 'look', effect: base });
  r.renderer.command(1, 'stop', undefined, intent);
  r.renderer.command(2, 'toggleDirection', undefined, intent);
  r.renderer.command(3, 'setPulserBaselineColor', { r: 0, g: 255, b: 0 }, intent);
  assert.deepStrictEqual(r.renderer.commandStatus(), { processed: 0, applied: 0 }, 'submitted is not applied');
  assert.deepStrictEqual(r.renderer.takeCommandResults(), [], 'nothing decided before a frame');
  const state = captureState(r, base, 0);
  assert.deepStrictEqual(state.commands.map((c) => [c.cmd, c.after]), [['stop', 0], ['toggleDirection', 0], ['setPulserBaselineColor', 0]],
    'all three on the fresh state, before its first frame was drawn');
  assert.deepStrictEqual(state.commands[2].arg, { r: 0, g: 255, b: 0, w: 0, a: 0, uv: 0 });
  assert.deepStrictEqual(r.renderer.takeCommandResults(), [1, 2, 3].map((seq) => ({ seq, status: 'applied' })));
  assert.deepStrictEqual(r.renderer.commandStatus(), { processed: 3, applied: 3 });
  // The same sequence again is never applied twice; a later one is applied once, on the kept state.
  r.renderer.command(3, 'toggleDirection', undefined, intent);
  r.renderer.command(4, 'toggleDirection', undefined, intent);
  r.renderer.command(4, 'toggleDirection', undefined, intent);
  captureState(r, base, 25);
  assert.deepStrictEqual(state.commands.map((c) => c.cmd), ['stop', 'toggleDirection', 'setPulserBaselineColor', 'toggleDirection']);
  assert.deepStrictEqual(r.renderer.takeCommandResults(), [{ seq: 3, status: 'duplicate' }, { seq: 4, status: 'applied' }, { seq: 4, status: 'duplicate' }]);
  assert.deepStrictEqual(r.renderer.commandStatus(), { processed: 4, applied: 4 });
});

test('a command meant for another base, a pattern, a kind without commands or a base that may not play is refused, decided but not applied', () => {
  const r = rig(PARS);
  const base = probe('a');
  captureState(r, base, 0);
  const status = (seq, cmd, arg, intent, patch) => {
    r.renderer.command(seq, cmd, arg, intent);
    r.at(25 * seq, { pattern: 'look', ...patch });
    return r.renderer.takeCommandResults();
  };
  const intent = baseIntentOf({ pattern: 'look', effect: base });
  assert.deepStrictEqual(status(1, 'stop', undefined, { ...intent, content: 'something else' }, { effect: base }), [{ seq: 1, status: 'stale' }]);
  assert.deepStrictEqual(status(2, 'stop', undefined, { ...intent, revision: 4 }, { effect: base }), [{ seq: 2, status: 'stale' }], 'another revision');
  assert.deepStrictEqual(status(3, 'stop', undefined, intent, { effect: null, pattern: 'chase' }), [{ seq: 3, status: 'unsupported' }], 'a pattern');
  assert.deepStrictEqual(status(4, 'stop', undefined, null, { effect: spec({ kind: 'test.plain' }) }), [{ seq: 4, status: 'unsupported' }], 'no command hook');
  const gated = probe('a', { rapidFlash: true });
  assert.deepStrictEqual(status(5, 'stop', undefined, baseIntentOf({ pattern: 'look', effect: gated }), { effect: gated }), [{ seq: 5, status: 'unavailable' }],
    'not acknowledged: it never started');
  assert.deepStrictEqual(status(6, 'explode', undefined, intent, { effect: base }), [{ seq: 6, status: 'invalid' }]);
  assert.deepStrictEqual(status(7, 'setPulserBaselineColor', { r: 300, g: 0, b: 0 }, intent, { effect: base }), [{ seq: 7, status: 'invalid' }]);
  assert.deepStrictEqual(status(8, 'stop', 'please', intent, { effect: base }), [{ seq: 8, status: 'invalid' }]);
  assert.deepStrictEqual(r.renderer.commandStatus(), { processed: 8, applied: 0 }, 'every refusal counted as decided, none as applied');
  // Stopped, the base holds its state: a command for it still lands there.
  const kept = captureState(r, base, 300);
  assert.deepStrictEqual(status(9, 'toggleDirection', undefined, intent, { effect: base, running: false }), [{ seq: 9, status: 'applied' }]);
  assert.strictEqual(kept.commands.length, 1);
  assert.deepStrictEqual(status(10, 'toggleDirection', undefined, baseIntentOf({ pattern: 'look', effect: probe('b') }), { effect: probe('b'), running: false }),
    [{ seq: 10, status: 'unavailable' }], 'a base that never played while stopped has no state yet');
  // A worker with nothing to render decides what waits as unavailable.
  r.renderer.command(11, 'stop', undefined, intent);
  r.renderer.rejectCommands('unavailable');
  assert.deepStrictEqual(r.renderer.takeCommandResults(), [{ seq: 11, status: 'unavailable' }]);
});

test('commands reach the base alone, never a voice of the same kind', () => {
  const r = rig(PARS);
  const base = probe('base');
  const v = voice('pad', probe('voice'));
  r.at(0, { pattern: 'look', effect: base, voices: [v] });
  const voiceState = lastState;
  r.renderer.command(1, 'stop', undefined, baseIntentOf({ pattern: 'look', effect: base }));
  r.at(25, { pattern: 'look', effect: base, voices: [v] });
  assert.deepStrictEqual(voiceState.commands, []);
  assert.deepStrictEqual(r.renderer.takeCommandResults(), [{ seq: 1, status: 'applied' }]);
});

test('Studio stopped before its first frame starts no note of its own', () => {
  // Studio Fireworks starts a note on a lamp every fifth lamp frame by itself, after the one it starts with.
  const studio = spec({ kind: 'ldj.StudioFireworks', palette: ['#FF0000'] });
  const intent = baseIntentOf({ pattern: 'studio', effect: studio });
  const notes = (stop) => {
    const r = rig(PARS);
    if (stop) r.renderer.command(1, 'stop', undefined, intent);
    let count = 0;
    const last = PARS.map(() => 0);
    for (let k = 0; k < 88; k++) {
      const out = r.at(k * FRAME_MS, { pattern: 'studio', effect: studio, ...SAFETY() });
      // A note starts at full: the one time a lamp brightens, where a note's fade only falls.
      // The first frame shows the launch (its own note and the baseline) and is the reference.
      PARS.forEach((f, i) => { if (k > 0 && out[f.id].dim - last[i] > 30) count++; last[i] = out[f.id].dim; });
    }
    return { count, results: r.renderer.takeCommandResults() };
  };
  const free = notes(false);
  assert.ok(free.count > 5, `it plays on its own: ${free.count} notes`);
  const stopped = notes(true);
  assert.strictEqual(stopped.count, 0, `stopped before its first frame: ${stopped.count} notes after the one it was launched with`);
  assert.deepStrictEqual(stopped.results, [{ seq: 1, status: 'applied' }]);
});

test('the audio detectors pick their owner in the renderer\'s own order, ties included', () => {
  const vis = (trigger) => spec({ kind: 'ldj.visualizer', params: { trigger } });
  const cases = [
    // Same tier and launch: the one on chosen fixtures; then the later start; then the first listed.
    [{ targets: null }, { targets: [PAR.id] }],
    [{ startedAtMs: 0 }, { startedAtMs: 5 }],
    [{}, {}],
    [{ tier: 'strobe', launchSeq: 1 }, { launchSeq: 9 }],
    [{ launchSeq: 3 }, { launchSeq: 2 }],
  ];
  for (const [a, b] of cases) {
    const ranks = [{ id: 'a', ...a }, { id: 'b', ...b }];
    // What the lamp shows: the blinder for a, the UV wash for b.
    const shown = rig([PAR]).at(10, { voices: ranks.map((rank) => voice(rank.id, preset(rank.id === 'a' ? 'energy.blinder' : 'energy.uvWash'), rank)) })[PAR.id];
    const winner = shown.w === 255 ? 'a' : 'b';
    const detectors = resolveDetectors({ base: null, voices: ranks.map((rank, i) => voice(rank.id, vis(i ? 0.2 : 0.1), rank)), nowMs: 10,
      fixtureIds: [PAR.id], ldjTrigger: 0.3, acknowledged: true });
    assert.strictEqual(detectors.spl.owner.id, winner, `${JSON.stringify(a)} against ${JSON.stringify(b)}`);
    const sorted = [...ranks].sort(voiceOrder);
    assert.strictEqual(sorted[0].id, winner);
  }
});

test('a pulsed tail never outlives its voice or leaks onto a lamp it does not cover', () => {
  const trueStrobe = spec({ kind: 'ldj.TrueStrobe', palette: ['#FFFFFF'], params: { iterations: 2 } });
  const kill = preset('energy.kill');
  // On the lamp until 120 ms: a flash at 0, its pulse falling, then the base (black) again.
  const r = rig();
  const at = (ms, v) => r.at(ms, { pattern: 'look', effect: kill, voices: [v], hueStrobe: 'pulse', ...SAFETY() }, { grid: 0 })[LAMP.id].dim;
  const v = voice('pad', trueStrobe, { targets: [LAMP.id], untilMs: 120 });
  assert.strictEqual(at(0, v), 255);
  assert.strictEqual(at(100, v), 148, 'the pulse, after the flash went off at 50 ms');
  assert.strictEqual(at(120, v), 0, 'the voice has ended: no tail');
  // Covering the par only, the lamp never shows its tail.
  const s = rig();
  const parOnly = voice('pad', trueStrobe, { targets: [PAR.id] });
  for (const ms of [0, 50, 100, 200]) {
    const out = s.at(ms, { pattern: 'look', effect: kill, voices: [parOnly], hueStrobe: 'pulse', ...SAFETY() }, { grid: 0 });
    assert.strictEqual(out[LAMP.id].dim, 0, `the lamp at ${ms} ms`);
  }
});

test('voices of every engine play on through a jump in the music: wall-clock tails continue, musical schedules start again from the new beat', () => {
  const read = (out) => PARS.map((f) => [out[f.id].dim, out[f.id].r, out[f.id].g, out[f.id].b]);
  for (const id of ['ldj.StudioN2', 'ldj.GrooveWave', 'ldj.visualizer.swirl', 'ldj.House', 'ldj.FadeCycle', 'ldj.SceneMakerFirework']) {
    const v = voice('pad', preset(id), { launchSeq: 1, startedAtMs: 0, anchorBeat: 0 });
    const r = rig(PARS);
    const frames = [];
    // Two seconds at beat 0.., then a seek to beat 40.3 (a new epoch), then two seconds more.
    for (let k = 0; k <= 176; k++) {
      const ms = k * FRAME_MS;
      const jumped = k > 88;
      const beatPos = jumped ? 40.3 + (ms - 88 * FRAME_MS) / 500 : ms / 500;
      const out = r.at(ms, { voices: [v], ...SAFETY() }, { beatPos, epoch: jumped ? 2 : 1, grid: 0 });
      frames.push(read(out));
    }
    for (const [k, f] of frames.entries()) for (const lamp of f) assert.ok(lamp.every(Number.isFinite), `${id} frame ${k}: ${lamp}`);
    // A single Studio note has ended by then (two beats); everything else goes on.
    if (id !== 'ldj.StudioN2') assert.ok(new Set(frames.slice(90).map((f) => JSON.stringify(f))).size > 1, `${id} keeps playing after the jump`);
  }
  // A Studio note is a wall-clock fade: across the jump it goes on falling, it is not launched again.
  const r = rig([PAR]);
  const note = voice('pad', spec({ kind: 'ldj.StudioN2', palette: ['#FFFFFF'] }), { startedAtMs: 0 });
  const dims = [];
  for (let k = 0; k <= 60; k++) {
    const jumped = k > 30;
    dims.push(r.at(k * FRAME_MS, { voices: [note], ...SAFETY() }, { beatPos: jumped ? 40 + k * 0.045 : k * 0.045, epoch: jumped ? 2 : 1, grid: 0 })[PAR.id].dim);
  }
  for (let k = 1; k < dims.length; k++) assert.ok(dims[k] <= dims[k - 1], `the note only falls: frame ${k} ${dims[k - 1]} → ${dims[k]}`);
  assert.ok(dims[30] > dims[60] && dims[31] < 255, 'mid-fade at the jump, and no new note at it');
});
