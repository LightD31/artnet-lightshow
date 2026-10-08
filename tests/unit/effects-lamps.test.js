import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { buildRig } from '../../src/shared/rig.ts';
import { roomOf } from '../../src/shared/room.ts';
import { effectRoom } from '../../src/shared/effects/layer.ts';
import { renderEffect } from '../../src/shared/effects/render.ts';
import { registerKind, kindOf, validateSpec, KINDS } from '../../src/shared/effects/registry.ts';
import { EffectStepper } from '../../src/shared/effects/stepper.ts';
import { seedFrom } from '../../src/shared/effects/hash.ts';
import { HD_MASTER_DEFAULTS } from '../../src/shared/effects/types.ts';
import '../../src/shared/effects/index.ts';

const WHITE = { r: 255, g: 255, b: 255, w: 0, a: 0, uv: 0 };
const fixtures = [
  { id: 10, position: { x: 10, y: 20 } },
  { id: 20, position: { x: 30, y: 80 }, hue: true },
  { id: 30, position: { x: 50, y: 20 }, geometry: { length: 20, angle: 0 } },
  { id: 40, position: { x: 70, y: 80 }, hue: true },
  { id: 50, position: { x: 90, y: 20 } },
];
const rigOf = (count) => buildRig(fixtures, (f) => f.id === 30 && count > 1
  ? { cells: Array.from({ length: count }, (_, i) => ({ channelMap: { red: i * 3, green: i * 3 + 1, blue: i * 3 + 2 } })) } : null);
const frame = (ms, rig, layout) => ({ beatPos: ms / 500, bpm: 120, nowMs: ms, dtMs: 25, anchorBeat: 0,
  lookPalette: [WHITE], paletteOverride: null, audio: null, audioMode: 'tempo', master: HD_MASTER_DEFAULTS,
  acknowledged: true, hueStrobe: 'pulse', fixtureIds: layout.units.list.map((u) => rig.fixtures[rig.units[u].fixture].id) });
const instance = (spec, targets = null) => ({ id: 'lamp-test', spec: validateSpec(spec), seed: seedFrom('lamps'), anchorBeat: 0, startedAtMs: 0, targets });
function player(count, spec, map = 'stage', targets = null) {
  const rig = rigOf(count), layout = rig.layout(null, map), room = effectRoom(layout), stepper = new EffectStepper();
  const inst = instance(spec, targets);
  return { room, layout, at(ms) {
    const out = new Array(room.n);
    renderEffect(inst, frame(ms, rig, layout), room, stepper, out);
    return out;
  } };
}

test('lamp rooms retain fixture geometry, ids and normalized Hue flags', () => {
  const rig = rigOf(16), layout = rig.layout(null, 'bar');
  const room = effectRoom(layout);
  assert.equal(room.lamps.n, 5);
  assert.equal(room.n, 20);
  assert.equal(effectRoom(layout), room);
  assert.deepEqual(room.lamps.hue, [false, true, false, true, false]);
  assert.deepEqual(layout.lamps.plan.x, [0.1, 0.3, 0.5, 0.7, 0.9]);
  const normalized = { ...layout, units: { ...layout.units, noFlash: layout.units.list.map(() => true) } };
  assert.ok(effectRoom(normalized).lamps.hue.every(Boolean));
  assert.deepEqual(effectRoom(layout).lamps.hue, [false, true, false, true, false]);
});

test('one-cell layouts reuse the original room', () => {
  const layout = rigOf(1).layout();
  assert.equal(layout.lamps, undefined);
  assert.equal(effectRoom(layout), roomOf({ fixtureCount: 5, ...layout.units }));
});

test('lamp targets mask the spread after full-room sampling', () => {
  let ids, n;
  registerKind({ kind: 'test.lamp-mask', level: 'lamp', app: 'own', schema: z.object({}), defaults: { params: {} },
    init: (_p, room, f) => { n = room.n; ids = f.fixtureIds; return null; },
    render: (_p, _s, room, _f, out) => {
      for (let i = 0; i < room.n; i++) out[i] = { colour: WHITE, level: (i + 1) / room.n, strength: 1, strobe: 5, kind: 'test.lamp-mask' };
    } });
  const p = player(4, { kind: 'test.lamp-mask', brightness: 0.5 }, 'stage', [3, 6]);
  const out = p.at(0);
  assert.equal(n, 5);
  assert.deepEqual(ids, fixtures.map((f) => f.id));
  assert.deepEqual(Object.keys(out), ['3', '6']);
  assert.equal(out[3].level, 0.3);
  assert.equal(out[6].level, 0.4);
  assert.equal(out[3].strobe, 5);
  assert.equal(out[3].kind, 'test.lamp-mask');
});

for (const kind of ['ldj.PartyStrobe', 'ldj.SceneMakerFirework', 'ldj.ScatterStrobe', 'ldj.Popcorn',
  'hd.positionChase', 'hd.bouncingScan', 'hd.streak', 'hd.twinkle', 'hd.frequencyBurst']) {
  test(`${kind} picks the same lamps beside four or 4096 pixels`, () => {
    const a = player(4, { kind }), b = player(4096, { kind });
    const picks = (p, out) => p.room.lamps.slots.filter((slots) => slots.length === 1).map(([slot]) => out[slot]);
    for (let ms = 0; ms <= 4000; ms += 50) assert.deepEqual(picks(a, a.at(ms)), picks(b, b.at(ms)), `at ${ms} ms`);
  });
}

test('whole-lamp effects spread one result over every curtain cell', () => {
  const p = player(16, { kind: 'ldj.Popcorn' });
  for (let ms = 0; ms < 2000; ms += 25) {
    const out = p.at(ms), slots = p.room.lamps.slots[2];
    for (const slot of slots) assert.deepEqual(out[slot], out[slots[0]]);
  }
});

test('ordered HD effects retain a moving picture inside a strip', () => {
  for (const kind of ['hd.positionChase', 'hd.bouncingScan', 'hd.streak']) {
    const p = player(16, { kind, params: { order: 'track' } });
    let varied = false;
    for (let ms = 0; ms < 2000; ms += 25) {
      const out = p.at(ms);
      varied ||= new Set(p.room.lamps.slots[2].map((slot) => JSON.stringify(out[slot]))).size > 1;
    }
    assert.ok(varied, kind);
  }
});

test('macro children keep their own lamp or pixel level', () => {
  const child = { kind: 'ldj.Popcorn' };
  const direct = player(16, child);
  const macro = player(16, { kind: 'macro', params: { steps: [{ effect: child, beats: 4 }], loopBeats: 4 } });
  assert.equal(kindOf('macro').level, undefined);
  for (let ms = 0; ms < 1500; ms += 25) {
    const out = macro.at(ms);
    for (const slots of direct.room.lamps.slots) for (const slot of slots) assert.deepEqual(out[slot], out[slots[0]]);
  }
});

test('pixel kinds stay on cells and lamp selectors declare their level', () => {
  for (const kind of ['strobe', 'energy.blinder', 'ldj.bitmap', 'hd.spatialWash', 'hd.radialPulse', 'ldj.Swirl']) {
    assert.ok(kindOf(kind), kind);
    assert.notEqual(kindOf(kind).level, 'lamp', kind);
  }
  for (const kind of ['hd.disco', 'ldj.matrixBoard', 'ldj.visualizer']) assert.equal(kindOf(kind).level, 'lamp', kind);
  for (const def of KINDS.values()) if (def.kind.startsWith('ldj.') && def.defaults.params.cadence !== undefined && def.stateful) {
    assert.equal(def.level, 'lamp', def.kind);
  }
});
