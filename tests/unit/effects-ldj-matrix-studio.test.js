import test from 'node:test';
import assert from 'node:assert/strict';
import { kindOf, requiresAcknowledgement, validateSpec } from '../../src/shared/effects/registry.ts';
import { LDJ_FRAME_MS, ldjChannels } from '../../src/shared/effects/ldj-engine.ts';
import { matrixInterval } from '../../src/shared/effects/ldj-matrix.ts';
import { initStudio, advanceStudio, readStudio, triggerStudioNote, configureBackground, studioCommand,
  studioSwirlLevel, studioWaveLevel } from '../../src/shared/effects/ldj-studio.ts';
import { seedFrom } from '../../src/shared/effects/hash.ts';
import { parseHex, createPaletteAccess, preparePalette } from '../../src/shared/effects/palette.ts';
import { harness, square, row, RED, CYAN } from '../helpers/ldj-harness.js';

const f32 = Math.fround, FLOOR = f32(.05);
const at = (frame, bpm = 120) => ({ nowMs: frame * LDJ_FRAME_MS, beatPos: frame * LDJ_FRAME_MS * bpm / 60000, bpm });
const ms = (nowMs, bpm = 120) => ({ nowMs, beatPos: nowMs * bpm / 60000, bpm });
const close = (actual, expected, epsilon = 1e-7) => assert.ok(Math.abs(actual - expected) < epsilon, `${actual} != ${expected}`);
const matrix = ['PartyStrobe', 'MatrixFlash', 'MatrixFirework', 'MatrixSplotch', 'MatrixPulse'];
const studio = [...['N', 'C', '5x'].flatMap((prefix) => [1, 2, 3, 4, 5].map((n) => `Studio${prefix}${n}`)),
  'StudioSwirl', 'StudioWave', 'StudioFireworks', 'StudioFlashes'];
const state = (room = square()) => initStudio(room, seedFrom('studio'), RED, 0);
const advance = (s, frame, bpm = 120) => advanceStudio(s, frame * LDJ_FRAME_MS, bpm);

test('all twenty-five kinds register strict, idempotent wire defaults and appropriate acknowledgement', () => {
  for (const name of [...matrix, 'matrixBoard', ...studio]) {
    const kind = kindOf(`ldj.${name}`);
    assert.ok(kind?.stateful, name);
    const spec = validateSpec({ kind: kind.kind });
    assert.deepEqual(validateSpec(spec), spec);
    assert.throws(() => validateSpec({ kind: kind.kind, params: { unsupported: true } }));
  }
  for (const name of matrix.concat('StudioFireworks', 'StudioFlashes')) assert.equal(requiresAcknowledgement(validateSpec({ kind: `ldj.${name}` })), true);
  for (const name of ['StudioN1', 'StudioSwirl']) assert.equal(requiresAcknowledgement(validateSpec({ kind: `ldj.${name}` })), false);
  for (const mode of ['fireworks', 'flashes', 'pulses', 'cycle', 'solid']) {
    assert.equal(requiresAcknowledgement(validateSpec({ kind: 'ldj.matrixBoard', params: { mode } })), !['cycle', 'solid'].includes(mode));
  }
  for (const colours of [[], Array(9).fill('#FFFFFF'), ['red']]) assert.throws(() => validateSpec({ kind: 'ldj.matrixBoard', params: { colours } }));
});

test('matrix intervals use integer quotient and twelve lamps make the flash and firework floors bind', () => {
  for (const [n, expected] of [[1, [300, 1200, 1400, 800]], [3, [123, 423, 490, 290]],
    [4, [105, 330, 380, 230]], [12, [100, 135, 150, 100]]]) {
    assert.deepEqual(['pulse', 'flash', 'firework', 'splotch'].map((mode) => matrixInterval(mode, n)), expected);
  }
});

test('matrix loops fire at launch then wall deadlines, avoiding the last n−1 selections and retaining old peaks', () => {
  const h = harness('ldj.PartyStrobe', square());
  const picks = [];
  for (let i = 0; i < 10; i++) {
    const output = h.draw(ms(i * 105, i % 2 ? 240 : 120));
    const s = h.state(); picks.push(s.lastPick);
    assert.equal(s.lastIter, i);
    assert.ok(!picks.slice(Math.max(0, i - 3), i).includes(s.lastPick));
    if (i === 2) assert.ok(output.filter((slot) => slot.level > 0).length >= 2, 'older pulse tails remain');
  }
  const h12 = harness('ldj.MatrixFlash', row(12));
  h12.draw(ms(0)); h12.draw(ms(134)); assert.equal(h12.state().lastIter, 0);
  h12.draw(ms(135)); assert.equal(h12.state().lastIter, 1);
});

test('matrix envelopes expose the prescribed peak and queued whole-frame activation', () => {
  const flash = harness('ldj.MatrixFlash', row(1));
  assert.equal(flash.draw(at(0))[0].level, 1);
  assert.equal(flash.draw(at(1))[0].level, 0);
  const splotch = harness('ldj.MatrixSplotch', row(1));
  assert.equal(splotch.draw(at(8))[0].level, 1);
  close(splotch.draw(at(9))[0].level, f32(1 - f32(1 / 68)));
  const h = harness('ldj.MatrixPulse', square());
  h.draw(ms(0)); h.draw(ms(105));
  const selected = h.state().lastPick, slot = square().ring.indexOf(selected);
  assert.equal(h.draw(ms(120))[slot].level, 0, 'new request waits for its next lamp frame');
  assert.equal(h.draw(at(3))[slot].level, 1);
  const pulse = harness('ldj.MatrixPulse', row(12));
  const firstSlot = pulse.draw(at(0)).findIndex((lamp) => lamp.level === 1);
  assert.equal(pulse.draw(at(14))[firstSlot].level, 1);
  assert.equal(pulse.draw(at(15))[firstSlot].level, 0, '350 ms literal is a fifteen-frame peak');
  const firework = harness('ldj.MatrixFirework', row(1), { seed: 'matrix-envelope' });
  assert.equal(firework.draw(at(0))[0].level, 0);
  assert.equal(firework.draw(at(1))[0].level, .5);
  assert.equal(firework.draw(at(2))[0].level, 1);
  assert.equal(firework.draw(at(9))[0].level, 1);
  assert.equal(firework.draw(at(10))[0].level, .9888888597488403, '2000 ms literal falls over ninety frames');
});

test('matrix cold replay and checkpoint cloning preserve fixed-colour output and pending notes', () => {
  for (const name of matrix) {
    const h = harness(`ldj.${name}`, square());
    for (let t = 0; t <= 900; t += 50) h.draw(ms(t));
    assert.deepEqual(h.draw(ms(1000)), harness(`ldj.${name}`, square()).draw(ms(1000)), name);
    const clone = h.stepper.clone();
    assert.deepEqual(h.draw(ms(1200), clone), h.draw(ms(1200)), name);
  }
});

test('the board uses its touched list, common palette precedence and balanced solid mapping', () => {
  const room = row(7), colours = ['#FF0000', '#00FFFF', '#FFFF00'];
  const h = harness('ldj.matrixBoard', room, { palette: [parseHex('#00FF00')], params: { mode: 'solid', colours } });
  const output = h.draw(ms(0)), mapping = ldjChannels(room, 'colours', colours.length);
  assert.deepEqual(output.map((slot) => slot.colour), mapping.map((i) => parseHex(colours[i])));
  assert.ok(h.draw({ ...ms(1), paletteOverride: [CYAN] }).every((slot) => slot.colour.g === 255));
  const explicit = harness('ldj.matrixBoard', room, { params: { colours }, spec: { palette: ['#0000FF'] } });
  assert.ok(explicit.draw(ms(0)).every((slot) => slot.colour.b === 255 && slot.colour.r === 0));
});

test('solid board edits at 0/19/20 ms accept, ignore and accept without extending the guard', () => {
  const h = harness('ldj.matrixBoard', row(1), { params: { colours: ['#FF0000'], mode: 'solid' } });
  assert.deepEqual(h.draw(ms(0))[0].colour, RED);
  h.inst.spec.params.colours = ['#00FFFF'];
  assert.deepEqual(h.draw(ms(19))[0].colour, RED);
  assert.deepEqual(h.draw(ms(20))[0].colour, CYAN);
  h.inst.spec.params.mode = 'pulses';
  assert.equal(h.draw({ ...ms(21), acknowledged: false })[0].strength, 0);
  assert.equal(h.draw(ms(22))[0].level, 1);
});

test('board cycle and pulse modes reuse their kernels and restart only on accepted list/mode changes', () => {
  for (const [mode, kind] of [['cycle', 'MatrixCycle'], ['pulses', 'MatrixPulse'], ['flashes', 'MatrixFlash'], ['fireworks', 'MatrixFirework']]) {
    const options = { seed: 'board', spec: { palette: ['#FF0000', '#00FFFF'] } };
    const board = harness('ldj.matrixBoard', square(), { ...options, params: { mode, colours: ['#FF0000', '#00FFFF'] } });
    const plain = harness(`ldj.${kind}`, square(), options);
    for (const time of [0, 100, 250, 500]) assert.deepEqual(board.draw(ms(time)), plain.draw(ms(time)), mode);
    const before = board.state().child;
    board.draw(ms(501)); assert.strictEqual(board.state().child, before);
    board.inst.spec.params.colours = ['#FFFFFF']; board.draw(ms(502));
    assert.notStrictEqual(board.state().child, before);
  }
});

test('N1 exposes launch peak, then exact float32 full-scale fade to the visible baseline', () => {
  const h = harness('ldj.StudioN1', row(1), { palette: [RED] });
  for (const [frame, expected] of [[0, 1], [1, .9090908765792847], [5, .5454543828964233],
    [10, .09090891480445862], [11, FLOOR], [40, FLOOR]]) assert.equal(h.draw(at(frame))[0].level, expected);
  assert.equal(h.state().notes, 1, 'standalone notes never retrigger at a beat boundary');
});

test('all five note durations are captured at launch while unselected lamps start at the coloured baseline', () => {
  const beats = [1, 2, 4, 6, 8];
  for (let i = 0; i < 5; i++) {
    const h = harness(`ldj.StudioN${i + 1}`, square(), { palette: [RED] });
    const first = h.draw(at(0)), selected = first.findIndex((slot) => slot.level === 1);
    assert.equal(first.filter((slot) => slot.level === FLOOR && slot.colour.r === 255).length, 3);
    assert.equal(h.draw(at(1, 240))[selected].level, f32(1 - f32(1 / f32(f32(beats[i] / 2) * 22))));
  }
});

test('N excludes floor(n/2), C retains last N without history changes, and fresh C remains bounded', () => {
  const s = state(row(3)), picks = [];
  for (let i = 0; i < 8; i++) { triggerStudioNote(s, 'N', 1, RED, 120); picks.push(s.lastChosen); }
  assert.ok(picks.slice(1).every((value, i) => value !== picks[i]));
  assert.equal(s.recent.length, 1);
  const chosen = s.lastChosen, history = [...s.recent];
  triggerStudioNote(s, 'C', 2, CYAN, 120);
  assert.equal(s.lastChosen, chosen); assert.deepEqual(s.recent, history);
  triggerStudioNote(s, '5x', 1, RED, 120); triggerStudioNote(s, 'C', 1, RED, 120);
  assert.equal(s.lastChosen, chosen);
  const fresh = state(row(1)); triggerStudioNote(fresh, 'C', 1, RED, 120);
  assert.equal(fresh.lastChosen, 0); assert.equal(readStudio(fresh, 0).bri, 1);
});

test('5x uses reverse radial order by default and ordinal ten-frame pending starts', () => {
  const room = square(), s = state(room);
  triggerStudioNote(s, '5x', 1, RED, 120);
  const order = [0, 1, 2, 3].map((rank) => room.ring.indexOf(rank));
  assert.deepEqual(s.ring, order, 'room ring values are ranks, not slot indices');
  assert.equal(readStudio(s, order[3]).bri, 1);
  assert.deepEqual(s.pending.map((p) => [p.slot, p.delay]), [[order[2], 10], [order[1], 20], [order[0], 30]]);
  advance(s, 10, 240); assert.equal(readStudio(s, order[2]).bri, FLOOR);
  advance(s, 11, 240); assert.equal(readStudio(s, order[2]).bri, .9090908765792847, 'queued duration keeps120 BPM');
  const forward = state(room); studioCommand(forward, 'toggleDirection'); triggerStudioNote(forward, '5x', 1, RED, 120);
  assert.equal(readStudio(forward, order[0]).bri, 1);
  assert.deepEqual(forward.pending.map((p) => p.slot), order.slice(1));
});

test('5x takes at most five unique lamps and direction affects only future queues', () => {
  const s = state(row(9)); triggerStudioNote(s, '5x', 1, RED, 120);
  assert.equal(new Set([s.lamps.findIndex((lamp) => lamp.bri === 1), ...s.pending.map((p) => p.slot)]).size, 5);
  const pending = structuredClone(s.pending); studioCommand(s, 'toggleDirection');
  assert.deepEqual(s.pending, pending); studioCommand(s, 'toggleDirection');
  assert.equal(s.forward, false);
});

test('Studio clone retains queued notes, independent state and pure command intents', () => {
  const h = harness('ldj.Studio5x3', square()); h.draw(at(0)); h.draw(at(5));
  const clone = h.stepper.clone();
  assert.deepEqual(h.draw(at(11), clone), h.draw(at(11)));
  const copy = clone.get(h.inst.id, () => null, 0), original = h.state();
  studioCommand(copy, 'setPulserBaselineColor', CYAN);
  assert.notDeepEqual(copy, original); assert.equal(original.pendingColour, null);
  assert.notStrictEqual(copy.pending, original.pending);
});

test('swirl and wave retain exact float arithmetic, quantized geometry and integer wave plateaus', () => {
  const angles = [0, 45, 90, 180, 270];
  angles.forEach((angle, i) => {
    close(studioSwirlLevel(angle, 0, false), [.75, .4848349392414093, .375, .75, .375][i]);
    close(studioSwirlLevel(angle, 0, true), [.44999998807907104, .18483492732048035, .07499998807907104, .44999998807907104, .07499998807907104][i]);
  });
  [20, 394, 395, 789, 790, 3159].forEach((index, i) => close(studioWaveLevel(0, 1.75, index),
    [.3343145549297333, .3343145549297333, .09999998658895493, .09999998658895493, .3343145549297333, .8999999761581421][i]));
  const h = harness('ldj.StudioSwirl', square()); h.draw(at(0)); h.draw(at(1));
  assert.equal(h.state().swirl, .4000000059604645);
});

test('background helpers preserve swirl phase, reset wave on configure, and need no audio to move', () => {
  const s = state(); configureBackground(s, 'swirl', CYAN); advance(s, 5);
  assert.ok(s.lamps.some((lamp) => lamp.bri > FLOOR)); const angle = s.swirl;
  configureBackground(s, 'swirl', CYAN); assert.equal(s.swirl, angle);
  configureBackground(s, 'wave', RED); assert.equal(s.wave, 20); advance(s, 6); assert.equal(s.wave, 24);
  configureBackground(s, 'wave', RED); assert.equal(s.wave, 20);
  configureBackground(s, 'none', RED); advance(s, 7); assert.ok(s.lamps.every((lamp) => lamp.bri === 0));
});

test('solid background brightness and RGB interpolation are independent and use real colour fractions', () => {
  const s = state(row(1)); configureBackground(s, 'solid', CYAN);
  for (const [frame, expected] of [[0, FLOOR], [1, .07000000029802322], [5, .14999999105930328], [10, .2499999701976776], [11, .25]]) {
    advance(s, frame); assert.equal(readStudio(s, 0).bri, expected);
  }
  assert.ok(readStudio(s, 0).colour.r > 0 && readStudio(s, 0).colour.g > 0, 'a real intermediate colour');
  advance(s, 23); assert.deepEqual(readStudio(s, 0).colour, CYAN);
});

test('automatic modes fire immediately and every five frames, stop preserves tails and cannot reinitialize them', () => {
  for (const [name, beats] of [['StudioFireworks', 6], ['StudioFlashes', 2]]) {
    const h = harness(`ldj.${name}`, row(12)); h.draw(at(0)); assert.equal(h.state().notes, 1);
    assert.equal(h.state().lamps.find((lamp) => lamp.note).seconds, beats / 2);
    h.draw(at(4)); assert.equal(h.state().notes, 1);
    h.draw(at(5)); assert.equal(h.state().notes, 2);
    kindOf(h.inst.spec.kind).command(h.state(), 'stop');
    assert.ok(h.draw(at(6)).some((slot) => slot.level > FLOOR));
    h.draw(at(50)); assert.equal(h.state().notes, 2);
  }
});

test('stop preserves already queued 5x notes and comboBreak is an exact no-op', () => {
  const s = state(); triggerStudioNote(s, '5x', 1, RED, 120);
  const before = structuredClone(s); studioCommand(s, 'comboBreak'); assert.deepEqual(s, before);
  studioCommand(s, 'stop'); advance(s, 11);
  assert.ok(s.lamps.some((lamp) => lamp.bri > FLOOR)); assert.equal(s.pending.length, 2);
  advance(s, 60); assert.ok(s.lamps.every((lamp) => lamp.bri === 0));
});

test('fadeToBaseline gives continuous lamps a one-beat fallback while preserving active note durations', () => {
  const s = state(row(2)); configureBackground(s, 'swirl', RED);
  advance(s, 10); studioCommand(s, 'fadeToBaseline', CYAN);
  advance(s, 21); assert.ok(s.lamps.every((lamp) => lamp.bri === FLOOR));
  assert.ok(s.lamps.every((lamp) => lamp.seconds === .5));
  const n = state(row(1)); triggerStudioNote(n, 'N', 4, RED, 120);
  advance(n, 1, 240); studioCommand(n, 'fadeToBaseline'); assert.equal(n.lamps[0].seconds, 2);
});

test('baseline colour intent is consumed next tick; note ownership holds it until explicit release', () => {
  const s = state(row(1)); triggerStudioNote(s, 'N', 1, RED, 120);
  studioCommand(s, 'setPulserBaselineColor', CYAN); assert.deepEqual(readStudio(s, 0).colour, RED);
  advance(s, 1); assert.equal(s.pendingColour, null); assert.deepEqual(s.baselineColour, CYAN);
  advance(s, 11); assert.deepEqual(readStudio(s, 0).colour, RED, 'standalone note keeps colour ownership');
  studioCommand(s, 'fadeToBaseline'); advance(s, 12);
  assert.deepEqual(readStudio(s, 0).colour, RED, 'release tick is RGB t0');
  advance(s, 13); assert.ok(readStudio(s, 0).colour.g > 0);
  const before = structuredClone(s); studioCommand(s, 'setPulserBaselineColor'); assert.deepEqual(s, before);
});

test('live Studio key-zero note colours resolve on every render', () => {
  const spec = { kind: 'ldj.StudioN5', params: {}, palette: [{ random: true }] }, seed = seedFrom('studio-colour');
  const prepared = preparePalette(spec), first = createPaletteAccess(spec, null, [RED], seed, 0, prepared);
  const s = initStudio(row(1), seed, first.colour(0, 0), 0);
  triggerStudioNote(s, 'N', 8, first.colour(0, 0), 120);
  first.refresh(0); const second = createPaletteAccess(spec, null, [RED], seed, 0, prepared);
  advanceStudio(s, LDJ_FRAME_MS, 120, second);
  assert.deepEqual(readStudio(s, 0).colour, second.colour(0, 0));
  assert.notDeepEqual(readStudio(s, 0).colour, first.palette[0]);
});

test('Studio RGB interpolation captures both endpoints across random refreshes', () => {
  const spec = { kind: 'ldj.StudioSwirl', params: {}, palette: [{ random: true }] }, seed = seedFrom('studio-blend');
  const prepared = preparePalette(spec), first = createPaletteAccess(spec, null, [RED], seed, 0, prepared);
  const target = { ...first.colour(0, 0) }, s = initStudio(row(1), seed, parseHex('#000000'), 0);
  configureBackground(s, 'solid', first.colour(0, 0));
  advanceStudio(s, LDJ_FRAME_MS, 120, first);
  first.refresh(0); const second = createPaletteAccess(spec, null, [RED], seed, 0, prepared);
  assert.notDeepEqual(second.colour(0, 0), target);
  advanceStudio(s, 2 * LDJ_FRAME_MS, 120, second);
  assert.deepEqual(readStudio(s, 0).colour, Object.fromEntries(Object.entries(target).map(([key, value]) => [key, Math.round(value / 22)])));
  advanceStudio(s, 23 * LDJ_FRAME_MS, 120, second);
  assert.deepEqual(readStudio(s, 0).colour, target, 'the original target is reached before a later transition');
  advanceStudio(s, 24 * LDJ_FRAME_MS, 120, second);
  assert.deepEqual(readStudio(s, 0).colour, target, 'a later target starts at t0');
  advanceStudio(s, 25 * LDJ_FRAME_MS, 120, second);
  assert.notDeepEqual(readStudio(s, 0).colour, target);
});

test('explicit Studio colour changes retarget the current RGB fraction without restarting it', () => {
  const blue = parseHex('#0000FF'), green = parseHex('#00FF00');
  for (const command of ['configure', 'fadeToBaseline', 'setPulserBaselineColor']) {
    const s = state(row(1)); configureBackground(s, 'solid', blue); advance(s, 6);
    assert.deepEqual(readStudio(s, 0).colour, { ...RED, r: 197, b: 58 });
    if (command === 'configure') configureBackground(s, 'solid', green);
    else studioCommand(s, command, green);
    assert.deepEqual(readStudio(s, 0).colour, { ...RED, r: 197, b: 58 }, 'commands change output on the next lamp tick');
    const clone = structuredClone(s); advance(s, 7); advance(clone, 7);
    assert.deepEqual(readStudio(s, 0).colour, { ...RED, r: 185, g: 70 }, command);
    assert.deepEqual(clone, s);
  }
  const s = state(row(1)); configureBackground(s, 'solid', blue); advance(s, 6);
  configureBackground(s, 'swirl', blue); studioCommand(s, 'setPulserBaselineColor', green);
  advance(s, 7); assert.deepEqual(readStudio(s, 0).colour, { ...RED, r: 185, g: 70 });
  advance(s, 8); assert.deepEqual(readStudio(s, 0).colour, { ...RED, r: 174, b: 81 }, 'swirl restores its own target after the one-tick override');
});

test('all Studio presets replay late first samples and clone fractional frame clocks', () => {
  for (const name of studio) {
    const dense = harness(`ldj.${name}`, square(), { startedAtMs: 200, anchorBeat: .4 });
    const cold = harness(`ldj.${name}`, square(), { startedAtMs: 200, anchorBeat: .4 });
    for (let t = 200; t < 1200; t += LDJ_FRAME_MS / 2) dense.draw(ms(t));
    assert.deepEqual(dense.draw(ms(1200)), cold.draw(ms(1200)), name);
    const clone = dense.stepper.clone();
    assert.deepEqual(dense.draw(ms(1350), clone), dense.draw(ms(1350)), name);
  }
});

test('Studio backgrounds skip note-owned lamps and the wave index wraps within a lamp frame', () => {
  const s = state(row(3)); triggerStudioNote(s, 'N', 8, RED, 120);
  configureBackground(s, 'swirl', CYAN); advance(s, 1);
  assert.equal(s.swirl, f32(f32(.1) + f32(.1)), 'only two idle lamps advance the phase');
  configureBackground(s, 'wave', CYAN); s.wave = 3159; advance(s, 2);
  assert.equal(s.wave, 1, 'two eligible lamps consume indices3159 and0');
  assert.deepEqual(readStudio(s, s.ring[s.lastChosen]).colour, RED, 'background configure does not steal note colour');
});

test('one lamp, one colour and empty rooms are finite for every matrix and Studio kind', () => {
  for (const name of [...matrix, 'matrixBoard', ...studio]) {
    for (const n of [0, 1]) {
      const h = harness(`ldj.${name}`, row(n), { palette: [RED] });
      for (const frame of [0, 1, 11, 44]) {
        const output = h.draw(at(frame)); assert.equal(output.length, n);
        for (const slot of output) assert.ok(Number.isFinite(slot.level) && Object.values(slot.colour).every(Number.isFinite), name);
      }
    }
  }
});
