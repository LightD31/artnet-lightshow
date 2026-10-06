// tests/unit/room.test.js
import test from 'node:test';
import assert from 'node:assert';
import { buildRoom, roomOf } from '../../src/shared/room.ts';
import { rigSignature } from '../../src/shared/rig.ts';

// A square room: front-left, front-right, back-right, back-left. The plot's y grows downward:
// 0 is the top (the stage, the TV — Hue's front), 1 the bottom (the audience — Hue's back).
const square = () => buildRoom(4, (i) => [0, 1, 1, 0][i], (i) => [0, 0, 1, 1][i], () => 0.5, null);

test('u, v, z are −1..1 in Hue\'s frame and X, Y, Z are 0..1', () => {
  const r = square();
  assert.deepStrictEqual(r.u, [-1, 1, 1, -1]);
  assert.deepStrictEqual(r.v, [1, 1, -1, -1], 'the plot top is the front, +1');
  assert.deepStrictEqual(r.z, [0, 0, 0, 0]);
  assert.deepStrictEqual(r.X, [0, 1, 1, 0]);
  assert.deepStrictEqual(r.Y, [1, 1, 0, 0]);
  assert.deepStrictEqual(r.Z, [0.5, 0.5, 0.5, 0.5]);
});

test('x, y are far-normalised with the same signs', () => {
  // A 2:1 rectangle: u and v span −1..1 on both axes, x/y keep the shape (far corner at 1).
  const r = buildRoom(4, (i) => [0, 1, 1, 0][i], (i) => [0, 0, 0.5, 0.5][i], () => 0.5, null);
  assert.deepStrictEqual(r.u, [-1, 1, 1, -1]);
  assert.deepStrictEqual(r.v, [1, 1, -1, -1]);
  const far = Math.hypot(0.5, 0.25);
  assert.ok(Math.abs(r.x[1] - 0.5 / far) < 1e-12);
  assert.ok(Math.abs(r.y[1] - 0.25 / far) < 1e-12);
});

test('the ring runs clockwise from the front in whole degrees', () => {
  const r = square();
  // Front-right is 45° clockwise from +v, back-right 135°, back-left 225°, front-left 315°.
  assert.deepStrictEqual(r.ringDegrees, [315, 45, 135, 225]);
  assert.deepStrictEqual(r.ring, [3, 0, 1, 2]);
  for (const d of r.ringDegrees) assert.strictEqual(d, Math.trunc(d));
});

test('halves follow Light DJ\'s channel index order; channels(4) are the corners', () => {
  const r = square();
  assert.deepStrictEqual(r.halves('depth'), [1, 1, 0, 0], 'index 1 is the front');
  assert.deepStrictEqual(r.halves('width'), [0, 1, 1, 0]);
  assert.deepStrictEqual([...r.channels(4)].sort(), [0, 1, 2, 3]);
});

test('along(0) rises towards the front; along(90) towards the right', () => {
  const r = square();
  assert.ok(r.along(0)[0] > r.along(0)[3] && r.along(0)[1] > r.along(0)[2]);
  assert.ok(r.along(90)[1] > r.along(90)[0]);
});

test('hdProject at 0° orders by X and at 90° by Z', () => {
  const r = buildRoom(2, (i) => [0, 1][i], () => 0.5, (i) => [1, 0][i], null);
  assert.ok(r.hdProject(0)[0] < r.hdProject(0)[1]);
  assert.ok(r.hdProject(90)[0] > r.hdProject(90)[1]);
});

test('a flat row has no spread and rings along the row', () => {
  const r = buildRoom(3, (i) => i / 2, () => 0.5, () => 0.5, null);
  assert.strictEqual(r.spread, false);
  assert.deepStrictEqual(r.ring, [0, 1, 2]);
  assert.deepStrictEqual(r.v, [0, 0, 0]);
});

test('one lamp: every array has one finite entry', () => {
  const r = buildRoom(1, () => 0.3, () => 0.7, () => 0.5, null, [true]);
  for (const key of ['u', 'v', 'z', 'x', 'y', 'dist', 'turn', 'ring', 'ringDegrees']) assert.ok(Number.isFinite(r[key][0]), key);
  assert.deepStrictEqual(r.channels(4), [0]);
  assert.deepStrictEqual(r.hue, [true]);
});

test('a fixture height changes the rig signature', () => {
  const fix = { profileId: 'p', position: { x: 10, y: 10 }, group: null, geometry: null };
  assert.notStrictEqual(rigSignature([fix]), rigSignature([{ ...fix, position: { x: 10, y: 10, height: 80 } }]));
});

// The renderer's effect layers and a party look read one plan with Hue flags
// of their own; a room rebuilt every frame would also lose what is kept with
// it (Light DJ's channel assignment).
test('a plan read with two sets of Hue flags keeps one room for each, frame after frame', () => {
  const plan = { x: [0.1, 0.4, 0.7, 0.9], y: [0.2, 0.2, 0.6, 0.6], z: [0.5, 0.5, 0.5, 0.5], group: [null, null, null, null] };
  const look = [false, false, false, true];
  const effects = [false, false, false, true];
  const first = roomOf({ fixtureCount: 4, plan, xs: null, ys: null, noFlash: look });
  const other = roomOf({ fixtureCount: 4, plan, xs: null, ys: null, noFlash: effects });
  for (let frame = 0; frame < 3; frame++) {
    assert.strictEqual(roomOf({ fixtureCount: 4, plan, xs: null, ys: null, noFlash: look }), first, `the look's room, frame ${frame}`);
    assert.strictEqual(roomOf({ fixtureCount: 4, plan, xs: null, ys: null, noFlash: effects }), other, `the effects' room, frame ${frame}`);
  }
  assert.deepStrictEqual(other.hue, first.hue);
  // Without a plan the slots' places are the key, the same way.
  const xs = [0, 0.3, 0.6, 1];
  const a = roomOf({ fixtureCount: 4, plan: null, xs, ys: null, noFlash: look });
  const b = roomOf({ fixtureCount: 4, plan: null, xs, ys: null, noFlash: effects });
  assert.strictEqual(roomOf({ fixtureCount: 4, plan: null, xs, ys: null, noFlash: look }), a);
  assert.strictEqual(roomOf({ fixtureCount: 4, plan: null, xs, ys: null, noFlash: effects }), b);
});
