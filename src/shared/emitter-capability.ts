import { emitterValues } from './look-math.ts';
import type { ChannelMap, Colour, EmitterLevels } from '../types/rig.ts';

// Missing dies use the same visible approximation as Hue's entertainment output.
export function fitEmitters(value: EmitterLevels, map: ChannelMap | null | undefined): EmitterLevels {
  if (!map) return value;
  const white = map.white !== undefined || map.coolWhite !== undefined;
  const amber = map.amber !== undefined || map.warmWhite !== undefined;
  const uv = map.uv !== undefined;
  const w = white ? 0 : value.w, a = amber ? 0 : value.a, v = uv ? 0 : value.uv;
  const r = value.r + w + a + v * .45;
  const g = value.g + w * .98 + a * .66;
  const b = value.b + w * .99 + a * .34 + v * .85;
  const scale = Math.max(r, g, b) > 255 ? 255 / Math.max(r, g, b) : 1;
  return { r: map.red === undefined ? 0 : Math.round(r * scale), g: map.green === undefined ? 0 : Math.round(g * scale),
    b: map.blue === undefined ? 0 : Math.round(b * scale), w: white ? value.w : 0, a: amber ? value.a : 0, uv: uv ? value.uv : 0 };
}

// Fold before the master/trim so a half-level colour remains half as bright.
export function outputEmitters(colour: Colour, scale: number, map: ChannelMap | null | undefined): EmitterLevels {
  const native = emitterValues(colour, scale);
  if (!map) return native;
  const missing = (map.white === undefined && map.coolWhite === undefined && (colour.w || 0) > 0)
    || (map.amber === undefined && map.warmWhite === undefined && (colour.a || 0) > 0)
    || (map.uv === undefined && (colour.uv || 0) > 0);
  if (!missing) return { ...native, r: map.red === undefined ? 0 : native.r, g: map.green === undefined ? 0 : native.g, b: map.blue === undefined ? 0 : native.b };
  const full = fitEmitters(emitterValues(colour, 1), map);
  return { ...native, r: Math.round(full.r * scale), g: Math.round(full.g * scale), b: Math.round(full.b * scale),
    w: map.white !== undefined || map.coolWhite !== undefined ? native.w : 0,
    a: map.amber !== undefined || map.warmWhite !== undefined ? native.a : 0, uv: map.uv !== undefined ? native.uv : 0 };
}
