'use strict';

/**
 * Blending one look colour into another, the way it should read on stage.
 *
 * `ribbon` crossfades slot A into slot B across the rig, and it used to do it
 * per channel: the midpoint was the average of the two DMX values. A and B in
 * every bank are deliberately *opposites* — palettes.js calls B "contrast —
 * its opposite" — and the average of two opposite colours of light is a washed
 * out, near-white grey. On ten of the twenty-four coloured banks the middle of
 * the ribbon kept less than half the saturation of either end; Green into
 * Magenta kept about a twentieth. And `ribbon` is not a corner case: it is the
 * pattern every resting passage — intro, breakdown, outro, a build-up's
 * tension — resolves to.
 *
 * So the blend travels round the colour wheel instead of through the middle of
 * it: lightness and chroma are interpolated in Oklab's polar form (OkLCh), and
 * hue takes the short way round. The perceptual space is the point — a straight
 * line in Oklab still passes through grey between two opposites, and measured
 * worse than the naive average here; only the polar form keeps the colour.
 *
 * Two modelling decisions, both stated because either could be argued:
 *
 *   * A DMX value is treated as *linear light*, not as gamma-encoded sRGB. LED
 *     fixtures drive their emitters by PWM, so 128 really is about half the
 *     light of 255, and every other part of the engine already mixes as if so.
 *   * The white, amber and UV dies blend linearly. Each is one fixed colour; the
 *     only thing to interpolate is how hard it is driven.
 *
 * Pure and dependency-free: the engine and the browser rehearsal both run it.
 */

// Oklab, after Björn Ottosson (2020), on linear RGB in 0..1.
function toOklab(r, g, b) {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
  ];
}

function fromOklab(L, a, b) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  ];
}

// Below this chroma a colour has no hue worth following — a white tint, or
// black. Its hue is taken from the other end, so fading a colour towards white
// does not swing through whatever angle rounding happened to leave on the white.
const ACHROMATIC = 0.02;

const inGamut = (rgb) => rgb.every((v) => v >= -1e-6 && v <= 1 + 1e-6);

function toLch(col) {
  const [L, a, b] = toOklab((col.r || 0) / 255, (col.g || 0) / 255, (col.b || 0) / 255);
  return { L, C: Math.hypot(a, b), h: Math.atan2(b, a) };
}

/**
 * A blend from `from` to `to`, returned as a function of t in 0..1.
 *
 * Built once per pair — the ends are converted once — and then called per lamp,
 * because a pattern asks for many points along the same crossfade every frame.
 */
function colourMixer(from, to) {
  const A = toLch(from);
  const B = toLch(to);
  const hueA = A.C < ACHROMATIC ? B.h : A.h;
  const hueB = B.C < ACHROMATIC ? A.h : B.h;
  let dh = hueB - hueA;
  if (dh > Math.PI) dh -= 2 * Math.PI;
  if (dh < -Math.PI) dh += 2 * Math.PI;

  const lerp = (x, y, t) => x + (y - x) * t;
  const dies = (t) => ({
    w: Math.round(lerp(from.w || 0, to.w || 0, t)),
    a: Math.round(lerp(from.a || 0, to.a || 0, t)),
    uv: Math.round(lerp(from.uv || 0, to.uv || 0, t)),
  });

  return (t) => {
    if (t <= 0) return { r: from.r || 0, g: from.g || 0, b: from.b || 0, ...dies(0) };
    if (t >= 1) return { r: to.r || 0, g: to.g || 0, b: to.b || 0, ...dies(1) };
    const L = lerp(A.L, B.L, t);
    const h = hueA + dh * t;
    let C = lerp(A.C, B.C, t);
    let rgb = fromOklab(L, C * Math.cos(h), C * Math.sin(h));
    // Travelling round the wheel can pass through colours the emitters cannot
    // make. Clipping each channel would bend the hue; giving up chroma keeps it
    // and loses only saturation, and only as much as the gamut demands.
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

/** Oklab chroma of a colour's RGB emitters, treating DMX as linear light. */
function chromaOf(col) {
  return toLch(col).C;
}

module.exports = { colourMixer, chromaOf };
