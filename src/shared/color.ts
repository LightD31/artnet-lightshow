// OkLCh follows the hue wheel so opposite colours do not fade through grey.

import type { Colour, EmitterLevels } from '../types/rig.ts';

type Triple = [number, number, number];

// Oklab by Björn Ottosson (2020); DMX PWM values are linear light, not gamma-encoded sRGB.
function toOklab(r: number, g: number, b: number): Triple {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
  ];
}

function fromOklab(L: number, a: number, b: number): Triple {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  ];
}

// Borrow hue from the chromatic endpoint so fades to white do not swing through rounding noise.
const ACHROMATIC = 0.02;

const inGamut = (rgb: Triple): boolean => rgb.every((v) => v >= -1e-6 && v <= 1 + 1e-6);

function toLch(col: Colour): { L: number; C: number; h: number } {
  const [L, a, b] = toOklab((col.r || 0) / 255, (col.g || 0) / 255, (col.b || 0) / 255);
  return { L, C: Math.hypot(a, b), h: Math.atan2(b, a) };
}

// Cache endpoint conversions because each frame samples the same colour pair many times.
function colourMixer(from: Colour, to: Colour): (t: number) => EmitterLevels {
  const A = toLch(from);
  const B = toLch(to);
  const hueA = A.C < ACHROMATIC ? B.h : A.h;
  const hueB = B.C < ACHROMATIC ? A.h : B.h;
  let dh = hueB - hueA;
  if (dh > Math.PI) dh -= 2 * Math.PI;
  if (dh < -Math.PI) dh += 2 * Math.PI;

  const lerp = (x: number, y: number, t: number): number => x + (y - x) * t;
  const dies = (t: number) => ({
    w: Math.round(lerp(from.w || 0, to.w || 0, t)),
    a: Math.round(lerp(from.a || 0, to.a || 0, t)),
    uv: Math.round(lerp(from.uv || 0, to.uv || 0, t)),
  });

  return (t: number): EmitterLevels => {
    if (t <= 0) return { r: from.r || 0, g: from.g || 0, b: from.b || 0, ...dies(0) };
    if (t >= 1) return { r: to.r || 0, g: to.g || 0, b: to.b || 0, ...dies(1) };
    const L = lerp(A.L, B.L, t);
    const h = hueA + dh * t;
    let C = lerp(A.C, B.C, t);
    let rgb = fromOklab(L, C * Math.cos(h), C * Math.sin(h));
    // Reduce chroma instead of clipping channels so out-of-gamut colours keep their hue.
    if (!inGamut(rgb)) {
      let lo = 0;
      let hi = C;
      for (let i = 0; i < 14; i++) {
        const mid = (lo + hi) / 2;
        if (inGamut(fromOklab(L, mid * Math.cos(h), mid * Math.sin(h)))) lo = mid; else hi = mid;
      }
      C = lo;
      rgb = fromOklab(L, C * Math.cos(h), C * Math.sin(h));
    }
    const [r, g, b] = rgb.map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255));
    return { r, g, b, ...dies(t) };
  };
}

function chromaOf(col: Colour): number {
  return toLch(col).C;
}

export {
  colourMixer,
  chromaOf,
};
