import test from 'node:test';
import assert from 'node:assert/strict';
import { BITMAP_PATTERNS, bitmapBlend, buildBitmap, sampleBitmap } from '../../src/shared/effects/ldj-bitmap.ts';
import { kindOf, validateSpec } from '../../src/shared/effects/registry.ts';
import { LDJ_FRAME_MS } from '../../src/shared/effects/ldj-engine.ts';
import { parseHex } from '../../src/shared/effects/palette.ts';
import { harness, row, square, RED, CYAN } from '../helpers/ldj-harness.js';

const BLUE = parseHex('#0000FF'), GREEN = parseHex('#00FF00'), BLACK = parseHex('#000000');
const pack = (c) => c.r * 65536 + c.g * 256 + c.b;
const at = (frame, bpm = 120, origin = 0) => ({ nowMs: origin + frame * LDJ_FRAME_MS, beatPos: frame / 11, bpm });
const rowsAt = (image, x, pixel) => image.rows.flatMap((row, y) => (pixel === undefined ? row[x] !== 0 : row[x] === pixel) ? [y] : []);
const band = (centre, half, height) => Array.from({ length: Math.min(height - 1, centre + half) - Math.max(0, centre - half) + 1 }, (_, i) => Math.max(0, centre - half) + i);
const redBlue = { spec: { palette: ['#FF0000', '#0000FF'] } };

test('the bitmap kind exposes exactly the twenty-two patterns and strict finite speed defaults', () => {
  assert.deepEqual(BITMAP_PATTERNS, ['SolidTest', 'SmoothLoop', 'SmoothMirror', 'VertLines',
    'ThickPaletteLoop', 'ThinPaletteLoop', 'ThickPaletteMirror', 'ThinPaletteMirror',
    'ThickBandedLoop', 'ThickBandedMirror', 'ThinBandedLoop', 'ThinBandedMirror',
    'SineWave', 'TriangleWave', 'DiagonalLines', 'SolidBGSineWave', 'SolidBGTriangleWave',
    'SolidBGDiagonalLines', 'SolidBlackBGSineWave', 'SolidBlackBGTriangleWave', 'SolidBlackBGDiagonalLines', 'OGGrooveWave']);
  assert.ok(kindOf('ldj.bitmap')?.stateful);
  assert.equal(kindOf('ldj.bitmap').rapidFlash, undefined);
  for (const pattern of BITMAP_PATTERNS) {
    const spec = validateSpec({ kind: 'ldj.bitmap', params: { pattern } });
    assert.equal(spec.params.speed, 1); assert.deepEqual(validateSpec(spec), spec);
  }
  for (const params of [{ pattern: 'missing' }, { speed: -1 }, { speed: Infinity }, { speed: NaN }, { speed: '1' }, { unsupported: true }]) {
    assert.throws(() => validateSpec({ kind: 'ldj.bitmap', params }), JSON.stringify(params));
  }
  assert.equal(validateSpec({ kind: 'ldj.bitmap', params: { speed: 0 } }).params.speed, 0);
});

test('native bitmap blends preserve endpoints and their integer hue quantization', () => {
  // Independent vectors: truncated RGB bytes, whole-degree hue, then native HSV to RGB.
  const A = parseHex('#2479C3'), B = parseHex('#D64A35');
  for (const [a, b, t, expected] of [[RED, BLUE, 0, '#FF0000'], [RED, BLUE, .2, '#CC0033'],
    [RED, BLUE, .5, '#7F007F'], [RED, BLUE, .735, '#4100BB'], [RED, BLUE, 1, '#0000FF'],
    [A, B, 0, '#2479C3'], [A, B, .2, '#4770A6'], [A, B, .5, '#7D617C'],
    [A, B, .735, '#A6565A'], [A, B, 1, '#D64A35']]) {
    assert.equal(bitmapBlend(pack(a), pack(b), t), pack(parseHex(expected)), `${t}: ${JSON.stringify(a)}`);
  }
  assert.equal(bitmapBlend(pack(RED), pack(RED), .24), 0xFE0000, 'equal colours still pass through intermediate float weights');
});

test('the bitmap is generated once per (pattern, palette) and sampled by lamp position', () => {
  // u −1, 0 and +1 span the picture's height of 40 px, not its 400 px period.
  const h = harness('ldj.bitmap', row(3), { params: { pattern: 'SmoothLoop' }, ...redBlue });
  const first = h.draw(at(0)), image = h.state().image;
  assert.deepEqual([image.width, image.height], [400, 40]);
  assert.deepEqual(first.map((slot) => pack(slot.colour)), [0, 20, 40].map((x) => image.rows[20][x]));
  assert.deepEqual(first[0].colour, RED); assert.deepEqual(first[2].colour, parseHex('#CC0033'));
  assert.equal(new Set(first.map((slot) => pack(slot.colour))).size, 3);
  assert.notEqual(pack(first[2].colour), image.rows[20][399]);
  for (const slot of first) assert.deepEqual([slot.colour.w, slot.colour.a, slot.colour.uv, slot.level, slot.strength], [0, 0, 0, 1, 1]);
  for (const frame of [1, 2, 22, 500]) { h.draw(at(frame)); assert.strictEqual(h.state().image, image); }
});

test('all generator dimensions include actual segment widths and mirror endpoint order', () => {
  const expected = [[40,40], [600,40], [800,40], [120,40], [144,40], [72,40], [192,40], [96,40],
    [720,40], [960,40], [360,40], [480,40], [600,40], [600,100], [600,60],
    [400,40], [400,100], [400,60], [600,40], [600,100], [600,60], [600,40]];
  BITMAP_PATTERNS.forEach((pattern, i) => {
    const image = buildBitmap(pattern, [RED, GREEN, BLUE]);
    assert.deepEqual([image.width, image.height], expected[i], pattern);
    assert.equal(image.rows.length, image.height);
    assert.ok(image.rows.every(row => row.length === image.width));
  });
  const eight = [RED, GREEN, BLUE, CYAN, RED, GREEN, BLUE, CYAN];
  assert.equal(buildBitmap('ThickBandedMirror', eight).width, 3360);
  assert.deepEqual([buildBitmap('SmoothMirror', eight).width, buildBitmap('ThickPaletteMirror', eight).width], [2800, 672]);
  const triangle = buildBitmap('SolidBlackBGTriangleWave', eight);
  assert.deepEqual([triangle.width, triangle.height], [1600, 100]);
});

test('palette segments and mirrors neither duplicate terminal blocks nor blend their plateaus', () => {
  for (const [pattern, width] of [['ThickPaletteMirror', 48], ['ThinPaletteMirror', 24]]) {
    const image = buildBitmap(pattern, [RED, GREEN, BLUE]);
    assert.deepEqual([0, 1, 2, 3].map(i => image.rows[0][i * width]), [RED, GREEN, BLUE, GREEN].map(pack));
    for (let i = 0; i < 4; i++) assert.equal(image.rows[0][i * width], image.rows[0][(i + 1) * width - 1]);
  }
  const smooth = buildBitmap('SmoothMirror', [RED, GREEN, BLUE]);
  assert.deepEqual([0,200,400,600].map(x => smooth.rows[0][x]), [RED, GREEN, BLUE, GREEN].map(pack));
  const loop = buildBitmap('SmoothLoop', [RED, BLUE]);
  assert.deepEqual([0, 100, 200, 300].map((x) => loop.rows[0][x]), [pack(RED), 0x7F007F, pack(BLUE), 0x7F007F]);
  const banded = buildBitmap('ThinBandedLoop', [RED, BLUE]);
  assert.equal(banded.rows[0][23], pack(RED));
  assert.equal(banded.rows[0][24], 0xCC0033); assert.equal(banded.rows[0][47], 0xCC0033);
  assert.equal(new Set([0, 24, 48, 72, 96].map((x) => banded.rows[0][x])).size, 5);
  assert.equal(banded.rows[0][120], pack(BLUE));
});

test('sine raster includes its edges and keeps repeated-add quarter-boundary pixels', () => {
  // Summing 0.005 lands just past each quarter turn; x / 200 would move these rows.
  const image = buildBitmap('SolidBGSineWave', [BLACK, RED]);
  for (const [x, centre] of [[0,31], [50,19], [100,8], [150,20], [199,31]]) assert.deepEqual(rowsAt(image, x, pack(RED)), band(centre, 8, 40));
  const smooth = buildBitmap('SineWave', [RED, GREEN, BLUE]);
  assert.equal(smooth.rows[31][0], pack(GREEN)); assert.equal(smooth.rows[0][0], pack(RED));
  assert.equal(smooth.rows[31][200], pack(BLUE)); assert.equal(smooth.rows[0][200], pack(GREEN));
});

test('triangle raster duplicates its high endpoint but visits zero only once', () => {
  const image = buildBitmap('SolidBGTriangleWave', [BLACK, RED, RED]);
  for (const [x, centre] of [[0,50], [48,98], [49,99], [50,99], [51,98], [149,0], [150,1], [151,2], [200,51]]) {
    assert.deepEqual(rowsAt(image, x), band(centre, 20, 100), `x ${x}`);
  }
});

test('diagonal raster preserves repeated subtraction and the inclusive wrapped band', () => {
  const image = buildBitmap('SolidBGDiagonalLines', [BLACK, RED]);
  assert.deepEqual(rowsAt(image, 0, pack(RED)), Array.from({ length: 25 }, (_, i) => i + 18));
  assert.ok(rowsAt(image, 49, pack(RED)).includes(0)); assert.ok(rowsAt(image, 49, pack(RED)).includes(59));
  assert.deepEqual(rowsAt(image, 50, pack(RED)), [...Array.from({ length: 12 }, (_, i) => i), ...Array.from({ length: 13 }, (_, i) => i + 47)]);
  assert.equal(image.rows[46][50], 0); assert.equal(image.rows[13][50], 0);
  assert.equal(image.rows[17][100], pack(RED)); assert.equal(image.rows[41][100], 0);
});

test('vertical lines have sixteen lit columns and groove dims the same colour to black', () => {
  const vertical = buildBitmap('VertLines', [RED, BLUE]);
  assert.deepEqual([0,15,16,39,40].map(x => vertical.rows[0][x]), [pack(RED), pack(RED), 0, 0, pack(BLUE)]);
  const groove = buildBitmap('OGGrooveWave', [RED, BLUE]);
  assert.equal(groove.rows[0][0], 0); assert.equal(groove.rows[0][100], pack(RED));
  assert.equal(groove.rows[0][199], 0); assert.equal(groove.rows[0][200], 0); assert.equal(groove.rows[0][300], pack(BLUE));
  assert.equal(groove.rows[0][50] & 0xFFFF, 0);
});

test('singletons are copied and padded with black before a black-background prefix', () => {
  const palette = [RED];
  const solid = buildBitmap('ThickPaletteLoop', palette);
  assert.equal(solid.width, 96); assert.equal(solid.rows[0][48], 0); assert.deepEqual(palette, [RED]);
  const black = buildBitmap('SolidBlackBGSineWave', palette);
  assert.equal(black.width, 400); assert.equal(black.rows[31][0], pack(RED));
  assert.equal(black.rows[0][0], 0); assert.equal(black.rows[31][200], 0);
  const whiteDie = buildBitmap('SolidTest', [parseHex('#123456FF')]);
  assert.deepEqual(sampleBitmap(whiteDie, 'SolidTest', 0, 0, 0), parseHex('#123456'));
});

test('sampling uses height for both axes, exact orientation, floor and positive wrapping', () => {
  const image = { width: 8, height: 4, rows: Array.from({ length: 4 }, (_, y) => Array.from({ length: 8 }, (_, x) => y * 16 + x)) };
  const value = (pattern, u, v, scroll = 0) => sampleBitmap(image, pattern, u, v, scroll).b;
  assert.deepEqual([-1,0,1].map(u => value('SmoothLoop', u, 0)), [32,34,36]);
  assert.equal(value('SmoothLoop', 0, 1), 2); assert.equal(value('SmoothLoop', 0, -1), 2);
  assert.equal(value('SmoothLoop', .49, .5), 18); assert.equal(value('SmoothLoop', .5, .5), 19);
  assert.equal(value('DiagonalLines', .5, .5), 49); assert.equal(value('SolidBlackBGDiagonalLines', .5, .5), 49);
  assert.equal(value('SmoothLoop', -1, 0, -1), 39); assert.equal(value('SmoothLoop', -1, 0, 8), 32);
  assert.equal(value('SmoothLoop', 1, 0, Number.MAX_SAFE_INTEGER), 35, 'wrap the safe scroll before adding the spatial offset');
});

test('the picture scrolls BPM/50.7 px per LDJ frame', () => {
  const h = harness('ldj.bitmap', row(1), { params: { pattern: 'SmoothLoop' }, ...redBlue });
  [0, 1, 2, 3, 22].forEach((frame, i) => {
    const slot = h.draw(at(frame))[0], scroll = [0, 2, 4, 7, 52][i];
    // The centre lamp reads column 20 of the picture, moved by whole pixels.
    assert.equal(h.state().scroll, scroll); assert.equal(pack(slot.colour), h.state().image.rows[20][20 + scroll]);
  });
  // Current tempo times the whole frame count, as Light DJ does: a tap to 128 jumps at once.
  h.draw(at(22, 128)); assert.equal(h.state().scroll, 55);
});

test('VertLines scrolls at half speed', () => {
  const h = harness('ldj.bitmap', row(1), { params: { pattern: 'VertLines' }, ...redBlue });
  [0, 1, 2, 3, 22].forEach((frame, i) => {
    const slot = h.draw(at(frame))[0], scroll = [0, 1, 2, 3, 26][i];
    assert.equal(h.state().scroll, scroll); assert.equal(pack(slot.colour), h.state().image.rows[20][(20 + scroll) % 80]);
  });
  h.draw(at(22, 128)); assert.equal(h.state().scroll, 27);
});

test('speed scales the rate before flooring, zero freezes, and a late first render keeps its launch', () => {
  const h = harness('ldj.bitmap', row(1), { params: { pattern: 'SmoothLoop', speed: .5 }, startedAtMs: 250 });
  h.draw(at(3, 120, 250)); assert.deepEqual([h.state().frame, h.state().scroll], [3, 3]);
  h.inst.spec.params.speed = 0; h.draw(at(100, 120, 250)); assert.deepEqual([h.state().frame, h.state().scroll], [100, 0]);
  const late = harness('ldj.bitmap', row(1), { params: { pattern: 'SmoothLoop' }, startedAtMs: 1000 });
  late.draw(at(22.5, 120, 1000)); assert.deepEqual([late.state().frame, late.state().scroll], [22, 52]);
});

test('subframes hold and repeated or backward samples reproduce their exact bitmap pixels', () => {
  const h = harness('ldj.bitmap', row(2), { params: { pattern: 'SmoothLoop' }, ...redBlue });
  const initial = h.draw(at(0)); assert.notDeepEqual(initial[0].colour, initial[1].colour);
  assert.deepEqual(h.draw(at(.5)), initial);
  const next = h.draw(at(1)); assert.notDeepEqual(next, initial);
  assert.deepEqual(h.draw(at(1)), next); h.draw(at(100)); assert.deepEqual(h.draw(at(0)), initial);
  assert.deepEqual(harness('ldj.bitmap', row(2), { params: { pattern: 'SmoothLoop' }, ...redBlue }).draw(at(1)), next);
});

test('content cache survives cloned input arrays, tempo and geometry changes but replaces changed content', () => {
  const room = row(2), h = harness('ldj.bitmap', room, { params: { pattern: 'SmoothLoop' }, ...redBlue });
  h.draw(at(0)); const image = h.state().image;
  room.u[0] = .5; h.draw(at(1)); assert.strictEqual(h.state().image, image);
  h.inst.spec.palette = ['#FF0000', '#0000FF']; h.draw(at(22, 128));
  assert.strictEqual(h.state().image, image); assert.equal(h.state().scroll, 55);
  h.inst.spec.params.pattern = 'ThinPaletteLoop'; h.draw(at(23));
  assert.notStrictEqual(h.state().image, image); assert.equal(h.state().frame, 23);
  const changed = h.state().image; h.inst.spec.palette = ['#00FF00']; h.draw(at(24));
  assert.notStrictEqual(h.state().image, changed); assert.equal(h.state().frame, 24);
});

test('any effective random entry uses one fixed rainbow while fixed overrides suppress it', () => {
  const h = harness('ldj.bitmap', row(1), { params: { pattern: 'ThickPaletteLoop' }, spec: { palette: ['#123456', { random: true }] } });
  h.draw(at(0)); const rainbow = h.state().image;
  assert.equal(rainbow.width, 384); assert.equal(rainbow.rows[0][0], pack(RED)); assert.equal(rainbow.rows[0][48], 0xFF9900);
  h.draw({ ...at(10), roll: 20 }); assert.strictEqual(h.state().image, rainbow);
  const prepared = h.stepper.palette(h.inst.id, h.inst.spec, 0); assert.deepEqual(prepared.pending, []);
  h.draw({ ...at(11), paletteOverride: [CYAN] }); assert.equal(h.state().image.width, 96);
  assert.equal(h.state().image.rows[0][0], pack(CYAN));
  h.draw(at(12)); assert.deepEqual(h.state().image, rainbow);
});

test('bitmap checkpoint clones preserve row aliases without sharing mutable state with the original', () => {
  const h = harness('ldj.bitmap', square(), { params: { pattern: 'SmoothMirror' } });
  h.draw(at(3)); const clone = h.stepper.clone(), original = h.state().image;
  const copied = clone.get(h.inst.id, () => null, 0).image;
  assert.strictEqual(original.rows[0], original.rows[1]); assert.strictEqual(copied.rows[0], copied.rows[1]);
  assert.notStrictEqual(original.rows[0], copied.rows[0]);
  assert.deepEqual(h.draw(at(7), clone), h.draw(at(7)));
  // A content change seen only by the clone replaces the clone's picture alone.
  h.draw({ ...at(8), paletteOverride: [CYAN] }, clone);
  assert.strictEqual(h.state().image, original); assert.equal(clone.get(h.inst.id, () => null, 0).image.rows[0][0], pack(CYAN));
  copied.rows[0][0] = -1; assert.notEqual(original.rows[0][0], -1);
});

test('hand-built frames retain their first-time origin and the outer renderer applies brightness once', () => {
  const def = kindOf('ldj.bitmap'), spec = validateSpec({ kind: 'ldj.bitmap' }), room = row(1);
  const frame = { nowMs: 123, bpm: 120, palette: [RED, BLUE], paletteOverride: null, spec };
  const state = def.init(spec.params, room, frame), out = [];
  def.render(spec.params, state, room, { ...frame, nowMs: 123 + 3 * LDJ_FRAME_MS }, out);
  assert.equal(state.scroll, 7); assert.equal(state.originMs, 123);
  const h = harness('ldj.bitmap', room, { params: { pattern: 'SolidTest' }, palette: [RED], spec: { brightness: .4 } });
  assert.deepEqual(h.draw(at(0))[0], { colour: RED, level: .4, strength: 1 });
});

test('every pattern renders finite values on one lamp with one colour', () => {
  for (const pattern of BITMAP_PATTERNS) for (const n of [0, 1]) {
    const h = harness('ldj.bitmap', row(n), { params: { pattern }, palette: [RED] });
    for (const frame of [0, .5, 1, 22, 1000, 1e9]) {
      const output = h.draw(at(frame)); assert.equal(output.length, n);
      for (const slot of output) {
        assert.equal(slot.level, 1); assert.equal(slot.strength, 1);
        assert.ok(Object.values(slot.colour).every(value => Number.isInteger(value) && value >= 0 && value <= 255), pattern);
      }
    }
    if (n) assert.ok(h.state().image.width > 0 && h.state().image.height > 0, pattern);
  }
});

test('nonfinite clocks and unsafe offsets throw; an invalid tempo reads as 120 like the other lamp kernels', () => {
  const h = harness('ldj.bitmap', row(1));
  for (const input of [{ nowMs: Infinity, bpm: 120 }, { nowMs: -Infinity, bpm: 120 }, { nowMs: NaN, bpm: 120 },
    { nowMs: 1e30, bpm: 120 }, { nowMs: LDJ_FRAME_MS, bpm: 1e30 }]) assert.throws(() => h.draw({ ...input, beatPos: 0 }), RangeError, JSON.stringify(input));
  for (const bpm of [NaN, Infinity, 0, -128]) {
    const t = harness('ldj.bitmap', row(1)); t.draw(at(3, bpm)); assert.equal(t.state().scroll, 7, String(bpm));
  }
});
