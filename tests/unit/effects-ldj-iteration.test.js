import test from 'node:test';
import assert from 'node:assert/strict';
import { LDJ_ITERATION_ROWS, GENRE_SCORES } from '../../src/shared/effects/ldj-iteration.ts';
import { kindOf, validateSpec } from '../../src/shared/effects/registry.ts';
import { LDJ_FRAME_MS } from '../../src/shared/effects/ldj-engine.ts';
import { parseHex, toHex } from '../../src/shared/effects/palette.ts';
import { permutation } from '../../src/shared/effects/hash.ts';
import { harness, row, square, RED, CYAN } from '../helpers/ldj-harness.js';

const NAMES = `ScatterFill ScatterStrobe Circuit MatrixCycle BLStrobeCycle BLScatterStrobe BrtSinStrobe BrtSinScatter DoubleStrobeCycle DoubleScatterStrobe DoubleFillStrobe BLFadeCycle ScatterFade BLScatterFade BLGrowCycle ScatterGrow BLScatterGrow ThreeStageStrobe ThreeStageFade ThreeStageFlare ThreeStageGlow ThreeStageFill FiveStageFlare FiveStageGlow FiveStageFill FiveStageStrobe FiveStageFade ThreeStageStrobeMod ThreeStageFadeMod ThreeStageFlareMod ThreeStrobeAndFade FlareAndBreak PaletteDrip PaletteFlare PaletteGlow Popcorn DubstepStrobe DAndBStrobe HouseStrobe ElectroStrobe TechnoStrobe TrueStrobe PaletteTrueStrobe PaletteSplit PalettePartyStrobe PaletteStrobe PaletteTrail PaletteFill SMStudioN1Pulse SMStudioN2Pulse SMStudioN3Pulse SMStudioN4Pulse SMStudioN5Pulse SMStudioN2PulseMulti SMStudioN3PulseMulti SMStudioN4PulseMulti SMStudioN5PulseMulti`.split(' ');
const lit = (out) => out.flatMap((s, i) => s.level > .001 ? [i] : []);
const hex = (slot) => toHex(slot.colour);
const BLUE = parseHex('#00F'), GREEN = parseHex('#0F0');

test('all 57 iteration rows register with serializable defaults and finite small rooms', () => {
  assert.equal(NAMES.length, 57);
  assert.deepEqual(Object.keys(LDJ_ITERATION_ROWS).sort(), [...NAMES].sort());
  for (const name of NAMES) {
    const def = kindOf(`ldj.${name}`);
    assert.ok(def, name);
    const spec = validateSpec({ kind: def.kind });
    assert.deepEqual(validateSpec(spec), spec);
    for (const n of [0, 1, 5]) {
      const h = harness(def.kind, row(n), { palette: [RED] });
      for (const beat of [0, .25, .5, 1, 2, 4, 8, 16]) {
        for (const s of h.draw(beat)) {
          assert.ok(Number.isFinite(s.level) && s.level >= 0 && s.level <= 1, `${name}/${n}/${beat}`);
          assert.ok(Object.values(s.colour).every(Number.isFinite));
          assert.equal(s.strength, 1);
        }
      }
    }
  }
});

test('quarter-beat scatter excludes its previous lamp while Circuit follows the radial ring', () => {
  const room = square(), scatter = harness('ldj.ScatterStrobe', room), circuit = harness('ldj.Circuit', room);
  let previous = null;
  for (let i = 0; i < 12; i++) {
    const out = scatter.draw(i / 4), pick = lit(out);
    assert.equal(pick.length, 1); assert.notEqual(pick[0], previous); previous = pick[0];
    assert.deepEqual(out[pick[0]].colour, CYAN);
    assert.deepEqual(lit(circuit.draw(i / 4)), [room.ring.indexOf(i % 4)]);
  }
});

test('Scatter Fill visits every lamp once per seeded pass and changes the pass colour', () => {
  const h = harness('ldj.ScatterFill', row(5));
  for (let pass = 0; pass < 3; pass++) {
    const order = permutation(h.inst.seed, pass, 5), colour = pass % 2 ? CYAN : RED;
    for (let j = 0; j < 5; j++) {
      h.draw(pass * 5 + j);
      assert.equal(h.state().lastPick, order[j]);
      const slot = row(5).ring.indexOf(order[j]);
      assert.deepEqual(h.state().lamps.read(slot).colour, colour);
    }
  }
});

test('stages select radial ranks, including previous-stage glow and recoloured fills', () => {
  for (const count of [3, 5]) {
    const prefix = count === 3 ? 'Three' : 'Five', room = row(10);
    for (const mode of ['Strobe', 'Fade', 'Flare', 'Glow', 'Fill']) {
      const h = harness(`ldj.${prefix}Stage${mode}`, room, { palette: [RED, CYAN, BLUE] });
      for (let step = 0; step < count + 1; step++) {
        const out = h.draw(step);
        for (let slot = 0; slot < room.n; slot++) {
          const group = room.ring[slot] % count, current = step % count;
          const chosen = group === current || mode === 'Fill' && group <= current;
          const previous = mode === 'Glow' && group === (current + count - 1) % count;
          assert.equal(out[slot].level, chosen ? ['Flare', 'Glow'].includes(mode) ? 0 : 1 : previous ? 1 : 0);
          if (chosen) assert.deepEqual(out[slot].colour, [RED, CYAN, BLUE][step % 3]);
        }
      }
    }
  }
});

test('modified stages count only the two active half-beat events', () => {
  for (const mode of ['Strobe', 'Fade', 'Flare']) {
    const h = harness(`ldj.ThreeStage${mode}Mod`, row(6));
    for (let i = 0; i < 12; i++) {
      const out = h.draw(i / 2), active = i % 4 < 2;
      const stage = (Math.floor(i / 4) * 2 + i % 4) % 3;
      const coloured = out.flatMap((s, slot) => (s.colour.r || s.colour.g || s.colour.b) ? [slot] : []);
      assert.deepEqual(coloured, active ? row(6).ring.flatMap((rank, slot) => rank % 3 === stage ? [slot] : []) : []);
    }
  }
});

test('backlit fades blend colour at full level; ordinary Scatter Fade dims instead', () => {
  for (const name of ['BLFadeCycle', 'BLScatterFade']) {
    const h = harness(`ldj.${name}`, row(5));
    const first = h.draw(0), pick = first.findIndex((s) => hex(s) === '#FF0000');
    assert.ok(pick >= 0);
    assert.ok(first.every((s) => s.level === 1));
    const middle = h.draw({ beatPos: .5, nowMs: LDJ_FRAME_MS * 5 });
    assert.equal(middle[pick].level, 1);
    assert.ok(middle[pick].colour.r > 0 && middle[pick].colour.g > 0);
    assert.ok(middle.every((s, i) => i === pick || hex(s) === '#00FFFF'));
  }
  const h = harness('ldj.ScatterFade', row(5));
  const pick = lit(h.draw(0))[0];
  assert.equal(h.draw({ beatPos: .5, nowMs: LDJ_FRAME_MS * 5 })[pick].level, .5454543828964233);
});

test('grow rows retain one lamp for half/full pairs and sine brightness follows integer iterations', () => {
  for (const name of ['BLGrowCycle', 'ScatterGrow', 'BLScatterGrow']) {
    const h = harness(`ldj.${name}`, row(4));
    for (let pair = 0; pair < 4; pair++) {
      const a = h.draw(pair), selected = a.findIndex((s) => s.level === .5);
      assert.ok(selected >= 0);
      const b = h.draw(pair + .5);
      assert.equal(b[selected].level, 1); assert.deepEqual(b[selected].colour, RED);
    }
  }
  for (const name of ['BrtSinStrobe', 'BrtSinScatter']) {
    const h = harness(`ldj.${name}`, row(4));
    for (let i = 0; i < 18; i++) {
      const out = h.draw(i / 2), selected = out.find((s) => hex(s) === '#FF0000');
      assert.equal(selected.level, Math.fround(Math.sin(i * Math.PI / 16) / 2 + .5));
    }
  }
});

test('double strobes keep their lamp and palette for four quarter-beat steps', () => {
  for (const name of ['DoubleStrobeCycle', 'DoubleScatterStrobe']) {
    const h = harness(`ldj.${name}`, row(5));
    let selected;
    for (let i = 0; i < 12; i++) {
      const out = h.draw(i / 4);
      if (i % 4 === 0) selected = lit(out)[0];
      assert.deepEqual(lit(out), i % 2 ? [] : [selected]);
      if (i % 2 === 0) assert.deepEqual(out[selected].colour, Math.floor(i / 4) % 2 ? CYAN : RED);
    }
  }
});

test('double fill alternates the two radial halves through flare and fade', () => {
  const h = harness('ldj.DoubleFillStrobe', row(6));
  const a = h.draw(0); assert.deepEqual(lit(a), []);
  const b = h.draw(.25);
  assert.ok(b.every((s, i) => row(6).ring[i] % 2 ? s.level === 0 : s.level > 0));
  const c = h.draw(.5);
  assert.ok(c.every((s, i) => row(6).ring[i] % 2 ? s.level > 0 : s.level === 1));
});

test('genre scores preserve four distinct hit, colour, off and hold actions', () => {
  const vectors = {
    House: 'p H H H s H H H p H H H s H s H', Electro: 'p H H p H H p H H H s H s H H H',
    Techno: 'p H O H s H O H p H O H s H O H', Dubstep: 'p H p H s H H H p H p H s H H H',
    DAndB: 'p H H H H H p H H H H H s H H H',
  };
  for (const [genre, vector] of Object.entries(vectors)) {
    const expected = vector.split(' ').map((v) => v === 'H' ? 'hold' : v === 'O' ? 'off' : v);
    assert.deepEqual(GENRE_SCORES[genre], expected);
    const h = harness(`ldj.${genre}Strobe`, row(6));
    let previous = null, lastLit = null;
    for (let i = 0; i < 32; i++) {
      const out = h.draw(i / 4), action = expected[i % 16];
      if (action === 'hold') assert.deepEqual(out, previous);
      else if (action === 'off') assert.deepEqual(lit(out), []);
      else {
        const picks = lit(out); assert.equal(picks.length, 1); assert.notEqual(picks[0], lastLit);
        lastLit = picks[0]; assert.deepEqual(out[picks[0]].colour, action === 'p' ? CYAN : RED);
      }
      previous = out;
    }
  }
});

test('wall and palette strobes obey their separate half-cycle clocks and acknowledgement', () => {
  for (const bpm of [60, 174]) {
    const h = harness('ldj.TrueStrobe', row(1), { bpm, startedAtMs: 1000 });
    assert.deepEqual([0, 40, 60, 110, 160].map((ms) => h.draw({ nowMs: 1000 + ms, beatPos: 0 })[0].level), [1, 1, 0, 1, 0]);
  }
  const h = harness('ldj.PaletteTrueStrobe', row(1));
  for (let i = 0; i < 12; i++) {
    const out = h.draw(i / 8)[0]; assert.equal(out.level, i % 2 ? 0 : 1);
    if (i % 2 === 0) assert.deepEqual(out.colour, Math.floor(i / 4) % 2 ? CYAN : RED);
  }
  for (const [name, def] of Object.entries(LDJ_ITERATION_ROWS)) if (def.cadence === 'wall:50' || def.cadence <= .25) {
    assert.equal(kindOf(`ldj.${name}`).rapidFlash, true, name);
    assert.ok(harness(`ldj.${name}`, row(3), { acknowledged: false, spec: { rapidFlash: false } }).draw(0).every((s) => s.strength === 0));
  }
});

test('palette drip, flare and glow preserve their two-beat phases, including the black glow half', () => {
  for (const name of ['PaletteDrip', 'PaletteFlare', 'PaletteGlow']) {
    const h = harness(`ldj.${name}`, row(1));
    assert.equal(h.draw(0)[0].level, name === 'PaletteDrip' ? 1 : 0);
    const middle = h.draw(1)[0]; assert.ok(middle.level > .4 && middle.level < .6);
    const next = h.draw(2)[0];
    assert.deepEqual(next.colour, name === 'PaletteGlow' ? parseHex('#000') : CYAN);
    assert.equal(next.level, name === 'PaletteFlare' ? 0 : 1);
    if (name === 'PaletteGlow') assert.deepEqual(h.draw(4)[0].colour, CYAN);
  }
});

test('Popcorn follows both masks, retains its background and blends at constant brightness', () => {
  const masks = [[0, 2, 3, 5, 6, 9, 11, 12, 13], [0, 2, 3, 5, 6, 7, 10, 11, 13]];
  const h = harness('ldj.Popcorn', row(6));
  for (let i = 0; i < 32; i++) {
    const out = h.draw(i / 2);
    assert.ok(out.every((s) => s.level === 1));
    assert.equal(out.filter((s) => hex(s) === '#00FFFF').length, masks[Math.floor(i / 16)].includes(i % 16) ? 1 : 0);
  }
});

test('palette trails and fills wrap with short, equal and oversized palettes', () => {
  const colours = [RED, CYAN, BLUE, GREEN, parseHex('#FFF')];
  for (const [n, m] of [[5, 2], [4, 2], [3, 3], [2, 5], [1, 1]]) {
    for (const name of ['PaletteTrail', 'PaletteFill']) {
      const room = row(n), h = harness(`ldj.${name}`, room, { palette: colours.slice(0, m) });
      const expected = Array.from({ length: n }, () => null);
      for (let iter = 0; iter <= n + 1; iter++) {
        const start = name === 'PaletteFill' ? ((iter * m - 1) % n + n) % n : iter % n;
        if (name === 'PaletteTrail') expected.fill(null);
        const offset = (name === 'PaletteFill' ? n % m !== 0 || m > n : m > n) ? Math.floor(iter / n) : 0;
        for (let j = 0; j < Math.min(n, m); j++) expected[room.ring.indexOf((start + j) % n)] = colours[(j + offset) % m];
        const out = h.draw(iter);
        expected.forEach((colour, slot) => {
          assert.equal(out[slot].level, colour ? 1 : 0);
          if (colour) assert.deepEqual(out[slot].colour, colour);
        });
      }
    }
  }
});

test('palette strobe shuffles distinct colours onto distinct lamps; party holds prior lamps', () => {
  const h = harness('ldj.PaletteStrobe', row(7), { palette: [RED, CYAN, BLUE] });
  for (let i = 0; i < 8; i++) {
    const out = h.draw(i), picks = lit(out);
    assert.equal(picks.length, 3); assert.equal(new Set(picks.map((p) => hex(out[p]))).size, 3);
  }
  const party = harness('ldj.PalettePartyStrobe', row(6));
  assert.equal(lit(party.draw(0)).length, 1); assert.equal(lit(party.draw(.25)).length, 2);
});

test('Studio rows preserve note durations, half-room exclusion and the .05 baseline', () => {
  const durations = [1, 2, 4, 6, 8];
  for (let note = 1; note <= 5; note++) {
    const h = harness(`ldj.SMStudioN${note}Pulse`, row(3));
    let previous;
    for (let i = 0; i < 4; i++) {
      h.draw(i * durations[note - 1]); const pick = h.state().lastPick;
      assert.notEqual(pick, previous); previous = pick;
      assert.equal(h.state().recent.length, 1);
    }
  }
  const h = harness('ldj.SMStudioN1Pulse', row(3));
  const pick = lit(h.draw(0))[0];
  assert.equal(h.draw({ beatPos: .99, nowMs: 500 })[pick].level, Math.fround(.05));
  const multi = harness('ldj.SMStudioN5PulseMulti', row(5));
  multi.draw(0); assert.equal(lit(multi.draw(1)).length, 2);
});

test('Flare and Break restarts after its staggered break; the long stage fade survives hold steps', () => {
  const h = harness('ldj.FlareAndBreak', row(5));
  h.draw(0); assert.ok(h.draw(2).every((s) => s.level > .5));
  h.draw(3); assert.ok(h.draw(3.9).some((s) => s.level === 0));
  const restart = h.draw(4); assert.ok(restart.every((s) => s.level === 0 && hex(s) === '#00FFFF'));
  const stage = harness('ldj.ThreeStrobeAndFade', row(6));
  stage.draw(0); stage.draw(1); stage.draw(2);
  assert.ok(stage.draw(3).every((s) => s.level === 1));
  assert.ok(stage.draw(7).every((s) => s.level > .2 && s.level < .4));
});

test('selective random backgrounds and independent lamp caches survive clone continuation', () => {
  const random = { palette: [{ random: true }, { random: true }] };
  const h = harness('ldj.BLStrobeCycle', row(5), { spec: random });
  h.draw(0); h.draw(.1);
  const first = h.draw(1).map(hex);
  const next = h.draw(2).map(hex);
  assert.equal(first[4], next[4]);
  const pop = harness('ldj.Popcorn', row(8), { spec: random });
  const initial = pop.draw(0).map(hex);
  const background = initial.find((c) => initial.filter((v) => v === c).length === 7);
  const firstPop = initial.find((c) => c !== background);
  pop.draw(.5);
  const later = pop.draw(1).map(hex);
  assert.equal(later.filter((c) => c === background).length, 7);
  assert.notEqual(later.find((c) => c !== background), firstPop);
  const fill = harness('ldj.ScatterFill', row(8), { spec: { palette: [{ random: true }] } });
  for (let i = 0; i < 8; i++) fill.draw(i);
  assert.ok(new Set(fill.draw(7.1).map(hex)).size > 2);
  const clone = fill.stepper.clone();
  assert.deepEqual(fill.draw(8, clone), fill.draw(8));
  assert.deepEqual(fill.draw(9, clone), fill.draw(9));
});

test('palette index and random cache identity remain distinct in matrix and envelope rows', () => {
  const probe = (name, iter) => {
    const reads = [], pending = [];
    LDJ_ITERATION_ROWS[name].step({ n: 3, iter, pal: [RED, CYAN, BLUE], ringOrder: [0, 1, 2], state: { scratch: {} },
      colour(index, key = index) { reads.push([index, key]); return RED; },
      refresh(key) { pending.push(key); }, lamps: { set() {}, off() {} },
    });
    return { reads, pending };
  };
  for (const name of ['MatrixCycle', 'PaletteDrip', 'PaletteFlare']) {
    const p = probe(name, 2);
    assert.deepEqual(p.pending, [2], name);
    assert.ok(p.reads.every(([index, key]) => index === 2 && key === 0), name);
  }
  assert.deepEqual(probe('PaletteGlow', 2), { reads: [[1, 0]], pending: [0, 0, 0] });
  assert.deepEqual(probe('ThreeStageStrobeMod', 2).pending, [2]);
  assert.deepEqual(probe('ThreeStageStrobeMod', 3).pending, [2]);
});

test('uncached random rows change per lamp frame while faster samples and cached backgrounds hold', () => {
  const spec = { palette: [{ random: true }, { random: true }] };
  const sample = (h, elapsed) => h.draw({ nowMs: 1000 + elapsed, beatPos: elapsed / 500 });
  for (const name of ['PaletteSplit', 'TrueStrobe']) {
    const h = harness(`ldj.${name}`, row(8), { spec, startedAtMs: 1000 });
    const first = sample(h, 0);
    assert.ok(new Set(first.map(hex)).size > 1, name);
    assert.deepEqual(sample(h, LDJ_FRAME_MS / 2), first, name);
    const clone = h.stepper.clone();
    const second = sample(h, LDJ_FRAME_MS + .01);
    assert.notDeepEqual(second.map(hex), first.map(hex), name);
    assert.deepEqual(h.draw({ nowMs: 1000 + LDJ_FRAME_MS + .01, beatPos: (LDJ_FRAME_MS + .01) / 500 }, clone), second);
    const fixed = h.draw({ nowMs: 1047, beatPos: .094, paletteOverride: [BLUE] });
    assert.ok(fixed.every((s) => hex(s) === '#0000FF'));
    assert.deepEqual(harness(`ldj.${name}`, row(8), { spec, startedAtMs: 1000 }).draw({ nowMs: 1000 + LDJ_FRAME_MS + .01, beatPos: (LDJ_FRAME_MS + .01) / 500 }), second);
  }
  for (const name of ['BLGrowCycle', 'ScatterGrow', 'BLScatterGrow']) {
    const h = harness(`ldj.${name}`, row(8), { spec, startedAtMs: 1000 });
    const first = sample(h, 0), selected = first.findIndex((s) => s.level === .5);
    assert.ok(selected >= 0, name);
    assert.deepEqual(sample(h, LDJ_FRAME_MS / 2), first);
    const colours = [hex(first[selected])];
    for (let frame = 1; frame <= 4; frame++) {
      const out = sample(h, frame * LDJ_FRAME_MS + .01);
      colours.push(hex(out[selected]));
      for (let slot = 0; slot < 8; slot++) if (slot !== selected) assert.deepEqual(out[slot], first[slot]);
    }
    assert.ok(new Set(colours).size > 1, name);
  }
});
