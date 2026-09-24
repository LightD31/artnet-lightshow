// The 3D stage's half that has nothing to do with three.js: where each light
// of the rig hangs in the room, which way it points, how far its beam runs, and
// what colour of light a frame's emitter values make — and the live frame the
// Stage view reads out of the DMX feed, one set of emitters per light.

import test from 'node:test';
import assert from 'node:assert/strict';
// ES modules like the server, imported as they are; they read the plan
// through src/shared/stage.ts and src/shared/rig.ts.
import * as world from '../../public-src/stage3d/world.js';
import { rigLights, fixtureLight } from '../../public-src/utils.js';
import { buildRig } from '../../src/shared/rig.ts';

const PAR = { id: 'par', manufacturer: 'Test', channelMap: { dimmer: 0, red: 1, green: 2, blue: 3 } };
const HUE = { id: 'generic-hue-lamp-7ch', manufacturer: 'Philips Hue', channelMap: { dimmer: 0, red: 1, green: 2, blue: 3 } };
const BAR = {
  id: 'bar', manufacturer: 'Test', channelMap: { dimmer: 0 },
  cells: Array.from({ length: 4 }, (_, c) => ({ channelMap: { red: 1 + 3 * c, green: 2 + 3 * c, blue: 3 + 3 * c } })),
};
const PANEL = {
  id: 'panel', manufacturer: 'Test', channelMap: {},
  grid: { columns: 3, rows: 2 },
  cells: Array.from({ length: 6 }, (_, c) => ({ channelMap: { red: 3 * c, green: 3 * c + 1, blue: 3 * c + 2 }, at: { x: c % 3, y: Math.floor(c / 3) } })),
};
const PROFILES = { par: PAR, 'generic-hue-lamp-7ch': HUE, bar: BAR, panel: PANEL };

const fixture = (id, profileId, extra = {}) => ({ id, label: `F${id}`, address: 1 + id * 20, universe: 0, profileId, ...extra });
const placed = (fixtures) => {
  const rig = buildRig(fixtures, (f) => PROFILES[f.profileId] || null);
  return { rig, room: world.placeRig(fixtures, PROFILES, rig) };
};
const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-6, `${message}: ${actual} is not ${expected}`);

test('the plan is the stage from above: its corners, its centre', () => {
  assert.deepEqual(world.planToWorld({ x: 50, y: 50 }), { x: 0, z: 0 });
  assert.deepEqual(world.planToWorld({ x: 0, y: 0 }), { x: -world.STAGE_W / 2, z: -world.STAGE_D / 2 }, 'back of the stage, stage left');
  assert.deepEqual(world.planToWorld({ x: 100, y: 100 }), { x: world.STAGE_W / 2, z: world.STAGE_D / 2 }, 'the front edge, by the audience');
});

test('a par hangs on the truss, aimed down at the stage and a little towards the audience', () => {
  const { room } = placed([fixture(0, 'par', { position: { x: 25, y: 20 }, group: 'front' })]);
  assert.equal(room.lamps.length, 1);
  assert.equal(room.cells.length, 0);
  const [par] = room.lamps;
  assert.equal(par.kind, 'par');
  assert.equal(par.unit, 0);
  assert.deepEqual(par.position, { x: -3, y: world.TRUSS_H, z: -2.4 });
  assert.ok(par.aim.y < 0 && par.aim.z > 0, 'down, and out front');
  near(Math.hypot(par.aim.x, par.aim.y, par.aim.z), 1, 'the aim is a direction');
  near(par.end.y, 0, 'the beam runs to the floor');
  near(par.radius, Math.tan(world.BEAM_HALF_ANGLE) * par.length, 'and spreads with its length');
  assert.equal(room.trusses.length, 1, 'something to hang it from');
  assert.equal(room.trusses[0].y, world.TRUSS_H + 0.2);
});

test('the floor group stands on the deck and aims up; the room group and Hue lamps are bulbs', () => {
  const { room } = placed([
    fixture(0, 'par', { position: { x: 50, y: 80 }, group: 'floor' }),
    fixture(1, 'par', { position: { x: 5, y: 95 }, group: 'room' }),
    fixture(2, 'generic-hue-lamp-7ch', { position: { x: 50, y: 20 }, group: 'front' }),
  ]);
  const [floor, room1, hue] = room.lamps;
  assert.equal(floor.kind, 'par');
  assert.equal(floor.position.y, world.FLOOR_H);
  assert.ok(floor.aim.y > 0.9, 'up');
  assert.ok(floor.end.y > world.TRUSS_H, 'past the truss');
  assert.equal(room1.kind, 'bulb');
  assert.equal(room1.position.y, world.ROOM_H);
  assert.equal(room1.aim, null);
  assert.equal(hue.kind, 'bulb', 'a Hue lamp has no beam, even on the truss');
  assert.equal(room.trusses.length, 0, 'nothing is hung, so no truss');
});

test('a bar\'s cells hang in a line, first to last, in the rig\'s unit order', () => {
  const { rig, room } = placed([
    fixture(0, 'par', { position: { x: 10, y: 20 } }),
    fixture(1, 'bar', { position: { x: 50, y: 10 }, geometry: { length: 40, angle: 0 } }),
  ]);
  assert.equal(room.cells.length, 4);
  assert.deepEqual(room.cells.map((c) => c.unit), [1, 2, 3, 4]);
  assert.ok(room.cells.every((c) => c.fixture === 1 && c.position.y === world.TRUSS_H));
  const xs = room.cells.map((c) => c.position.x);
  assert.deepEqual([...xs].sort((a, b) => a - b), xs, 'stage left to stage right');
  room.cells.forEach((c, k) => {
    const at = world.planToWorld(rig.points[c.unit]);
    near(c.position.x, at.x, `cell ${k} across`);
    near(c.position.z, at.z, `cell ${k} deep`);
  });
  // The par 0.8 m in front of the bar hangs from a truss of its own.
  assert.equal(room.trusses.length, 2);
});

test('a panel stands upright: columns across, rows down from the truss', () => {
  const { room } = placed([fixture(0, 'panel', { position: { x: 50, y: 50 }, geometry: { length: 30, angle: 0 } })]);
  assert.equal(room.cells.length, 6);
  const [a, b, c, d] = room.cells;
  near(a.position.y, b.position.y, 'a row is level');
  assert.ok(d.position.y < a.position.y, 'the second row is below the first');
  assert.ok(a.position.x < b.position.x && b.position.x < c.position.x, 'columns run across');
  near(a.position.x, d.position.x, 'a column is plumb');
  near(b.position.x, 0, 'centred on its place');
  assert.ok(a.position.y < world.TRUSS_H, 'it hangs below the truss');
  near(a.size, (0.3 * world.STAGE_W) / 3, 'square cells across its width');
});

test('every light of a mixed rig is placed exactly once', () => {
  const fixtures = [
    fixture(0, 'par', { position: { x: 20, y: 20 } }),
    fixture(1, 'bar'),
    fixture(2, 'panel'),
    fixture(3, 'generic-hue-lamp-7ch', { group: 'room' }),
    fixture(4, 'par', { group: 'floor' }),
  ];
  const { rig, room } = placed(fixtures);
  const units = [...room.lamps, ...room.cells].map((l) => l.unit).sort((a, b) => a - b);
  assert.deepEqual(units, rig.units.map((_, u) => u));
  for (const light of [...room.lamps, ...room.cells]) {
    for (const v of Object.values(light.position)) assert.ok(Number.isFinite(v), `unit ${light.unit} is somewhere`);
  }
});

test('trusses: a row per line of hung fixtures, across their span', () => {
  assert.deepEqual(world.trussesFor([]), []);
  const one = world.trussesFor([{ x: -2, z: 1 }, { x: 3, z: 1.2 }, { x: 0, z: 0.9 }]);
  assert.equal(one.length, 1);
  assert.equal(one[0].from, -2.5);
  assert.equal(one[0].to, 3.5);
  near(one[0].z, (1 + 1.2 + 0.9) / 3, 'through the middle of the row');
  const two = world.trussesFor([{ x: 0, z: -3 }, { x: 1, z: 1 }]);
  assert.deepEqual(two.map((t) => t.z), [-3, 1], 'back to front');
});

test('a light\'s colour: black is dark, full red is red, white and amber mix in, too much is scaled whole', () => {
  const out = new Float32Array(6);
  assert.equal(world.lightRGB(null, out), 0);
  assert.deepEqual([...out.slice(0, 3)], [0, 0, 0]);
  assert.equal(world.lightRGB({ r: 255, g: 0, b: 0 }, out, 3), 1);
  assert.deepEqual([...out.slice(3)], [1, 0, 0], 'written where it was asked for');
  world.lightRGB({ r: 128, g: 0, b: 0 }, out);
  near(out[0], ((128 / 255 + 0.055) / 1.055) ** 2.4, 'half on is a linear quarter or so');
  assert.ok(world.lightRGB({ r: 128 }, out) < 1);
  // Red and white at full: red wins, the hue kept, nothing past 1.
  world.lightRGB({ r: 255, w: 255 }, out);
  assert.equal(out[0], 1);
  near(out[1], out[2], 'white adds to green and blue alike');
  assert.ok(out[1] > 0 && out[1] < 1);
  world.lightRGB({ a: 255 }, out);
  assert.ok(out[0] === 1 && out[1] > 0 && out[1] < 1 && out[2] === 0, 'amber is warm');
  world.lightRGB({ uv: 255 }, out);
  assert.ok(out[2] > out[0] && out[1] === 0, 'UV reads violet');
});

test('the live frame: a par\'s emitters, each cell of a bar, through their profiles', () => {
  const fixtures = [fixture(0, 'par'), fixture(1, 'bar', { address: 11 })];
  const rig = buildRig(fixtures, (f) => PROFILES[f.profileId]);
  const universe = new Array(512).fill(0);
  universe.splice(0, 4, 255, 255, 0, 0);                 // the par: full red
  universe.splice(10, 13, 255, 0, 0, 255, 0, 255, 0, 0, 0, 0, 0, 0, 0);  // bar: dimmer, cells blue, green
  const state = { profiles: PROFILES, masterBlackout: false, masterDimmer: 255 };
  const frame = rigLights(fixtures, state, { 0: universe }, rig);
  assert.equal(frame.length, 5);
  assert.deepEqual([frame[0].r, frame[0].g, frame[0].b], [255, 0, 0]);
  assert.deepEqual(frame.slice(1).map((l) => [l.r, l.g, l.b]), [[0, 0, 255], [0, 255, 0], [0, 0, 0], [0, 0, 0]]);

  const dark = rigLights(fixtures, { ...state, masterBlackout: true }, { 0: universe }, rig);
  assert.ok(dark.every((l) => !l.r && !l.g && !l.b), 'blackout is dark everywhere');
  assert.equal(fixtureLight(fixtures[1], state, { 0: universe }), null, 'a bar is not one light');
  assert.equal(fixtureLight(fixture(2, 'missing'), state, { 0: universe }), null, 'nor is a fixture without its profile');
});
