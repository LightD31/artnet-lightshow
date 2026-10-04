import test from 'node:test';
import assert from 'node:assert/strict';
import { LDJ_CHANNEL_ROWS } from '../../src/shared/effects/ldj-channel.ts';
import { ldjChannels } from '../../src/shared/effects/ldj-engine.ts';
import { seedFrom } from '../../src/shared/effects/hash.ts';
import { parseHex, toHex } from '../../src/shared/effects/palette.ts';
import { harness, row, square, RED, CYAN } from '../helpers/ldj-harness.js';

// A score probe records which independent colours a row reads and queues.
// Envelope and fixed-colour scores are covered by the real-renderer suite.
function score(name, iter, n = 4) {
  const room = square(), reads = [], pending = [], sets = [];
  const ctx = { n, room, iter, bpm: 120, seed: seedFrom('keyed'), pal: [RED, CYAN], p: CYAN, s: RED,
    state: { scratch: {}, recent: [], lastPick: null }, channelOf: ldjChannels(room, 4),
    colour(index, key = index) { reads.push([index, key]); return index % 2 ? CYAN : RED; },
    refresh(key) { pending.push(key); }, reroll() { pending.push('whole'); },
    lamps: { set(...args) { sets.push(args); }, off() {} },
  };
  LDJ_CHANNEL_ROWS[name].step(ctx);
  return { reads, pending, sets, state: ctx.state };
}

test('channel scores queue exact selective keys and preserve ordered refresh counts', () => {
  for (const [name, iter, expected] of [
    ['StrobeCycle', 0, [0, 1]], ['DoSiDo', 1, [0, 1]], ['GrowCycle', 0, [0]], ['GrowCycle', 1, []],
    ['Sketch', 0, [0]], ['Sketch', 1, []], ['SoftStrobe', 0, []], ['SoftStrobe', 3, [0, 1, 2]],
    ['FillCycle', 0, [0]], ['FillCycle', 4, [4]], ['CrossFade', 0, [1]], ['CrossFade', 1, [0]],
    ['Blur', 0, []], ['Blur', 1, [0, 3]], ['Blur', 3, [1, 2]],
    ['DoubleFill', 0, [0]], ['DoubleFill', 4, [1]], ['FrontBack', 4, [0]], ['FrontBack', 12, [1]],
    ['Split', 0, [0, 1]], ['Flip', 0, [0, 1]], ['RotatingHalfs', 0, [0, 1]], ['DoubleDrip', 0, [0, 1]],
    ['TwoCorners', 0, [0, 1]], ['QuickFlash', 0, [0, 1]], ['FadeCycle', 0, [0, 1, 2, 3]],
    ['Glow', 0, [0, 1, 2, 3]], ['Drip', 0, [0, 1, 2, 3]], ['Trance', 0, [0, 1, 2, 3]],
    ['TriPulse', 0, [0, 1, 2, 3]], ['TriPulse', 4, []], ['BeatPulse1', 0, [0]],
    ['BeatPulse4', 0, [0]], ['SMStudioN5Fill', 0, [0]], ['MatrixSolid', 0, []], ['America', 0, []],
  ]) assert.deepEqual(score(name, iter).pending, expected, `${name} ${iter}`);
});

test('channel cache identity is independent of primary and secondary palette roles', () => {
  assert.deepEqual(score('StrobeCycle', 0).reads.slice(0, 2), [[1, 0], [0, 1]]);
  assert.deepEqual(score('DoSiDo', 0).reads.slice(0, 2), [[0, 0], [1, 1]]);
  assert.deepEqual(score('Blur', 0).reads, [[0, 0], [1, 1], [0, 2], [1, 3]]);
  assert.deepEqual(score('SoftStrobe', 0).reads.map((r) => r[1]).sort(), [0, 1, 2, 3]);
  for (const name of ['Cauldron', 'SceneMakerFirework']) {
    const probe = score(name, 0, 8), pick = probe.state.lastPick;
    assert.deepEqual(probe.pending, [pick]);
    assert.equal(probe.reads[0][1], pick);
  }
});

test('four random Blur wells and selective CrossFade endpoints survive pending-state cloning', () => {
  const spec = { palette: [{ random: true }, { random: true }] };
  const blur = harness('ldj.Blur', square(), { spec });
  blur.draw(0);
  assert.equal(new Set(blur.state().scratch.blurWells.map(toHex)).size, 4);
  blur.draw(4);
  const clone = blur.stepper.clone();
  assert.deepEqual(blur.draw(4.5, clone), blur.draw(4.5));
  assert.deepEqual(blur.draw(8, clone), blur.draw(8));
  const cross = harness('ldj.CrossFade', row(1), { spec });
  const first = cross.draw(0)[0].colour;
  const destination = { ...cross.state().scratch.crossTarget };
  cross.draw(.1);
  assert.deepEqual(cross.draw(4)[0].colour, destination);
  assert.deepEqual(cross.state().scratch.crossTarget, first);
  // An override remains literal despite the pending selective requests.
  const fixed = parseHex('#123456');
  cross.draw({ nowMs: 2100, beatPos: 4.2, paletteOverride: [fixed] });
  cross.draw({ nowMs: 4000, beatPos: 8, paletteOverride: [fixed] });
  assert.deepEqual(cross.state().scratch.crossTarget, fixed);
});
