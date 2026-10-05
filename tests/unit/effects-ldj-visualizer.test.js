import test from 'node:test';
import assert from 'node:assert/strict';
import { kindOf, requiresAcknowledgement, validateSpec } from '../../src/shared/effects/registry.ts';
import { LDJ_FRAME_MS } from '../../src/shared/effects/ldj-engine.ts';
import { advanceStudio, initStudio, readStudio } from '../../src/shared/effects/ldj-studio.ts';
import { VISUALIZER_PRESETS, blendRendered, mixSpike } from '../../src/shared/effects/ldj-visualizer.ts';
import { LDJ_PALETTES } from '../../src/shared/effects/ldj-palettes.ts';
import { hash01, pickNotLast, seedFrom } from '../../src/shared/effects/hash.ts';
import { parseHex } from '../../src/shared/effects/palette.ts';
import { harness, row, RED, CYAN } from '../helpers/ldj-harness.js';

const f32 = Math.fround, FLOOR = f32(.05), F = LDJ_FRAME_MS;
const BLACK = { r: 0, g: 0, b: 0, w: 0, a: 0, uv: 0 }, BLUE = parseHex('#0000FF');
const KEYS = ['r', 'g', 'b', 'w', 'a', 'uv'];
const at = (frame, bpm = 120) => ({ nowMs: frame * F, beatPos: frame * F * bpm / 60000, bpm });
const ms = (nowMs, bpm = 120) => ({ nowMs, beatPos: nowMs * bpm / 60000, bpm });
// A classification event as the audio features publish it: held across hops, identified by eventT.
const audio = (eventT, beat, section, { t = eventT, generation } = {}) => ({
  t, ...(generation === undefined ? {} : { generation }), rms: 0, power: 0, dominantHz: null, party: { full: 0, bass: 0, mid: 0, high: 0 },
  disco: { hit: [false, false, false], gate: [0, 0, 0], level: [0, 0, 0], peakHit: false, neural: { mainFrequency: 0, amplitude: 0 } },
  spl: { db: 0, level: 0, beat, section, ...(eventT === undefined ? {} : { eventT }) },
});
const vis = (room, params = {}, options = {}) => harness('ldj.visualizer', room, { params, seed: 'visualizer', ...options });
const hear = (h, when, a, over = {}) => h.draw({ ...when, audio: a, audioMode: 'reactive', ...over });
const slotOf = (h) => h.state().bed.ring[h.state().lastRank];
const bedOnly = (s, slot) => { const lamp = readStudio(s.bed, slot); return { colour: { ...lamp.colour }, level: lamp.bri, strength: 1 }; };
const close = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-9, `${message ?? ''} ${actual} ≠ ${expected}`);
const finite = (out) => out.every((slot) => Number.isFinite(slot.level) && KEYS.every((key) => Number.isFinite(slot.colour[key] ?? 0)));
// Light DJ's rendered-colour blend, written out independently: bytes already
// scaled by level, weighted by their brightest emitter in 32-bit floats, truncated.
const bytes = (c, level) => Object.fromEntries(KEYS.map((key) => [key, Math.min(255, Math.floor(f32(f32((c[key] ?? 0) * level) + .5)))]));
function expectedBlend(a, aLevel, b, bLevel) {
  const x = bytes(a, aLevel), y = bytes(b, bLevel);
  const wx = f32(Math.max(...KEYS.map((k) => x[k])) / 255), wy = f32(Math.max(...KEYS.map((k) => y[k])) / 255), sum = f32(wx + wy);
  return Object.fromEntries(KEYS.map((k) => [k, sum > 0 ? Math.trunc(f32(f32(f32(x[k] * wx) + f32(y[k] * wy)) / sum)) : 0]));
}

// Live audio after a launch without it: the bed starts at once and a held soft section never stops it.
function runningBed(room, params = {}, options = {}) {
  const h = vis(room, params, options);
  h.draw(at(0));
  return h;
}

test('the kind registers strict, idempotent defaults, needs the acknowledgement and has seven presets', () => {
  const kind = kindOf('ldj.visualizer');
  assert.ok(kind?.stateful && kind.command);
  const spec = validateSpec({ kind: 'ldj.visualizer' });
  assert.deepEqual(spec.params, { active: 'firework', mellow: 'swirl', trigger: .3, autoColours: false });
  assert.deepEqual(validateSpec(spec), spec);
  assert.equal(requiresAcknowledgement(spec), true, 'spikes on every loud beat are rapid flashes');
  for (const params of [{ active: 'none' }, { mellow: 'fire' }, { trigger: 1.5 }, { trigger: -.1 }, { autoColours: 'yes' }, { extra: 1 }]) {
    assert.throws(() => validateSpec({ kind: 'ldj.visualizer', params }), JSON.stringify(params));
  }
  assert.deepEqual(VISUALIZER_PRESETS.map((p) => [p.id, p.params.active, p.params.mellow]), [
    ['ldj.visualizer.firework', 'firework', 'swirl'], ['ldj.visualizer.flash', 'flash', 'swirl'],
    ['ldj.visualizer.splotch', 'splotch', 'swirl'], ['ldj.visualizer.pulse', 'pulse', 'swirl'],
    ['ldj.visualizer.solid', 'firework', 'solid'], ['ldj.visualizer.swirl', 'firework', 'swirl'],
    ['ldj.visualizer.wave', 'firework', 'wave'],
  ]);
  for (const preset of VISUALIZER_PRESETS) {
    const presetSpec = validateSpec({ kind: 'ldj.visualizer', params: preset.params });
    assert.deepEqual(validateSpec(presetSpec), presetSpec);
    assert.deepEqual(presetSpec.params, preset.params, preset.id);
  }
  assert.notEqual(VISUALIZER_PRESETS[0].params, VISUALIZER_PRESETS[5].params, 'presets share no objects');
});

test('the 26 seeded Light DJ palettes are one frozen table, random entries kept', () => {
  assert.equal(LDJ_PALETTES.length, 26);
  assert.equal(new Set(LDJ_PALETTES.map((p) => p.id)).size, 26);
  assert.ok(LDJ_PALETTES.every((p) => p.app === 'ldj' && Object.isFrozen(p) && Object.isFrozen(p.colours)));
  assert.deepEqual(LDJ_PALETTES.find((p) => p.id === 'randomRandom').colours, [{ random: true }, { random: true }]);
  assert.equal(LDJ_PALETTES.find((p) => p.id === 'rainbow').colours.length, 8);
  assert.deepEqual(LDJ_PALETTES.find((p) => p.id === 'rocketPop').colours, ['#D60210', '#F0F1FF', '#0814FF']);
  assert.deepEqual(LDJ_PALETTES.find((p) => p.id === 'blueDream').colours, ['#0B1066', '#0A108C', '#0E4EAD', '#0E7BC9']);
  assert.equal(LDJ_PALETTES.find((p) => p.id === 'northernLights'), undefined);
  assert.deepEqual(LDJ_PALETTES.map((p) => p.colours.length).sort(), [...Array(8).fill(2), ...Array(12).fill(3), ...Array(5).fill(4), 8].sort());
  for (const p of LDJ_PALETTES) for (const c of p.colours) if (typeof c === 'string') assert.doesNotThrow(() => parseHex(c), p.id);
});

test('a loud beat fires one spike on a lamp ≠ last with a matrix envelope', () => {
  const h = vis(row(6), { active: 'flash' });
  hear(h, at(0), audio(0, null, null));
  assert.ok(h.draw({ ...at(0), audio: audio(0, null, null), audioMode: 'reactive' }).every((slot) => slot.level === 0), 'reactive audio waits for its bed');
  const picks = [];
  for (let k = 1; k <= 30; k++) {
    const out = hear(h, at(2 * k), audio(k, 'loud', null));
    const s = h.state(), slot = slotOf(h);
    picks.push(s.lastRank);
    assert.equal(s.lamps.read(slot).bri, 1, 'one fresh spike at its peak');
    assert.equal(s.lamps.read(slot).bri, 1);
    assert.equal(out.filter((lamp, i) => s.lamps.read(i).bri === 1).length, 1);
    if (k > 1) assert.notEqual(picks[k - 1], picks[k - 2], 'never the last lamp');
  }
  assert.ok(new Set(picks).size >= 4, 'the room is used');

  // Flash 0/10/100: one frame at full, quarter steps down, then the stopped bed takes the lamp back.
  const flash = vis(row(4), { active: 'flash' });
  hear(flash, at(0), audio(1, 'loud', null));
  const slot = slotOf(flash);
  for (const [frame, bri] of [[0, 1], [1, .75], [2, .5], [3, .25]]) {
    hear(flash, at(frame), audio(1, 'loud', null));
    assert.equal(flash.state().lamps.read(slot).bri, bri, `flash frame ${frame}`);
  }
  const released = hear(flash, at(4), audio(1, 'loud', null));
  assert.equal(flash.state().spikes[slot], null, 'with no bed the spike ends at its endpoint');
  assert.equal(released[slot].level, 0);

  // Pulse 0/500/0: twenty-two frames at full, then baseline.
  const pulse = vis(row(4), { active: 'pulse' });
  hear(pulse, at(0), audio(1, 'loud', null));
  const pulseSlot = slotOf(pulse);
  hear(pulse, at(21), audio(1, 'loud', null));
  assert.equal(pulse.state().lamps.read(pulseSlot).bri, 1);
  hear(pulse, at(22), audio(1, 'loud', null));
  assert.equal(pulse.state().spikes[pulseSlot], null);

  // Splotch 0/10/5000: one frame at full, then 227 frames of fall in float32 steps.
  const splotch = vis(row(4), { active: 'splotch' });
  hear(splotch, at(0), audio(1, 'loud', null));
  const splotchSlot = slotOf(splotch);
  hear(splotch, at(1), audio(1, 'loud', null));
  assert.equal(splotch.state().lamps.read(splotchSlot).bri, f32(1 - f32(1 / 227)));

  // Firework 0/150..350/2500: a seeded peak of six to fifteen frames, then 113 frames of fall.
  const holds = new Set();
  for (const seed of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) {
    const firework = vis(row(4), { active: 'firework' }, { seed });
    hear(firework, at(0), audio(1, 'loud', null));
    const fireSlot = slotOf(firework);
    let frame = 0;
    while (firework.state().lamps.read(fireSlot).bri === 1) hear(firework, at(++frame), audio(1, 'loud', null));
    // The peak is its own seeded draw, an integer 150..350 ms (stream 79 of the instance seed).
    assert.equal(frame, Math.floor((150 + Math.floor(hash01(seedFrom(seed), 79, 0) * 201)) / 22), `firework peak ${frame} frames`);
    assert.equal(firework.state().lamps.read(fireSlot).bri, f32(1 - f32(1 / 113)));
    holds.add(frame);
  }
  assert.ok(holds.size > 1, 'the peak length is drawn per spike');
  const peaks = Array.from({ length: 2000 }, (_, i) => 150 + Math.floor(hash01(seedFrom('range'), 79, i) * 201));
  assert.equal(Math.min(...peaks), 150);
  assert.equal(Math.max(...peaks), 350);
});

test('mix picks firework/pulse/flash 30/30/40 by the seed over 100 beats (±10)', () => {
  assert.deepEqual([0, .2999, .3, .5999, .6, .9999].map(mixSpike), ['firework', 'firework', 'pulse', 'pulse', 'flash', 'flash']);
  for (const seed of ['visualizer', 'mix-2', 'mix-3']) {
    const h = vis(row(12), { active: 'mix' }, { seed });
    hear(h, at(0), audio(0, null, null));
    const counts = { firework: 0, pulse: 0, flash: 0, splotch: 0 };
    for (let k = 1; k <= 100; k++) {
      hear(h, at(2 * k), audio(k, 'loud', null));
      counts[h.state().spikes[slotOf(h)].mode]++;
    }
    assert.equal(counts.splotch, 0, 'mix never plays a splotch');
    assert.ok(Math.abs(counts.firework - 30) <= 10 && Math.abs(counts.pulse - 30) <= 10 && Math.abs(counts.flash - 40) <= 10, JSON.stringify(counts));
  }
});

test('the weighted blend uses rendered bytes, 32-bit weights and truncation, on every emitter', () => {
  assert.deepEqual(blendRendered(RED, 1, BLUE, .25), { r: 203, g: 0, b: 12, w: 0, a: 0, uv: 0 });
  assert.deepEqual(blendRendered(RED, 1, BLUE, 1), { r: 127, g: 0, b: 127, w: 0, a: 0, uv: 0 });
  assert.deepEqual(blendRendered(BLACK, 1, BLACK, 1), BLACK, 'no light, no division');
  assert.deepEqual(blendRendered(BLACK, 0, RED, .5), { ...BLACK, r: 128 }, 'a dark side yields the other');
  const white = parseHex('#000000FF');
  assert.deepEqual(blendRendered(white, 1, BLACK, 0), { ...BLACK, w: 255 }, 'a white-only colour keeps its weight');
  assert.deepEqual(blendRendered(white, 1, RED, 1), { ...BLACK, r: 127, w: 127 });
});

test('the mellow swirl runs under the spikes and blends by brightness', () => {
  const h = runningBed(row(6), { active: 'firework', mellow: 'swirl' }, { palette: [RED, CYAN] });
  for (let frame = 1; frame <= 40; frame++) hear(h, at(frame), audio(0, 'soft', 'soft'));
  const s = h.state();
  assert.equal(s.mellow.running, true);
  assert.ok(s.bed.lamps.some((lamp) => lamp.bri > FLOOR), 'the swirl is up');
  const out = hear(h, at(41), audio(1, 'loud', 'soft'));
  const slot = slotOf(h), spike = s.lamps.read(slot), bed = readStudio(s.bed, slot);
  assert.equal(spike.bri, 1);
  assert.deepEqual(out[slot], { colour: expectedBlend(bed.colour, bed.bri, spike.colour, spike.bri), level: 1, strength: 1 });
  for (let i = 0; i < 6; i++) if (i !== slot) assert.deepEqual(out[i], bedOnly(s, i), 'other lamps show the bed alone');
  // The bed keeps moving underneath while the spike holds.
  const swirl = s.bed.swirl;
  const next = hear(h, at(42), audio(1, 'loud', 'soft'));
  assert.notEqual(s.bed.swirl, swirl);
  const later = readStudio(s.bed, slot);
  assert.deepEqual(next[slot].colour, expectedBlend(later.colour, later.bri, s.lamps.read(slot).colour, s.lamps.read(slot).bri));
});

test('the mellow background starts after 16 quiet beats in a quiet section and is re-sent every beat', () => {
  const h = vis(row(4), { mellow: 'swirl' });
  hear(h, at(0), audio(0, null, 'quiet'));
  for (let k = 1; k <= 15; k++) {
    const out = hear(h, at(2 * k), audio(k, 'quiet', 'quiet'));
    assert.equal(h.state().quiet, k, 'the held quiet section does not reset the count');
    assert.equal(h.state().mellow.running, false);
    assert.ok(out.every((slot) => slot.level === 0), 'dark until the bed starts');
  }
  const start = at(32);
  hear(h, start, audio(16, 'quiet', 'quiet'));
  const s = h.state();
  assert.equal(s.mellow.running, true, 'the sixteenth quiet beat starts it');
  assert.equal(s.bed.mode, 'visualizerSwirl');
  assert.equal(s.mellow.nextBeat, start.beatPos + 1);
  assert.equal(s.section, 'soft', 'the start promotes the section internally');
  // Re-sent each beat: a stop holds only until the next beat's reassertion.
  kindOf('ldj.visualizer').command(s, 'stop');
  hear(h, ms(start.nowMs + 499), audio(16, 'quiet', 'quiet'));
  assert.equal(s.bed.mode, 'stop');
  hear(h, ms(start.nowMs + 501), audio(16, 'quiet', 'quiet'));
  assert.equal(s.bed.mode, 'visualizerSwirl');
  close(s.mellow.nextBeat, start.beatPos + 2);
  hear(h, ms(start.nowMs + 1600), audio(16, 'quiet', 'quiet'));
  close(s.mellow.nextBeat, start.beatPos + 4, 'every crossed beat is replayed in order');

  // Twenty soft beats inside a soft section (not twenty-one).
  const soft = vis(row(4), { mellow: 'solid' });
  hear(soft, at(0), audio(0, null, 'soft'));
  for (let k = 1; k <= 19; k++) hear(soft, at(2 * k), audio(k, 'soft', 'soft'));
  assert.equal(soft.state().mellow.running, false);
  hear(soft, at(40), audio(20, 'soft', 'soft'));
  assert.equal(soft.state().mellow.running, true);
  assert.equal(soft.state().bed.mode, 'visualizerSolid');
  // Quiet beats in a soft section and soft beats in a quiet one count for nothing.
  const other = vis(row(4));
  hear(other, at(0), audio(0, null, 'soft'));
  for (let k = 1; k <= 30; k++) hear(other, at(2 * k), audio(k, 'quiet', 'soft'));
  assert.equal(other.state().quiet, 0);
  assert.equal(other.state().mellow.running, false);
});

test('wave is re-sent every eight beats and resets its index; swirl keeps its phase', () => {
  const h = runningBed(row(4), { mellow: 'wave' });
  const s = h.state();
  assert.equal(s.bed.mode, 'visualizerWave');
  assert.equal(s.mellow.nextBeat, 8);
  hear(h, ms(3999), null);
  assert.equal(s.bed.wave, 20 + Math.floor(3999 / F) * 4, 'four lamps step the index each frame');
  hear(h, ms(4000), null);
  assert.equal(s.mellow.nextBeat, 16);
  assert.equal(s.bed.wave, 20, 'the reassertion at beat 8 restarts the wave');
  const swirl = runningBed(row(4), { mellow: 'swirl' });
  swirl.draw(ms(499));
  const phase = swirl.state().bed.swirl;
  swirl.draw(ms(500));
  assert.equal(swirl.state().mellow.nextBeat, 2);
  assert.ok(swirl.state().bed.swirl >= phase, 'reasserting swirl keeps its phase');
});

test('a loud section stops the mellow loop', () => {
  const h = runningBed(row(4), { active: 'flash' });
  for (let k = 1; k <= 30; k++) hear(h, at(k), audio(0, 'soft', 'soft'));
  hear(h, at(31), audio(1, 'soft', 'soft'));
  assert.equal(h.state().soft, 2);
  const out = hear(h, at(32), audio(2, 'loud', 'loud'));
  const s = h.state();
  assert.equal(s.mellow.running, false);
  assert.equal(s.bed.mode, 'stop');
  assert.equal(s.soft, 0, 'a loud beat resets the soft count');
  assert.equal(out.filter((slot) => slot.level > 0).length, 4, 'the spike still fires, the bed has not ticked yet');
  const spike = slotOf(h);
  for (let k = 3; k <= 40; k++) {
    const frame = hear(h, at(30 + k), audio(k, 'loud', 'loud'));
    assert.equal(s.bed.mode, 'stop', 'no reassertion while loud');
    if (k === 3) assert.ok(frame.some((slot, i) => i !== spike && slot.level === 0));
  }
  assert.ok(s.bed.lamps.every((lamp) => lamp.bri === 0));
  // A quiet section stops a running bed too and restarts the quiet count; soft alone starts nothing.
  const q = runningBed(row(4));
  hear(q, at(1), audio(1, 'soft', 'soft'));
  hear(q, at(2), audio(2, 'quiet', 'quiet'));
  assert.equal(q.state().mellow.running, false);
  assert.equal(q.state().quiet, 1, 'the section applies before its own beat');
  hear(q, at(3), audio(3, 'soft', 'soft'));
  assert.equal(q.state().mellow.running, false);
});

test('the classification event is heard once, whatever number of hops carry it', () => {
  const h = vis(row(8), { active: 'pulse' });
  hear(h, at(0), audio(.05, null, null));
  hear(h, at(1), audio(.1, 'loud', null, { t: .1 }));
  const first = h.state().lastRank;
  for (const [frame, t] of [[2, .1116], [3, .1232], [4, .1348]]) hear(h, at(frame), audio(.1, 'loud', null, { t }));
  assert.equal(h.state().lastRank, first);
  assert.equal(h.state().events, 1, 'held hops are one event');
  hear(h, at(5), audio(.2, 'loud', null, { t: .2 }));
  assert.equal(h.state().events, 2, 'the next event of the same class is news');
  hear(h, at(6), audio(.2, 'loud', null, { t: .2, generation: 1 }));
  assert.equal(h.state().events, 3, 'a restarted stream is news');
  hear(h, at(7), audio(.05, 'loud', null, { generation: 1 }));
  assert.equal(h.state().events, 4, 'a lower time after a restart is not frozen out');
  // Without eventT the hop time identifies the event, as older producers send it.
  const legacy = vis(row(8), { active: 'pulse' });
  for (const frame of [0, 1, 2]) hear(legacy, at(frame), audio(undefined, 'loud', null, { t: 7 }));
  assert.equal(legacy.state().events, 1);
  // Tempo and off modes hear the event but never act on it, so switching back adds nothing.
  const modes = vis(row(8), { active: 'pulse' });
  hear(modes, at(0), audio(1, 'loud', null), { audioMode: 'tempo' });
  hear(modes, at(1), audio(1, 'loud', null), { audioMode: 'off' });
  hear(modes, at(2), audio(1, 'loud', null));
  assert.equal(modes.state().events, 0);
});

test('a spike between lamp frames waits for the next one', () => {
  const h = vis(row(4), { active: 'flash' });
  hear(h, at(0), audio(0, null, null));
  hear(h, ms(F + 10), audio(1, 'loud', null));
  const s = h.state(), slot = s.bed.ring[s.lastRank];
  assert.equal(s.spikes[slot], null);
  assert.equal(s.lamps.read(slot).bri, 0);
  hear(h, at(2), audio(1, 'loud', null));
  assert.equal(s.lamps.read(slot).bri, 1, 'the full frame of peak, from the boundary');
  hear(h, at(3), audio(1, 'loud', null));
  assert.equal(s.lamps.read(slot).bri, .75);
});

test('a spike hands its lamp back to the bed: pulse at once, the others over 22 frames', () => {
  const h = runningBed(row(4), { active: 'flash' }, { palette: [RED, CYAN] });
  for (let frame = 1; frame <= 30; frame++) hear(h, at(frame), audio(0, 'soft', 'soft'));
  hear(h, at(31), audio(1, 'loud', 'soft'));
  const s = h.state(), slot = slotOf(h), colour = { ...s.lamps.read(slot).colour };
  for (let frame = 32; frame <= 34; frame++) hear(h, at(frame), audio(1, 'loud', 'soft'));
  let out = hear(h, at(35), audio(1, 'loud', 'soft'));
  assert.equal(s.spikes[slot], null);
  assert.deepEqual(s.handoffs[slot], { from: colour, to: { ...readStudio(s.bed, slot).colour }, tick: 0 });
  let bed = readStudio(s.bed, slot);
  assert.deepEqual(out[slot].colour, expectedBlend(bed.colour, bed.bri, colour, FLOOR), 't0 shows the old colour at the baseline');
  const to = s.handoffs[slot].to;
  out = hear(h, at(36), audio(1, 'loud', 'soft'));
  assert.equal(s.handoffs[slot].tick, 1);
  const mixed = Object.fromEntries(KEYS.map((k) => [k, Math.round((colour[k] ?? 0) * (1 - 1 / 22) + (to[k] ?? 0) * (1 / 22))]));
  bed = readStudio(s.bed, slot);
  assert.deepEqual(out[slot].colour, expectedBlend(bed.colour, bed.bri, mixed, FLOOR));
  hear(h, at(56), audio(1, 'loud', 'soft'));
  assert.equal(s.handoffs[slot].tick, 21);
  out = hear(h, at(57), audio(1, 'loud', 'soft'));
  assert.equal(s.handoffs[slot], null, 'transparent at t22');
  assert.deepEqual(out[slot], bedOnly(s, slot));

  // Pulse leaves at its first baseline frame, with no second of residue.
  const p = runningBed(row(4), { active: 'pulse' });
  for (let frame = 1; frame <= 30; frame++) hear(p, at(frame), audio(0, 'soft', 'soft'));
  hear(p, at(31), audio(1, 'loud', 'soft'));
  const pulseSlot = slotOf(p);
  hear(p, at(52), audio(1, 'loud', 'soft'));
  assert.ok(p.state().spikes[pulseSlot]);
  out = hear(p, at(53), audio(1, 'loud', 'soft'));
  assert.equal(p.state().spikes[pulseSlot], null);
  assert.equal(p.state().handoffs[pulseSlot], null);
  assert.deepEqual(out[pulseSlot], bedOnly(p.state(), pulseSlot));

  // Mellow none hands over to black; a stopped bed takes nothing and cancels a running handoff.
  const none = runningBed(row(4), { active: 'flash', mellow: 'none' });
  hear(none, at(1), audio(1, 'loud', 'soft'));
  const noneSlot = slotOf(none);
  hear(none, at(5), audio(1, 'loud', 'soft'));
  assert.deepEqual(none.state().handoffs[noneSlot].to, BLACK);
  // Switched to none from a coloured swirl: the lamps keep their colour at zero, the handoff still goes to black.
  const dimmed = runningBed(row(4), { active: 'flash', mellow: 'swirl' }, { palette: [RED] });
  for (let frame = 1; frame <= 20; frame++) hear(dimmed, at(frame), audio(0, 'soft', 'soft'));
  dimmed.inst.spec = validateSpec({ ...dimmed.inst.spec, params: { ...dimmed.inst.spec.params, mellow: 'none' } });
  hear(dimmed, at(23), audio(0, 'soft', 'soft'));
  assert.equal(dimmed.state().bed.mode, 'none');
  hear(dimmed, at(24), audio(1, 'loud', 'soft'));
  const dimSlot = slotOf(dimmed);
  hear(dimmed, at(28), audio(1, 'loud', 'soft'));
  assert.deepEqual(readStudio(dimmed.state().bed, dimSlot).colour, RED);
  assert.deepEqual(dimmed.state().handoffs[dimSlot].to, BLACK);
  assert.ok(none.draw({ ...at(30), audio: audio(1, 'loud', 'soft'), audioMode: 'reactive' }).every((lamp) => lamp.level === 0 || lamp.colour.r + lamp.colour.g + lamp.colour.b === 0));
  const stopped = runningBed(row(4), { active: 'flash' });
  for (let frame = 1; frame <= 10; frame++) hear(stopped, at(frame), audio(0, 'soft', 'soft'));
  hear(stopped, at(11), audio(1, 'loud', 'soft'));
  const stoppedSlot = slotOf(stopped);
  hear(stopped, at(15), audio(1, 'loud', 'soft'));
  assert.ok(stopped.state().handoffs[stoppedSlot]);
  const byCommand = stopped.stepper.clone();
  kindOf('ldj.visualizer').command(byCommand.get('ldj.visualizer', () => null, 0), 'stop');
  assert.ok(byCommand.get('ldj.visualizer', () => null, 0).handoffs.every((handoff) => handoff === null), 'a stop command cancels them too');
  hear(stopped, at(16), audio(2, 'soft', 'loud'));
  assert.ok(stopped.state().handoffs.every((handoff) => handoff === null), 'stopping cancels handoffs');
  hear(stopped, at(17), audio(3, 'loud', 'loud'));
  const last = slotOf(stopped);
  hear(stopped, at(21), audio(3, 'loud', 'loud'));
  assert.equal(stopped.state().spikes[last], null);
  assert.equal(stopped.state().handoffs[last], null, 'a stopped bed releases at the endpoint');
});

test('a random spike colour follows its lamp cache until the endpoint, then stays captured', () => {
  const h = runningBed(row(4), { active: 'flash' }, { spec: { palette: [{ random: true }] } });
  hear(h, at(1), audio(0, 'soft', 'soft'));
  hear(h, at(2), audio(1, 'loud', 'soft'));
  const s = h.state(), slot = slotOf(h), launched = { ...s.lamps.read(slot).colour };
  hear(h, at(3), audio(1, 'loud', 'soft'));
  assert.notDeepEqual({ ...s.lamps.read(slot).colour }, launched, 'the queued refresh shows on the next render');
  hear(h, at(6), audio(1, 'loud', 'soft'));
  const from = { ...s.handoffs[slot].from };
  hear(h, at(7), audio(2, 'loud', 'soft'));
  hear(h, at(8), audio(2, 'loud', 'soft'));
  assert.deepEqual(s.handoffs[slot]?.from ?? from, from, 'a handoff keeps plain colours');
  // Spikes redraw their own lamp's colour, never the background's: it keeps its draw on every lamp they hit.
  const bed = { ...s.bed.backgroundColour }, hit = new Set();
  for (let k = 3; k <= 40; k++) {
    hear(h, at(6 + k), audio(k, 'loud', 'soft'));
    hit.add(slotOf(h));
    hear(h, at(6 + k), audio(k, 'loud', 'soft'));
    assert.deepEqual({ ...s.bed.backgroundColour }, bed);
  }
  assert.equal(hit.size, 4, 'every lamp key, the bed palette index included, was refreshed');
});

test('studio commands act on the running instance', () => {
  const h = runningBed(row(4), { active: 'pulse', mellow: 'swirl' });
  for (let frame = 1; frame <= 22; frame++) hear(h, at(frame), audio(0, 'soft', 'soft'));
  // Beat 2 was reasserted at 1000 ms; the stop lands between beats.
  hear(h, at(23), audio(1, 'loud', 'soft'));
  const s = h.state(), command = kindOf('ldj.visualizer').command, spike = slotOf(h);
  command(s, 'stop');
  const out = hear(h, at(24), audio(1, 'loud', 'soft'));
  assert.equal(s.bed.mode, 'stop');
  assert.ok(s.bed.lamps.every((lamp) => lamp.bri === 0), 'the bed goes dark');
  assert.equal(s.lamps.read(spike).bri, 1, 'the spike envelope is not cut');
  assert.ok(out[spike].level > 0);
  hear(h, ms(1499), audio(1, 'loud', 'soft'));
  assert.equal(s.bed.mode, 'stop', 'ordinary rendering never undoes the command');
  hear(h, ms(1501), audio(1, 'loud', 'soft'));
  assert.equal(s.bed.mode, 'visualizerSwirl', 'the next scheduled reassertion supersedes the stop');
  assert.ok(s.spikes[spike], 'and the spike still runs');
  command(s, 'toggleDirection');
  assert.equal(s.bed.forward, true);
  const before = structuredClone(s.bed);
  command(s, 'comboBreak');
  assert.deepEqual(s.bed, before);
  command(s, 'fadeToBaseline', CYAN);
  assert.equal(s.bed.mode, 'fade');
  assert.deepEqual(s.bed.baselineColour, CYAN);
  command(s, 'setPulserBaselineColor', RED);
  hear(h, ms(1550), audio(1, 'loud', 'soft'));
  assert.deepEqual(s.bed.baselineColour, RED);
});

test('no audio frame: the mellow background alone', () => {
  for (const mellow of ['swirl', 'wave', 'solid', 'none']) {
    for (const over of [{}, { audioMode: 'reactive' }, { audioMode: 'off', audio: audio(1, 'loud', 'loud') }]) {
      const h = vis(row(4), { mellow, active: 'flash' });
      let out;
      for (let frame = 0; frame <= 60; frame++) out = h.draw({ ...at(frame), ...over });
      assert.ok(finite(out));
      assert.ok(h.state().spikes.every((spike) => spike === null), 'no invented spikes');
      if (mellow === 'none') assert.ok(out.every((slot) => slot.level === 0), 'none is no bed');
      else assert.ok(out.some((slot) => slot.level > .1), `${mellow} is visible`);
    }
  }
  // Audio dropping out after a loud section restarts the bed once, then it runs on its beats.
  const h = runningBed(row(4));
  hear(h, at(1), audio(1, 'loud', 'loud'));
  assert.equal(h.state().mellow.running, false);
  const gone = at(2);
  h.draw({ ...gone, audioMode: 'reactive' });
  assert.equal(h.state().mellow.running, true);
  assert.equal(h.state().mellow.nextBeat, gone.beatPos + 1);
  h.draw({ ...at(3), audioMode: 'reactive' });
  assert.equal(h.state().mellow.nextBeat, gone.beatPos + 1, 'not restarted on every render');
  // Back to live audio: the held loud section is news again and stops the bed.
  hear(h, at(4), audio(1, 'loud', 'loud'));
  assert.equal(h.state().mellow.running, true, 'the same event is not heard twice');
  hear(h, at(5), audio(2, 'soft', 'loud'));
  assert.equal(h.state().mellow.running, false);
});

test('automatic colours: 7.5 s apart, forced every 20 s, loud from many colours and soft as one', () => {
  const h = vis(row(4), { autoColours: true });
  hear(h, ms(0), audio(0, null, 'soft'));
  hear(h, ms(100), audio(1, 'soft', 'loud'));
  assert.equal(h.state().auto.palette, null, 'too soon after launch');
  hear(h, ms(7499), audio(2, 'soft', 'soft'));
  assert.equal(h.state().auto.palette, null, '7499 ms is too soon');
  hear(h, ms(7499.5), audio(3, 'soft', 'loud'));
  hear(h, ms(7500), audio(4, 'soft', 'soft'));
  const s = h.state();
  assert.equal(s.auto.palette.length, 1, 'soft is one colour');
  assert.equal(s.auto.forceAtMs, 27500);
  hear(h, ms(14999), audio(5, 'soft', 'loud'));
  assert.equal(s.auto.draws, 1);
  hear(h, ms(15000), audio(6, 'soft', 'soft'));
  assert.equal(s.auto.draws, 2);
  hear(h, ms(22500), audio(7, 'soft', 'loud'));
  assert.equal(s.auto.draws, 3);
  assert.ok(s.auto.palette.length > 2, 'loud draws a palette of more than two colours');

  // Forced changes need no audio, follow the section, and replay in order across a gap.
  const f = vis(row(4), { autoColours: true });
  f.draw(ms(0));
  f.draw(ms(19999));
  assert.equal(f.state().auto.draws, 0);
  f.draw(ms(20000));
  assert.equal(f.state().auto.draws, 1);
  assert.equal(f.state().auto.palette.length, 1, 'outside a loud section the forced change is soft');
  f.draw(ms(85000));
  assert.equal(f.state().auto.draws, 4);
  assert.equal(f.state().auto.forceAtMs, 100000);
  // One change per instant: the forced change at 20 s and a loud section then are not two.
  const same = vis(row(4), { autoColours: true });
  hear(same, ms(0), audio(0, null, 'soft'));
  hear(same, ms(20000), audio(1, 'loud', 'loud'));
  assert.equal(same.state().auto.draws, 1);
  // Loud and soft remember their last pick apart; neither repeats itself.
  const seen = vis(row(4), { autoColours: true });
  hear(seen, ms(0), audio(0, null, 'soft'));
  const louds = [];
  for (let k = 1; k <= 12; k++) {
    hear(seen, ms(k * 7500), audio(k, 'soft', k % 2 ? 'loud' : 'soft'));
    if (k % 2) louds.push(JSON.stringify(seen.state().auto.palette));
  }
  for (let i = 1; i < louds.length; i++) assert.notEqual(louds[i], louds[i - 1]);
});

test('automatic colours stand under an override and give way to an edited palette or switching off', () => {
  const h = runningBed(row(4), { autoColours: true, mellow: 'solid' });
  h.draw(ms(20000));
  const s = h.state();
  assert.equal(s.auto.palette.length, 1);
  h.draw({ ...ms(21000), paletteOverride: [BLUE] });
  const masked = h.draw({ ...ms(22100), paletteOverride: [BLUE] });
  assert.ok(masked.every((slot) => slot.colour.r === 0 && slot.colour.g === 0 && slot.colour.b === 255), 'the override shows');
  const unmasked = h.draw(ms(23200));
  assert.deepEqual(unmasked[0].colour, { ...BLACK, ...readStudio(s.bed, 0).colour });
  assert.notDeepEqual(unmasked[0].colour, masked[0].colour, 'removing the override shows the automatic colour again');
  h.draw({ ...ms(40000), paletteOverride: [BLUE] });
  assert.equal(s.auto.draws, 2, 'timers run on under the override');
  h.inst.spec = validateSpec({ ...h.inst.spec, palette: ['#00FF00'] });
  h.draw(ms(40100));
  assert.equal(s.auto.palette, null, 'an edited palette clears the automatic one');
  h.draw(ms(60000));
  assert.equal(s.auto.draws, 3);
  h.inst.spec = validateSpec({ ...h.inst.spec, params: { ...h.inst.spec.params, autoColours: false } });
  h.draw(ms(60100));
  assert.equal(s.auto.palette, null);
  assert.equal(s.auto.forceAtMs, null);
  h.inst.spec = validateSpec({ ...h.inst.spec, params: { ...h.inst.spec.params, autoColours: true } });
  h.draw(ms(70000));
  assert.equal(s.auto.forceAtMs, 90000, 'switching on starts a fresh 20 s');
});

test('the bed keeps one drawn colour until its mode or list changes; solid takes the first', () => {
  const palette = ['#FF0000', '#00FF00', '#0000FF', '#FFFF00'].map(parseHex);
  const h = runningBed(row(4), { mellow: 'swirl' }, { palette });
  const s = h.state(), chosen = { ...s.bed.backgroundColour };
  for (let beat = 1; beat <= 6; beat++) h.draw(ms(beat * 500));
  assert.deepEqual(s.bed.backgroundColour, chosen);
  h.inst.spec = validateSpec({ ...h.inst.spec, params: { ...h.inst.spec.params, mellow: 'solid' } });
  h.draw(ms(3500));
  assert.deepEqual(s.bed.baselineColour, palette[0]);
});

test('one lamp, one colour and empty rooms render every active and mellow pair', () => {
  for (const active of ['splotch', 'firework', 'pulse', 'flash', 'mix']) {
    for (const mellow of ['swirl', 'wave', 'solid', 'none']) {
      for (const n of [0, 1]) {
        const h = vis(row(n), { active, mellow }, { palette: [RED] });
        for (let k = 0; k <= 40; k++) {
          const out = hear(h, at(k), audio(k, k % 3 ? 'loud' : 'quiet', k < 20 ? 'quiet' : 'loud'));
          assert.equal(out.length, n);
          assert.ok(finite(out), `${active}/${mellow}/${n}`);
        }
        if (n === 1) assert.equal(h.state().lastRank, 0, 'one lamp is picked every time');
      }
    }
  }
});

test('a cloned instance continues identically, mid handoff and with queued spikes', () => {
  const h = runningBed(row(6), { active: 'mix', autoColours: true }, { spec: { palette: [{ random: true }, '#00FF00'] } });
  for (let frame = 1; frame <= 40; frame++) hear(h, at(frame), audio(frame >> 1, frame % 4 ? 'soft' : 'loud', 'soft'));
  hear(h, ms(41 * F + 7), audio(30, 'loud', 'soft'));
  assert.equal(h.state().queue.length, 1);
  assert.ok(h.state().handoffs.some(Boolean) || h.state().spikes.some(Boolean));
  const copy = h.stepper.clone();
  const when = (frame) => ({ ...at(frame), audio: audio(30 + (frame >> 2), frame % 3 ? 'loud' : 'soft', 'soft'), audioMode: 'reactive' });
  const a = [], b = [];
  for (let frame = 42; frame <= 90; frame++) a.push(h.draw(when(frame)));
  for (let frame = 42; frame <= 90; frame++) b.push(h.draw(when(frame), copy));
  assert.deepEqual(b, a);
});

test('the Studio bed steps a per-frame hook on its own clock', () => {
  const s = initStudio(row(2), seedFrom('hook'), RED, 0);
  const frames = [];
  advanceStudio(s, 3.5 * F, 120, undefined, () => frames.push(s.frame));
  assert.deepEqual(frames, [1, 2, 3]);
  assert.equal(pickNotLast(seedFrom('hook'), 3, 5, null), pickNotLast(seedFrom('hook'), 3, 5, null, 7), 'the default stream is unchanged');
  for (let i = 0; i < 100; i++) assert.notEqual(pickNotLast(seedFrom('hook'), i, 5, 2, 91), 2);
});
