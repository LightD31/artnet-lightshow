// These looks sample a fixed 22 Hz phase. Their noise field belongs to the
// instance, so a cloned rehearsal resumes the same colours and motion.

import { z } from 'zod';
import type { Colour } from '../../types/rig.ts';
import { hash01 } from './hash.ts';
import { LDJ_FRAME_MS } from './ldj-engine.ts';
import { hsbToColour, LDJ_RANDOM_HUES } from './palette.ts';
import { registerKind } from './registry.ts';
import type { EffectFrame, Seed } from './types.ts';

const f32 = Math.fround;
const BLACK: Colour = { r: 0, g: 0, b: 0, w: 0, a: 0, uv: 0 };
const RAINBOW = LDJ_RANDOM_HUES.map((hue) => hsbToColour(hue / 360, 1, 1));
const wrap = (angle: number) => ((angle % 360) + 360) % 360;

export const continuousSchema = z.object({ beats: z.number().positive().default(32) }).strict();

/** Launch-relative whole lamp frames, including frame zero on a late first sample. */
export function ldjFrameAt(nowMs: number, originMs: number): number {
  if (!Number.isFinite(nowMs) || !Number.isFinite(originMs)) throw new RangeError('Lamp clocks must be finite');
  const frame = Math.max(0, Math.floor((nowMs - originMs) / LDJ_FRAME_MS + 1e-9));
  if (!Number.isSafeInteger(frame)) throw new RangeError('Lamp frame count exceeds the safe integer range');
  return frame;
}

/** Whether the chosen input is random, before its resolved colour hides that distinction. */
function randomInput(frame: EffectFrame, index: number): boolean {
  if (frame.paletteOverride?.length || !frame.spec.palette?.length) return false;
  const entries = frame.spec.palette;
  const entry = entries[((index % entries.length) + entries.length) % entries.length];
  return typeof entry === 'object' && entry.random === true;
}

/** RGB interpolation is kept separate from external effect and fixture brightness. */
export function mixColours(a: Colour, b: Colour, weightA: number): Colour {
  const mix = (key: keyof Colour) => Math.round((a[key] ?? 0) * weightA + (b[key] ?? 0) * (1 - weightA));
  return { r: mix('r'), g: mix('g'), b: mix('b'), w: mix('w'), a: mix('a'), uv: mix('uv') };
}

/** A repeatable gradient field, with both edges of the requested 300-unit extent included. */
export function createNoiseField(seed: Seed): number[][] {
  let random = (BigInt(Math.floor(hash01(seed, 61, 0) * 2 ** 32)) << 16n) | 0x330en;
  const lattice = Array.from({ length: 512 }, () => {
    random = (random * 25214903917n + 11n) & ((1n << 48n) - 1n);
    return Math.floor(Number(random) / 2 ** 48 * 255);
  });
  // Every operation here is a lamp-engine float, including the grid inputs.
  const fade = (t: number) => f32(f32(f32(t * t) * t) * f32(f32(t * f32(f32(6 * t) - 15)) + 10));
  const lerp = (a: number, b: number, t: number) => f32(a + f32(t * f32(b - a)));
  const gradient = (hash: number, x: number, y: number) => f32((hash & 1 ? -x : x) + (hash & 2 ? -y : y));
  const floor = (n: number) => n > 0 ? Math.trunc(n) : Math.trunc(f32(n - 1));
  const noise = (x: number, y: number) => {
    const ix = floor(x), iy = floor(y), a = ix & 255, b = iy & 255;
    const dx = f32(x - ix), dy = f32(y - iy), fx = fade(dx), fy = fade(dy);
    const left = lattice[a] + b, right = lattice[a + 1] + b;
    const low = lerp(gradient(lattice[left], dx, dy), gradient(lattice[right], f32(dx - 1), dy), fx);
    const high = lerp(gradient(lattice[left + 1], dx, f32(dy - 1)), gradient(lattice[right + 1], f32(dx - 1), f32(dy - 1)), fx);
    return f32(f32(lerp(low, high, fy) + 1) / 2);
  };
  return Array.from({ length: 301 }, (_, x) => Array.from({ length: 301 }, (_, y) => noise(f32(x / 30), f32(y / 30))));
}

interface RotationState {
  originMs: number; frame: number; angle: number; gradient: number;
  nextAngle: number; nextGradient: number; noise: number[][] | null;
}

for (const name of ['Swirl', 'Rotation', 'Beacon', 'Perlin', 'NorthernLights']) {
  const noisy = name === 'Perlin' || name === 'NorthernLights';
  registerKind({
    kind: `ldj.${name}`, app: 'ldj', schema: continuousSchema, defaults: { params: { beats: 32 } }, stateful: true,
    init: (_params, _room, frame): RotationState => ({ originMs: frame.startedAtMs ?? frame.nowMs, frame: -1,
      angle: 0, gradient: 0, nextAngle: 0, nextGradient: 0, noise: noisy ? createNoiseField(frame.seed) : null }),
    render(_params, state, room, frame, out) {
      const reached = ldjFrameAt(frame.nowMs, state.originMs);
      while (state.frame < reached) {
        state.angle = state.nextAngle; state.gradient = state.nextGradient; state.frame++;
        const increment = name === 'Swirl' ? 1 : name === 'Perlin' ? .005 : name === 'NorthernLights' ? .01 : -4;
        state.nextAngle += increment;
        if (state.nextAngle >= 360) state.nextAngle -= 360;
        state.nextGradient = wrap(state.nextGradient + 3);
      }
      const effective = (name === 'Beacon' || noisy) && frame.palette.some((_, i) => randomInput(frame, i)) ? RAINBOW : frame.palette;
      const palette = effective.length ? effective : [BLACK];
      const sectors = name === 'Beacon' ? palette.flatMap((colour) => [colour, BLACK]) : palette;
      const padded = [palette.length > 1 ? palette[0] : BLACK, ...palette, palette.length > 1 ? palette.at(-1)! : BLACK];
      for (let slot = 0; slot < room.n; slot++) {
        const angle = room.ringDegrees[slot];
        let colour: Colour, level = 1;
        if (name === 'Swirl') {
          const phase = wrap(angle + state.angle);
          if (randomInput(frame, 1)) colour = hsbToColour(Math.trunc(phase) / 360, 1, 1);
          else { colour = palette[1 % palette.length]; level = f32(Math.sin(phase * Math.PI / 180) / 2 + .5); }
        } else if (noisy) {
          const multiplier = name === 'Perlin' ? 3 : 4, radius = name === 'Perlin' ? 60 : 40;
          const centre = state.noise!.length / 2 - multiplier, cosine = Math.cos(state.angle);
          const x = Math.floor(radius * Math.abs(cosine) + centre + room.u[slot] * multiplier);
          const y = Math.floor(radius * cosine * Math.sin(state.angle) + centre + room.v[slot] * multiplier);
          const value = Math.min(f32(.9999999), Math.max(0, state.noise![x][y]));
          if (name === 'Perlin') colour = padded[Math.trunc(f32(value * padded.length))];
          else {
            const position = f32(value * (padded.length - 1)), lo = Math.floor(position), hi = Math.ceil(position);
            colour = mixColours(padded[lo], padded[hi], f32(1 - f32(position - lo)));
          }
        } else {
          const phase = wrap(angle + state.angle), width = 360 / sectors.length;
          const index = Math.floor(phase / width);
          if (name === 'Rotation' && randomInput(frame, index)) colour = hsbToColour(Math.trunc(wrap(angle + state.gradient)) / 360, 1, 1);
          else {
            colour = sectors[index];
            if (name === 'Beacon') level = f32(Math.max(0, 1 - Math.abs((index + .5) * width - phase) / (width / 2)));
          }
        }
        out[slot] = { colour: { ...colour }, level, strength: 1 };
      }
    },
  });
}
