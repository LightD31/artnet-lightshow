// The party effects: after the Party families of Hue Dynamics and the room
// effects of Light DJ, travelling the room by where the lamps stand on the
// stage plot. Every one is a function of the plan and of where the music is,
// so each is pinned here at a clock position and a set of positions.

import test from 'node:test';
import assert from 'node:assert';
import { PATTERN_FUNCS, CELL_PATTERNS, PARTY_PATTERNS, roomOf, MAX_LAMP_FLASH_HZ, BACKLIGHT } from '../../src/shared/patterns.ts';
import { PATTERNS, COLOR_PRESETS } from '../../src/server/presets.ts';
import { buildRig } from '../../src/shared/rig.ts';
import { renderLayer } from '../../src/shared/layer.ts';
import { EXPRESSION_REST, HUE_PULSE_MS, HUE_PULSE_FLOOR } from '../../src/shared/look-math.ts';

const RED = COLOR_PRESETS[0];
const GREEN = COLOR_PRESETS[3];
const BLUE = COLOR_PRESETS[5];
const MAGENTA = COLOR_PRESETS[8];
const DUO = [RED, BLUE, RED, BLUE];
const QUAD = [RED, BLUE, GREEN, MAGENTA];
const PARTY = Object.keys(PARTY_PATTERNS);

/** A placed room: lamps at plot positions in percent, and their groups. */
const plan = (points, groups = []) => ({
  x: points.map(([x]) => x / 100),
  y: points.map(([, y]) => y / 100),
  group: points.map((_, i) => groups[i] ?? null),
});
// The four corners of the room, front left round to back left, and the
// middle. The room is in Hue's frame: the front is the top of the plot (the
// stage, the TV) and the back its bottom, where the audience is.
const FL = [10, 10]; const FR = [90, 10]; const BR = [90, 90]; const BL = [10, 90]; const MID = [50, 50];
const CORNERS = plan([FL, FR, BR, BL]);
const ROW = plan([[10, 50], [40, 50], [70, 50], [90, 50]]);

/** A moment `ms` into the music at `bpm`, `division` steps to the beat, as the layer hands it over. */
const at = (ms, bpm = 120, division = 1) => {
  const stepMs = 60000 / bpm / division;
  const stepPos = ms / stepMs;
  return { step: Math.floor(stepPos), stepPos, stepPhase: stepPos - Math.floor(stepPos), stepMs };
};

/** Run a pattern over `n` lamps and return [colour, dim] per lamp. */
function draw(id, { n = 4, colors = DUO, ...ctx } = {}) {
  const out = [];
  PATTERN_FUNCS[id]({
    colors, fixtureCount: n, step: 0, hue: 0, twinkle: new Array(n).fill(0), xs: null, ys: null, dynamics: null,
    write: (i, c, d) => { out[i] = [c, d]; }, ...ctx,
  });
  return out;
}
const dims = (out) => out.map(([, d]) => d);
const colours = (out) => out.map(([c]) => c);
const brightest = (out) => dims(out).indexOf(Math.max(...dims(out)));
const BED = 45;

test('every party effect is in the engine, the picker and the cell patterns, under its own group', () => {
  assert.strictEqual(PARTY.length, 18);
  for (const id of PARTY) {
    assert.strictEqual(PATTERN_FUNCS[id], PARTY_PATTERNS[id], id);
    assert.ok(CELL_PATTERNS.has(id), `${id} runs on every cell`);
    const entry = PATTERNS.find((p) => p.id === id);
    assert.ok(entry && entry.party === true && !entry.pixel, `${id} is listed as a party effect`);
  }
});

test('the same moment draws the same picture, placed or not', () => {
  for (const id of PARTY) {
    const ctx = { ...at(1234, 128, 2), pulse: { mix: 0.6, kick: 0.5, snare: 0, hats: 0.2 } };
    assert.deepStrictEqual(draw(id, { ...ctx, plan: CORNERS }), draw(id, { ...ctx, plan: CORNERS }), id);
    assert.deepStrictEqual(draw(id, ctx), draw(id, ctx), `${id}, unplaced`);
    for (const d of dims(draw(id, { n: 7, plan: plan([FL, FR, BR, BL, MID, [30, 70], [60, 20]]), ...ctx }))) {
      assert.ok(Number.isInteger(d) && d >= 0 && d <= 255, `${id}: ${d}`);
    }
  }
});

// ── The room ────────────────────────────────────────────────────────────────

const room = (p, n = p.x.length) => roomOf({ fixtureCount: n, plan: p, xs: null, ys: null });

test('the ring runs round the room from the front, clockwise seen from above', () => {
  // Clockwise from straight ahead (the plot top): front right, back right, back left, front left.
  assert.deepStrictEqual(room(CORNERS).ring, [3, 0, 1, 2], 'front right, back right, back left, front left');
  assert.ok(room(CORNERS).spread);
  // A row has no ring: along the row.
  assert.deepStrictEqual(room(ROW).ring, [0, 1, 2, 3]);
  assert.ok(!room(ROW).spread);
});

test('an unplaced rig is a row in stage order', () => {
  const r = roomOf({ fixtureCount: 4, plan: null, xs: null, ys: null });
  assert.deepStrictEqual(r.ring, [0, 1, 2, 3]);
  r.u.forEach((u, i) => assert.ok(Math.abs(u - [-1, -1 / 3, 1 / 3, 1][i]) < 1e-9, `${u}`));
  assert.deepStrictEqual(r.v, [0, 0, 0, 0]);
});

// ── Hue Dynamics' Party families ─────────────────────────────────────────────

test('position chase: a domino along the heading by position, the heading turning a quarter every run', () => {
  // Three steps a run on four lamps half a step apart, each lamp's attack an
  // eighth of a step. To the front on a row is along the row, left to right;
  // the third run heads back, so right to left.
  assert.strictEqual(brightest(draw('position-chase', { plan: ROW, ...at(75) })), 0);
  assert.strictEqual(brightest(draw('position-chase', { plan: ROW, ...at(325) })), 1);
  assert.strictEqual(brightest(draw('position-chase', { plan: ROW, ...at(575) })), 2);
  assert.strictEqual(brightest(draw('position-chase', { plan: ROW, ...at(3075) })), 3, 'the third run starts at the right');
  assert.strictEqual(brightest(draw('position-chase', { plan: ROW, ...at(3325) })), 2);
  const first = draw('position-chase', { plan: ROW, ...at(75) });
  assert.strictEqual(first[0][1], 255);
  assert.strictEqual(first[0][0], RED);
  assert.ok(first[2][1] === BED, 'the rest at the bed');
  const trail = draw('position-chase', { plan: ROW, ...at(280) });
  assert.strictEqual(brightest(trail), 1);
  assert.ok(trail[0][1] > BED && trail[0][1] < 255, `the lamp before is releasing: ${trail[0][1]}`);
  // Without a plan, stage order.
  assert.strictEqual(brightest(draw('position-chase', at(325))), 1);
});

test('radial pulse: a ring from the middle of the room out to its corners once a bar', () => {
  const five = plan([FL, FR, BR, BL, MID]);
  const early = draw('radial-pulse', { n: 5, plan: five, ...at(600) });
  assert.strictEqual(brightest(early), 4, 'the middle first');
  const late = draw('radial-pulse', { n: 5, plan: five, ...at(1500) });
  assert.ok(late[0][1] > late[4][1], `then the corners: ${dims(late)}`);
  assert.deepStrictEqual(dims(late).slice(0, 4), new Array(4).fill(late[0][1]), 'all four corners alike');
  const quiet = draw('radial-pulse', { n: 5, plan: five, ...at(600), pulse: { mix: 0.2, bass: 0.1, kick: 0, snare: 0, hats: 0 } });
  assert.ok(quiet[4][1] < early[4][1], 'the bass drives it');
});

test('spatial wash: never below the bed, and the crest moves across the room', () => {
  const seen = new Set();
  for (let ms = 0; ms < 4000; ms += 100) {
    const out = draw('spatial-wash', { plan: ROW, ...at(ms) });
    for (const d of dims(out)) assert.ok(d >= BED, `${d} at ${ms} ms`);
    seen.add(brightest(out));
  }
  assert.ok(seen.size >= 3, `the crest crosses the lamps: ${[...seen]}`);
});

test('bouncing scan: out across the room and back within the bar', () => {
  assert.strictEqual(brightest(draw('bounce-scan', { plan: ROW, ...at(0) })), 0);
  assert.strictEqual(brightest(draw('bounce-scan', { plan: ROW, ...at(1000) })), 3);
  assert.strictEqual(brightest(draw('bounce-scan', { plan: ROW, ...at(1900) })), 0);
  assert.strictEqual(draw('bounce-scan', { plan: ROW, ...at(0) })[0][0], RED);
  assert.strictEqual(draw('bounce-scan', { plan: ROW, ...at(1000) })[3][0], BLUE, 'the next colour on the way back');
});

test('streak: a comet along the heading on some events, resting on the others', () => {
  const rolls = [];
  for (let e = 0; e < 24; e++) {
    const out = draw('streak', { plan: ROW, ...at(e * 1000 + 300) });
    rolls.push(dims(out).every((d) => d === BED) ? 'rest' : 'streak');
  }
  assert.ok(rolls.includes('rest') && rolls.includes('streak'), rolls.join(','));
  const e = rolls.indexOf('streak');
  const heads = [0.1, 0.3, 0.5, 0.7].map((p) => brightest(draw('streak', { plan: ROW, ...at(e * 1000 + p * 1000) })));
  const forward = heads.every((h, k) => k === 0 || h >= heads[k - 1]);
  const backward = heads.every((h, k) => k === 0 || h <= heads[k - 1]);
  assert.ok(forward || backward, `it travels one way: ${heads}`);
  assert.ok(new Set(heads).size >= 3, `and gets across: ${heads}`);
});

test('starlight: about a third of the lamps light on each step and fade out by its end', () => {
  const lit = (ms) => dims(draw('starlight', { n: 24, ...at(ms) })).filter((d) => d > 20).length;
  assert.ok(lit(0) >= 3 && lit(0) <= 16, `${lit(0)} of 24 lit`);
  assert.notStrictEqual(lit(0), 0);
  const start = draw('starlight', { n: 24, ...at(0) });
  const mid = draw('starlight', { n: 24, ...at(200) });
  const i = brightest(start);
  assert.ok(mid[i][1] < start[i][1] && mid[i][1] > 14, `fading: ${start[i][1]} then ${mid[i][1]}`);
  assert.strictEqual(lit(480), 0, 'gone before the next step');
});

test('breathe: the whole room as one, in and out over a bar, the colour drifting', () => {
  const same = (out) => new Set(dims(out)).size === 1 && new Set(colours(out)).size === 1;
  assert.ok(same(draw('breathe', at(700))));
  assert.strictEqual(draw('breathe', at(0))[0][1], 25, 'from the floor');
  assert.strictEqual(draw('breathe', at(1100))[0][1], 255, 'to full');
  assert.strictEqual(draw('breathe', at(2000))[0][1], 25, 'and back');
  assert.notStrictEqual(draw('breathe', at(2100))[0][0], draw('breathe', at(100))[0][0], 'the next breath in a colour further round');
});

test('volume gate: a wash that opens with the music', () => {
  const loud = draw('volume-gate', { plan: ROW, ...at(300), pulse: { mix: 1, kick: 0, snare: 0, hats: 0 } });
  const soft = draw('volume-gate', { plan: ROW, ...at(300), pulse: { mix: 0.3, kick: 0, snare: 0, hats: 0 } });
  for (let i = 0; i < 4; i++) assert.ok(loud[i][1] > soft[i][1], `lamp ${i}: ${soft[i][1]} → ${loud[i][1]}`);
  assert.ok(soft.every(([, d]) => d > 0), 'never shut');
});

test('confetti: three lamps in four pop on the step and die away, or follow the kick', () => {
  const start = draw('confetti', { n: 16, ...at(0) });
  const lit = dims(start).filter((d) => d === 255).length;
  assert.ok(lit >= 8 && lit <= 15, `${lit} of 16 popped`);
  assert.ok(dims(start).every((d) => d === 255 || d === 0), 'hard on or off at the pop');
  assert.ok(dims(draw('confetti', { n: 16, ...at(450) })).every((d) => d === 0), 'gone by the end of the step');
  const kicked = draw('confetti', { n: 16, ...at(0), pulse: { mix: 0.5, kick: 0.5, snare: 0, hats: 0 } });
  assert.ok(dims(kicked).some((d) => d === 128) && !dims(kicked).some((d) => d === 255), 'as hard as the kick');
  // Never closer together than 400 ms: at eighths (62.5 ms steps) the pops
  // land every seventh step, and the hold between covers the next step.
  const fast = (ms) => dims(draw('confetti', { n: 16, ...at(ms, 120, 8) })).map((d) => d === 255);
  assert.ok(fast(0).some(Boolean));
  assert.deepStrictEqual(fast(62.5), fast(0), 'still the same pop, holding');
  for (const step of [2, 3, 4, 5, 6]) assert.ok(!fast(step * 62.5).some(Boolean), `no new pop on step ${step}`);
  assert.ok(fast(7 * 62.5).some(Boolean) && fast(7 * 62.5).some((on, i) => on !== fast(0)[i]), 'a fresh pop on the seventh');
});

// ── Light DJ's room effects ──────────────────────────────────────────────────

test('anchor fill: the corners by position, filled one a step in the next colour over the last', () => {
  const fill = (step) => colours(draw('anchor-fill', { plan: CORNERS, colors: QUAD, ...at(step * 500) }));
  // The anchors run front left, front right, back right, back left; the front is the plot top.
  assert.deepStrictEqual(fill(0), [RED, MAGENTA, MAGENTA, MAGENTA], 'front left first');
  assert.deepStrictEqual(fill(1), [RED, RED, MAGENTA, MAGENTA], 'then front right');
  assert.deepStrictEqual(fill(2), [RED, RED, RED, MAGENTA], 'back right');
  assert.deepStrictEqual(fill(3), [RED, RED, RED, RED], 'back left: full');
  assert.deepStrictEqual(fill(4), [BLUE, RED, RED, RED], 'and over again in the next colour');
  assert.ok(dims(draw('anchor-fill', { plan: CORNERS, ...at(0) })).every((d) => d === 255), 'all at full');
  // Three lamps fill from the two sides; nine from the corners and the middle.
  const three = draw('anchor-fill', { n: 3, plan: plan([[10, 50], [50, 50], [90, 50]]), colors: QUAD, ...at(0) });
  assert.deepStrictEqual(colours(three), [RED, RED, MAGENTA], 'the left side is the left two');
  // The corners, the middle, then the back, right, front and left edges (the front is the plot top).
  const nine = plan([FL, FR, BR, BL, MID, [50, 90], [90, 50], [50, 10], [10, 50]]);
  assert.strictEqual(colours(draw('anchor-fill', { n: 9, plan: nine, colors: QUAD, ...at(4 * 500) }))[4], RED, 'the middle fills last');
});

test('halves: front against back, then left against right, swapping every other time round', () => {
  const half = (step, groups) => colours(draw('halves', { plan: groups ? plan([FL, FR, BR, BL], groups) : CORNERS, ...at(step * 500) }));
  // The front half is the plot top, and it keeps colour A though the room numbers it 1, after Light DJ.
  assert.deepStrictEqual(half(0), [RED, RED, BLUE, BLUE], 'front A, back B');
  assert.deepStrictEqual(half(1), [RED, BLUE, BLUE, RED], 'left A, right B');
  assert.deepStrictEqual(half(2), [BLUE, BLUE, RED, RED], 'front B, back A');
  assert.deepStrictEqual(half(3), [BLUE, RED, RED, BLUE]);
  assert.deepStrictEqual(half(4), half(0));
  // A fixture grouped front or back is in that half whatever the plot says.
  assert.deepStrictEqual(half(0, ['back', null, null, 'front']), [BLUE, RED, BLUE, RED]);
  // A row has no front and back: half and half along it.
  assert.deepStrictEqual(colours(draw('halves', { plan: ROW, ...at(0) })), [BLUE, BLUE, RED, RED]);
});

test('flip: the diagonals of the room in A and B, swapping on every step', () => {
  // Front left and back right against front right and back left; the front is the plot top.
  assert.deepStrictEqual(colours(draw('flip', { plan: CORNERS, ...at(0) })), [RED, BLUE, RED, BLUE]);
  assert.deepStrictEqual(colours(draw('flip', { plan: CORNERS, ...at(500) })), [BLUE, RED, BLUE, RED]);
});

test('room wave: a wave across the room once a bar, on a heading that turns every lap', () => {
  const head = (ms) => brightest(draw('room-wave', { plan: ROW, ...at(ms) }));
  assert.ok(head(0) < head(600), `the first lap runs left to right: ${head(0)} then ${head(600)}`);
  assert.ok(head(6000) > head(6600), `the fourth lap heads back: ${head(6000)} then ${head(6600)}`);
  for (const d of dims(draw('room-wave', { plan: ROW, ...at(300) }))) assert.ok(d >= BED);
});

test('ring strobe: one lamp at a time round the ring, a flash on every step, each lap in the next colour', () => {
  const ring = (ms, extra = {}) => draw('ring-strobe', { plan: CORNERS, ...at(ms), ...extra });
  // Clockwise from straight ahead, the front being the plot top: front right first, front left last.
  assert.deepStrictEqual(dims(ring(0)), [0, 255, 0, 0], 'front right on the first step');
  assert.deepStrictEqual(dims(ring(500)), [0, 0, 255, 0], 'back right on the second: clockwise');
  assert.deepStrictEqual(dims(ring(1000)), [0, 0, 0, 255]);
  assert.deepStrictEqual(dims(ring(1500)), [255, 0, 0, 0]);
  assert.deepStrictEqual(dims(ring(100)), [0, 0, 0, 0], 'a flash, then black');
  assert.strictEqual(ring(0)[1][0], RED);
  assert.strictEqual(ring(2000)[1][0], BLUE, 'the next lap in colour B');
  // On the beat's eighths at 128 BPM a lamp of two would flash every 117 ms:
  // the ring holds each lamp for two steps instead, and nobody outruns five.
  for (const n of [1, 2, 4]) {
    const onsets = new Array(n).fill(0);
    let last = new Array(n).fill(0);
    for (let ms = 0; ms < 4000; ms++) {
      const d = dims(draw('ring-strobe', { n, plan: plan([FL, FR, BR, BL].slice(0, n)), ...at(ms, 128, 8) }));
      d.forEach((v, i) => { if (v && !last[i]) onsets[i]++; });
      last = d;
    }
    for (const count of onsets) assert.ok(count / 4 <= MAX_LAMP_FLASH_HZ + 0.3, `${n} lamps: ${count / 4} flashes a second`);
  }
});

test('on a Hue lamp a flash is the colour at full falling to a floor, never black', () => {
  const noFlash = [true, false, false, false];
  const hue = (ms) => draw('ring-strobe', { plan: CORNERS, noFlash, ...at(ms) })[0];
  // The Hue lamp is the front left, last round the ring from the front (the plot top): its turn is the fourth step.
  // 125 ms on, not 100: 3.2 steps is not exact in binary, and the halfway level sits on a rounding edge.
  assert.deepStrictEqual(hue(1500), [RED, 255]);
  assert.strictEqual(hue(1625)[1], 121, 'on the way down 125 ms on');
  assert.strictEqual(hue(1500 + HUE_PULSE_MS)[1], HUE_PULSE_FLOOR);
  assert.strictEqual(hue(3400)[1], HUE_PULSE_FLOOR, 'and held there until its next turn');
  for (let ms = 0; ms < 4000; ms += 10) assert.ok(hue(ms)[1] >= HUE_PULSE_FLOOR, `${hue(ms)[1]} at ${ms} ms`);
  assert.deepStrictEqual(dims(draw('ring-strobe', { plan: CORNERS, noFlash, ...at(100) })).slice(1), [0, 0, 0], 'the pars still flash');
  // The flashes too.
  const all = new Array(8).fill(true);
  const flashed = draw('flashes', { n: 8, noFlash: all, ...at(0) });
  const i = brightest(flashed);
  assert.strictEqual(flashed[i][1], 255);
  assert.strictEqual(draw('flashes', { n: 8, noFlash: all, ...at(125) })[i][1], 121);
  assert.strictEqual(draw('flashes', { n: 8, noFlash: all, ...at(250) })[i][1], HUE_PULSE_FLOOR);
});

// The Hue strobe setting reaches the fork's own flash looks: 'flash' takes a
// Hue lamp as any other between flashes, 'pulse' (and a context that says
// nothing, as every call above) keeps its falling pulse.
test('ring strobe: with hueStrobe flash the Hue lamp is black between flashes; pulse or nothing keeps its 148', () => {
  const noFlash = [true, false, false, false];
  assert.strictEqual(draw('ring-strobe', { noFlash, hueStrobe: 'flash', ...at(100) })[0][1], 0, 'black between flashes');
  assert.strictEqual(draw('ring-strobe', { noFlash, hueStrobe: 'flash', ...at(0) })[0][1], 255, 'and flashed hard on its step');
  assert.strictEqual(draw('ring-strobe', { noFlash, hueStrobe: 'pulse', ...at(100) })[0][1], 148);
  assert.strictEqual(draw('ring-strobe', { noFlash, ...at(100) })[0][1], 148, 'absent means pulse');
  // Backlit, the Hue lamp parks on colour B like the pars rather than going black.
  const backlit = draw('ring-backlit', { noFlash, hueStrobe: 'flash', ...at(100) });
  assert.deepStrictEqual(backlit[0], [BLUE, BACKLIGHT]);
  assert.deepStrictEqual(backlit[0], draw('ring-backlit', { noFlash: null, ...at(100) })[0], 'exactly a par\'s backlight');
});

test('flashes: with hueStrobe flash a Hue lamp is cut to the look\'s bed like a par; pulse or nothing keeps its fall', () => {
  const all = new Array(8).fill(true);
  const lit = brightest(draw('flashes', { n: 8, noFlash: all, ...at(0) }));
  for (const ms of [0, 60, 125, 250]) {
    assert.deepStrictEqual(draw('flashes', { n: 8, noFlash: all, hueStrobe: 'flash', ...at(ms) }), draw('flashes', { n: 8, ...at(ms) }),
      `the same as pars at ${ms} ms`);
  }
  assert.strictEqual(draw('flashes', { n: 8, noFlash: all, hueStrobe: 'flash', ...at(125) })[lit][1], 14, 'cut to the bed');
  assert.strictEqual(draw('flashes', { n: 8, noFlash: all, hueStrobe: 'pulse', ...at(125) })[lit][1], 121);
  assert.strictEqual(draw('flashes', { n: 8, noFlash: all, ...at(125) })[lit][1], 121, 'absent means pulse');
});

test('ring backlit: the lit lamp in colour A, the rest parked on B', () => {
  const out = draw('ring-backlit', { plan: CORNERS, ...at(500) });
  // The second step lights the back right, the second round from the front (the plot top).
  assert.deepStrictEqual(out[2], [RED, 255]);
  for (const i of [0, 1, 3]) assert.deepStrictEqual(out[i], [BLUE, BACKLIGHT]);
  assert.deepStrictEqual(draw('ring-backlit', { plan: CORNERS, ...at(600) })[2], [BLUE, BACKLIGHT], 'and parked again after the flash');
});

test('fireworks: a burst on one lamp a step, never the same one twice running, dying away over a bar', () => {
  const first = draw('fireworks', { plan: CORNERS, ...at(0) });
  const o = brightest(first);
  assert.strictEqual(first[o][1], 255);
  assert.strictEqual(dims(first).filter((d) => d > 14).length, 1, 'one lamp bursts');
  const next = draw('fireworks', { plan: CORNERS, ...at(500) });
  assert.notStrictEqual(brightest(next), o);
  assert.ok(next[o][1] > 14 && next[o][1] < 255, `the first still dying away: ${next[o][1]}`);
  const spread = draw('fireworks', { plan: CORNERS, ...at(250) });
  assert.ok(spread.filter(([, d]) => d > 14).length > 1, 'the burst spreads to its neighbours');
  assert.ok(spread[o][1] > Math.max(...dims(spread).filter((_, i) => i !== o)), 'dimmer the farther they stand');
});

test('flashes: a scatter of lamps flashes hard on the step and is cut, no lamp over five a second', () => {
  const start = draw('flashes', { n: 16, ...at(0) });
  const lit = dims(start).filter((d) => d === 255).length;
  assert.ok(lit >= 2 && lit <= 10, `${lit} of 16`);
  assert.ok(dims(start).every((d) => d === 255 || d === 14));
  assert.ok(dims(draw('flashes', { n: 16, ...at(125) })).every((d) => d === 14), 'cut after a fifth of the step');
  assert.notDeepStrictEqual(dims(draw('flashes', { n: 16, ...at(500) })), dims(start), 'drawn afresh');
  const onsets = new Array(4).fill(0);
  let last = new Array(4).fill(0);
  for (let ms = 0; ms < 4000; ms++) {
    const d = dims(draw('flashes', { n: 4, ...at(ms, 128, 8) }));
    d.forEach((v, i) => { if (v === 255 && last[i] !== 255) onsets[i]++; });
    last = d;
  }
  for (const count of onsets) assert.ok(count / 4 <= MAX_LAMP_FLASH_HZ + 0.3, `${count / 4} flashes a second`);
});

test('swirl: the crest goes round the ring, a turn every eight steps', () => {
  const crest = (step) => brightest(draw('swirl', { plan: CORNERS, ...at(step * 500) }));
  // Clockwise from straight ahead, the front being the plot top.
  assert.deepStrictEqual([crest(1), crest(3), crest(5), crest(7)], [1, 2, 3, 0], 'front right, back right, back left, front left');
  assert.strictEqual(crest(9), 1, 'and round again');
});

// ── Through the layer ───────────────────────────────────────────────────────

test('the layer hands a placed rig its plan and its Hue lamps, and an unplaced rig neither', () => {
  const fixtures = [
    { position: { x: 80, y: 20 }, group: 'back', output: { protocol: 'hue', channel: 1 } },
    { position: { x: 10, y: 60 } },
    { position: { x: 45, y: 40 }, group: 'front' },
  ];
  const rig = buildRig(fixtures, () => null);
  const layout = rig.layout(null, 'stage');
  assert.deepStrictEqual(layout.fixtures.plan, { x: [0.1, 0.45, 0.8], y: [0.6, 0.4, 0.2], z: [0.5, 0.5, 0.5], group: [null, 'front', 'back'] },
    'in stage order, mid-room when no height is set');
  assert.deepStrictEqual(layout.fixtures.noFlash, [false, false, true]);
  assert.strictEqual(layout.units.plan, layout.fixtures.plan, 'a rig of pars: the units are the fixtures');
  assert.strictEqual(rig.layout(null, 'mirror').fixtures.plan, null, 'mirrored, the fold is the picture');
  const bare = buildRig([{}, {}, {}], () => null).layout(null, 'stage');
  assert.strictEqual(bare.fixtures.plan, null);
  assert.strictEqual(bare.units.plan, null);
  assert.strictEqual(bare.fixtures.noFlash, null);

  // A bar's cells each have their own place; laid per bar there is no plan.
  const bar = { id: 'party-bar', name: 'Party bar', channelCount: 12, channelMap: {},
    cells: [0, 1, 2, 3].map((i) => ({ channelMap: { red: i * 3, green: i * 3 + 1, blue: i * 3 + 2 } })) };
  const pixels = buildRig([{ position: { x: 20, y: 40 } }, { position: { x: 60, y: 40 }, geometry: { length: 30, angle: 0 }, profileId: bar.id }],
    (f) => (f.profileId === bar.id ? bar : null));
  const across = pixels.layout(null, 'stage');
  assert.strictEqual(across.units.plan.x.length, 5);
  assert.ok(new Set(across.units.plan.x.slice(1)).size === 4, 'the cells spread along the bar');
  assert.strictEqual(pixels.layout(null, 'bar').units.plan, null);
});

test('rendered through the layer, a Hue lamp in the ring is pulsed where a par is flashed', () => {
  const fixtures = [
    { position: { x: 10, y: 90 }, output: { protocol: 'hue', channel: 1 } },
    { position: { x: 90, y: 90 } },
    { position: { x: 90, y: 10 } },
    { position: { x: 10, y: 10 } },
  ];
  const rig = buildRig(fixtures, () => null);
  const look = { pattern: 'ring-strobe', colors: DUO, split: null, pixelMap: 'stage' };
  const render = (beatPos) => {
    const out = [];
    renderLayer(rig, look, {
      beatPos, step: Math.floor(beatPos), anchor: 0, division: 1, phase: 0, expression: { ...EXPRESSION_REST },
      dynamicsOn: false, bpm: 120, fixtureCount: 4, twinkle: [0, 0, 0, 0],
    }, (u, colour, dim) => { out[u] = dim; });
    return out;
  };
  // The Hue lamp stands back left (plot [10, 90]; the front is the plot top), third round the ring.
  assert.deepStrictEqual(render(0), [40, 0, 255, 0], 'the ring starts front right, the Hue lamp at its floor');
  assert.deepStrictEqual(render(2), [255, 0, 0, 0]);
  assert.deepStrictEqual(render(2.25), [121, 0, 0, 0], 'the Hue lamp on the way down 125 ms on, the pars black');
  assert.deepStrictEqual(render(3.2), [40, 0, 0, 0], 'held at the floor while the ring moves on');
});
