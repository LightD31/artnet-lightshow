import { z } from 'zod';
import type { Colour } from '../../types/rig.ts';
import { tempoOf } from '../look-math.ts';
import { MAX_LAMP_FLASH_HZ } from '../patterns.ts';
import { ldjFrameAt } from './ldj-rotation.ts';
import { hsbToColour, LDJ_RANDOM_HUES } from './palette.ts';
import { registerKind } from './registry.ts';

export const BITMAP_PATTERNS = ['SolidTest', 'SmoothLoop', 'SmoothMirror', 'VertLines',
  'ThickPaletteLoop', 'ThinPaletteLoop', 'ThickPaletteMirror', 'ThinPaletteMirror',
  'ThickBandedLoop', 'ThickBandedMirror', 'ThinBandedLoop', 'ThinBandedMirror',
  'SineWave', 'TriangleWave', 'DiagonalLines', 'SolidBGSineWave', 'SolidBGTriangleWave',
  'SolidBGDiagonalLines', 'SolidBlackBGSineWave', 'SolidBlackBGTriangleWave', 'SolidBlackBGDiagonalLines', 'OGGrooveWave'] as const;
export type BitmapPattern = typeof BITMAP_PATTERNS[number];
// Generated pixel rows are immutable, so identical rows may share an array.
export interface BitmapImage { width: number; height: number; rows: number[][] }

const f32 = Math.fround;
const pack = (colour: Colour): number => (colour.r << 16) | (colour.g << 8) | colour.b;
const unpack = (pixel: number): Colour => ({ r: (pixel >>> 16) & 255, g: (pixel >>> 8) & 255, b: pixel & 255, w: 0, a: 0, uv: 0 });
const mod = (value: number, length: number): number => ((value % length) + length) % length;
const RAINBOW = LDJ_RANDOM_HUES.map((hue) => pack(hsbToColour(hue / 360, 1, 1)));
// Repeated addition preserves quarter-turn pixels that division would round differently.
const LAST_T = .99999999, SMOOTH_STEP = .005;
// At 300 BPM, crossing 48 pixels can exceed the flash limit and needs acknowledgement.
const RAPID_SPEED = MAX_LAMP_FLASH_HZ * 50.7 * 48 / (22 * 300);

// Float32 mixing and HSV quantization preserve bitmap colour bytes.
export function bitmapBlend(a: number, b: number, t: number): number {
  const left = f32(1 - t), right = f32(1 - (1 - t)), sum = f32(left + right);
  const wa = f32(left / sum), wb = f32(right / sum);
  if (wa <= 0) return b;
  if (wb <= 0) return a;
  const byte = (shift: number) => Math.trunc(((((a >>> shift) & 255) / 255) * wa + (((b >>> shift) & 255) / 255) * wb) * 255);
  const r = byte(16), g = byte(8), blue = byte(0);
  const low = Math.min(r, g, blue), high = Math.max(r, g, blue), delta = high - low;
  let hue = 0;
  if (delta) {
    hue = high === r ? f32((g - blue) / delta)
      : high === g ? f32(f32((blue - r) / delta) + 2) : f32(f32((r - g) / delta) + 4);
    hue = f32(hue * 60);
    if (hue < 0) hue = f32(hue + 360);
  }
  const saturation = Math.trunc((high ? f32(delta / high) : 0) * 65535);
  const value = Math.trunc(f32(high / 255) * 65535);
  return pack(hsbToColour(Math.trunc(hue) / 360, saturation / 65535, value / 65535));
}

// Random entries use the fixed rainbow so rerolls do not rebuild the picture.
function picturePalette(pattern: BitmapPattern, colours: readonly Colour[], random: boolean): number[] {
  const palette = random ? [...RAINBOW] : colours.map(pack);
  while (palette.length < 2) palette.push(0);
  if (pattern.startsWith('SolidBlackBG')) palette.unshift(0);
  return palette;
}

function repeatedRow(row: number[], height = 40): BitmapImage {
  // Row aliases are preserved inside each clone to avoid copying identical rows repeatedly.
  return { width: row.length, height, rows: Array.from({ length: height }, () => row) };
}

// Do not repeat the far palette entry when mirroring the sequence.
function sequence(count: number, mirror: boolean, transitions: boolean): number[] {
  const values = Array.from({ length: count }, (_, i) => i);
  if (mirror) for (let i = count - 2; i >= (transitions ? 0 : 1); i--) values.push(i);
  else if (transitions) values.push(0);
  return values;
}

// Wrapped bands have inclusive edges, unlike a shortest-distance test.
function diagonalBand(row: number, line: number, height: number): boolean {
  const half = height / 5, low = row - half, high = row + half;
  let wrapLow = -1, wrapHigh = -1;
  if (low < 0) { wrapLow = height - 1 + low; wrapHigh = height - 1; }
  if (high >= height) { wrapLow = 0; wrapHigh = high - height + 1; }
  return (line >= low && line <= high) || (line >= wrapLow && line <= wrapHigh);
}

function raster(pattern: BitmapPattern, palette: number[]): BitmapImage {
  if (pattern === 'SolidTest') return repeatedRow(new Array<number>(40).fill(palette[0]));
  const count = palette.length, mirror = pattern.endsWith('Mirror'), segment = pattern.startsWith('Thick') ? 48 : 24;
  const row: number[] = [];
  if (pattern.includes('Palette')) {
    for (const index of sequence(count, mirror, false)) row.push(...new Array<number>(segment).fill(palette[index]));
    return repeatedRow(row);
  }
  if (pattern.startsWith('Smooth') || pattern.includes('Banded')) {
    const banded = pattern.includes('Banded'), path = sequence(count, mirror, true);
    for (let i = 0; i < path.length - 1; i++) {
      for (let t = 0; t <= LAST_T; t += banded ? .2 : SMOOTH_STEP) {
        const pixel = bitmapBlend(palette[path[i]], palette[path[i + 1]], t);
        if (banded) row.push(...new Array<number>(segment).fill(pixel));
        else row.push(pixel);
      }
    }
    return repeatedRow(row);
  }
  if (pattern === 'VertLines') {
    for (const colour of palette) for (let t = 0; t <= LAST_T; t += .025) row.push(t < .4 ? colour : 0);
    return repeatedRow(row);
  }
  if (pattern === 'OGGrooveWave') {
    // Each colour swells from black and back on its own, never into the next.
    for (const colour of palette) for (let t = 0; t <= LAST_T; t += SMOOTH_STEP) {
      row.push(bitmapBlend(colour, 0, (Math.cos((t * 2) * Math.PI) + 1) / 2));
    }
    return repeatedRow(row);
  }

  const triangle = pattern.endsWith('TriangleWave'), diagonal = pattern.endsWith('DiagonalLines');
  const height = triangle ? 100 : diagonal ? 60 : 40;
  const solid = pattern.startsWith('Solid'), segments = solid ? count - 1 : count, shift = Math.floor(count / 2);
  const width = segments * 200;
  const rows = Array.from({ length: height }, () => new Array<number>(width).fill(palette[0]));
  let x = 0, line = height / 2, direction = 1;
  for (let s = 0; s < segments; s++) {
    const from = solid ? s + 1 : s;
    const to = solid ? (s + 1) % segments + 1 : (s + 1) % count;
    for (let t = 0; t <= LAST_T; t += SMOOTH_STEP) {
      const background = solid ? palette[0] : bitmapBlend(palette[from], palette[to], t);
      const foreground = solid ? bitmapBlend(palette[from], palette[to], t)
        : bitmapBlend(palette[(from + shift) % count], palette[(to + shift) % count], t);
      if (!triangle && !diagonal) {
        const phase = solid ? t + s : t;
        line = Math.trunc(((Math.cos((phase * 2) * Math.PI) * .598 + 1) / 2) * height);
      }
      for (let y = 0; y < height; y++) {
        const inside = diagonal ? diagonalBand(y, line, height) : Math.abs(line - y) <= (triangle ? 20 : 8);
        rows[y][x] = inside ? foreground : background;
      }
      x++;
      if (triangle) {
        line += direction;
        if (line >= height) { line = height - 1; direction = -1; }
        else if (line < 0) { line = 1; direction = 1; }
      } else if (diagonal) {
        line -= .6;
        if (line >= height) line = 0;
        else if (line <= 0) line = height - 1;
      }
    }
  }
  return { width, height, rows };
}

export function buildBitmap(pattern: BitmapPattern, palette: readonly Colour[], random = false): BitmapImage {
  return raster(pattern, picturePalette(pattern, palette, random));
}

// Both axes use picture height; width only controls the scroll period.
export function sampleBitmap(image: BitmapImage, pattern: BitmapPattern, u: number, v: number, scroll: number): Colour {
  const diagonal = pattern.endsWith('DiagonalLines');
  const x = diagonal ? -u : u, y = diagonal ? v : -v;
  const row = mod(Math.floor((y + 1) * image.height / 2), image.height);
  const column = mod(Math.floor((x + 1) * image.height / 2) + mod(scroll, image.width), image.width);
  return unpack(image.rows[row][column]);
}

// Scroll from launch time so seeks and late first renders land on the same pixels.
export function bitmapScroll(nowMs: number, originMs: number, bpm: number, speed: number, pattern: BitmapPattern): number {
  const rate = tempoOf(bpm) * speed / 50.7 / (pattern === 'VertLines' ? 2 : 1);
  const scroll = Math.floor(ldjFrameAt(nowMs, originMs) * rate);
  if (!Number.isSafeInteger(scroll)) throw new RangeError('Bitmap scroll exceeds the safe integer range');
  return scroll;
}

// Only what a later render cannot recompute: the launch and the cached picture.
interface BitmapState {
  // Palette edits retain launch time so scrolling does not restart.
  originMs: number;
  key: string; image: BitmapImage | null;
}

const schema = z.object({ pattern: z.enum(BITMAP_PATTERNS), speed: z.number().nonnegative().default(1) }).strict();

registerKind<z.infer<typeof schema>, BitmapState>({
  kind: 'ldj.bitmap', app: 'ldj', schema, defaults: { params: { pattern: 'SmoothLoop', speed: 1 } }, stateful: true,
  rapidFlashWhen: (params) => params.speed > RAPID_SPEED,
  init: (_params, _room, frame) => ({ originMs: frame.startedAtMs ?? frame.nowMs, key: '', image: null }),
  render(params, state, room, frame, out) {
    const scroll = bitmapScroll(frame.nowMs, state.originMs, frame.bpm, params.speed, params.pattern);
    const random = !frame.paletteOverride?.length && Boolean(frame.spec.palette?.some((entry) => typeof entry === 'object' && entry.random));
    const palette = picturePalette(params.pattern, frame.palette, random);
    const key = `${params.pattern}:${palette.join(',')}`;
    if (state.image === null || state.key !== key) { state.image = raster(params.pattern, palette); state.key = key; }
    for (let slot = 0; slot < room.n; slot++) {
      out[slot] = { colour: sampleBitmap(state.image, params.pattern, room.u[slot], room.v[slot], scroll), level: 1, strength: 1 };
    }
  },
});
