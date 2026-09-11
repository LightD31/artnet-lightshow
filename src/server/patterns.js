'use strict';

// Pure pattern functions. Each takes (ctx) where:
//   ctx.colors        : array of resolved Colour A..D presets
//   ctx.fixtureCount  : N fixtures
//   ctx.step          : current beat step (advances each tick)
//   ctx.hue           : rotating hue for color-cycle / rainbow
//   ctx.twinkle       : per-fixture stochastic memory (mutated for 'twinkle')
//   ctx.write(i, color, dim, strobe) — sets fixture i's render colour
//
// renderDmx (engine.js) handles 'fade' and 'hit' continuous dynamics in the
// 40 Hz render path; tickPattern only seeds the colour for those.

function hsvToRgb(h, s, v) {
  h = ((h % 360) + 360) % 360;
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let r = 0, g = 0, b = 0;
  if (h < 60)       { r = c; g = x; b = 0; }
  else if (h < 120) { r = x; g = c; b = 0; }
  else if (h < 180) { r = 0; g = c; b = x; }
  else if (h < 240) { r = 0; g = x; b = c; }
  else if (h < 300) { r = x; g = 0; b = c; }
  else              { r = c; g = 0; b = x; }
  return {
    r: Math.round((r + m) * 255),
    g: Math.round((g + m) * 255),
    b: Math.round((b + m) * 255),
    w: 0,
  };
}

// Brightness for the lamps a travelling pattern is *not* on. Dark enough that
// the moving lamp is what the eye follows, bright enough that the rig does not
// look half-broken between hits. The old patterns each picked their own value
// between 50 and 80, which made a chase and a runner sit at visibly different
// levels for no reason.
const BED = 45;

/**
 * The bed, moved by what is actually playing.
 *
 * A constant is the right answer only for a rig with nothing to go on. With the
 * expression channel running, the gap between the travelling lamp and the rest
 * is a musical quantity: over a sparse intro the bed drops close to black and
 * the moving lamp is the whole show, and under a dense chorus it lifts so the
 * rig reads as lit rather than as one lamp working. `air` is the measurement —
 * how much texture is on top of the track — because that is what fills the
 * space between hits in the music too.
 */
function bedOf(ctx) {
  const d = ctx.dynamics;
  if (!d) return BED;
  const level = d.level == null ? 1 : d.level;
  return Math.round(Math.max(0, Math.min(120, (12 + 90 * (d.air ?? .3)) * level)));
}

/** A 0..1 reading from the expression channel, or a default without one. */
function dyn(ctx, key, fallback) {
  const value = ctx.dynamics ? ctx.dynamics[key] : undefined;
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : fallback;
}

/**
 * The distinct colours the four slots hold, in slot order.
 *
 * A palette smaller than four slots wraps to fill them — a duo becomes A/B/A/B
 * and a triad A/B/C/A (see server/palettes.js) — so counting distinct entries
 * recovers the size the operator actually picked. Slots hold resolved preset
 * objects out of one COLOR_PRESETS table, so two slots on the same preset are
 * the same object and reference equality is the right test.
 *
 * This is what lets one `split` replace the old split / split-3 / split-4: a
 * pattern uses as many colours as the look has, instead of the caller picking
 * the variant whose name matches the palette size. Eight patterns collapsed
 * into four this way, and the auto show no longer has to gate a `multi3` and a
 * `multi4` pool on the palette it happened to lock.
 */
function paletteOf(ctx) {
  const out = [];
  for (const c of ctx.colors) if (c && !out.includes(c)) out.push(c);
  return out.length ? out : [{ r: 0, g: 0, b: 0, w: 0, a: 0, uv: 0 }];
}

const PATTERN_FUNCS = {
  // The two expressive patterns are driven at frame rate by the expression
  // channel rather than stepped by the beat clock, which is what lets them
  // follow a swell. It is also what made them the quietest things in the
  // vocabulary: both used to sit in a narrow band around a third of full and
  // never leave it, so a chorus and a breakdown came out at the same
  // brightness. The gains below open that band at both ends — the crest
  // reaches full and the trough drops most of the way to black — because on a
  // rig of static pars the depth of the sweep is the only thing carrying it.
  ensemble(ctx) {
    const d = ctx.dynamics || { bass: .5, vocal: .5, air: .3, width: .5, motion: .4 };
    const phase = ctx.phase ?? ctx.step * .25;
    const pal = paletteOf(ctx);
    for (let i = 0; i < ctx.fixtureCount; i++) {
      const x = ctx.fixtureCount > 1 ? i / (ctx.fixtureCount - 1) : .5;
      const centre = ctx.fixtureCount <= 2 ? .5 : 1 - Math.abs(2 * x - 1);
      // Between half a cycle and a full one across the rig. It used to be one
      // to two, which on four lamps aliases exactly: at two cycles the rig
      // alternates in pairs and at one it moves as a block, and neither is the
      // crest travelling from one end to the other that the pattern is for.
      const spread = (0.5 + d.width * 0.5) * Math.PI * 2;
      // Raised to a power so the sweep is a travelling crest rather than an
      // even ripple: the same movement, but with somewhere dark for it to
      // travel *through*.
      const sweep = Math.pow((1 + Math.sin(phase * Math.PI * 2 - x * spread)) / 2, 1.6);
      // The bass and vocal terms are complementary across the rig — as one
      // fades in the other fades out — so together they held every lamp at
      // roughly one level and the pattern read as a dim wash with a ripple on
      // it. They are the *bed* here, and the sweep on top of them is what
      // moves, with enough authority to reach full on a loud track and to
      // leave the lamps it is not on well below it.
      const bed = .06 + .5 * (d.bass * (1 - centre) + d.vocal * centre);
      const strength = bed + (.35 + .5 * d.air) * sweep;
      ctx.write(i, pal[(centre > .5 ? 0 : 1) % pal.length], Math.round(Math.min(1, strength) * 255), 0);
    }
  },
  ribbon(ctx) {
    const d = ctx.dynamics || { width: .6, motion: .3, air: .5 };
    const phase = ctx.phase ?? ctx.step / 8;
    const pal = paletteOf(ctx);
    // Where the unlit end of the ribbon sits. Texture lifts it, so a dense
    // track keeps the whole rig alive and a sparse one lets the crest be the
    // only thing on stage.
    const floor = 18 + 55 * d.air;
    for (let i = 0; i < ctx.fixtureCount; i++) {
      const x = i / Math.max(1, ctx.fixtureCount - 1);
      const wave = (1 + Math.sin(phase * Math.PI * 2 + x * d.width * Math.PI * 2)) / 2;
      const crest = Math.pow(wave, 1.5);
      const a = pal[0], b = pal[1 % pal.length];
      const col = Object.fromEntries(['r', 'g', 'b', 'w', 'a', 'uv'].map(k => [k,
        Math.round((a[k] || 0) * (1 - wave) + (b[k] || 0) * wave)]));
      ctx.write(i, pal.length === 1 ? pal[0] : col, Math.round(floor + crest * (255 - floor)), 0);
    }
  },
  // ── Whole rig ─────────────────────────────────────────────────────────────

  solid(ctx) {
    const [colA] = ctx.colors;
    for (let i = 0; i < ctx.fixtureCount; i++) ctx.write(i, colA, 255, 0);
  },

  fade(ctx) {
    const [colA] = ctx.colors;
    // Brightness is overwritten by renderDmx for smoothness.
    for (let i = 0; i < ctx.fixtureCount; i++) ctx.write(i, colA, 255, 0);
  },

  hit(ctx) {
    const [colA] = ctx.colors;
    ctx.resetHitPhase();
    for (let i = 0; i < ctx.fixtureCount; i++) ctx.write(i, colA, 255, 0);
  },

  strobe(ctx) {
    const [colA] = ctx.colors;
    for (let i = 0; i < ctx.fixtureCount; i++) ctx.write(i, colA, 255, 0);
  },

  'color-cycle'(ctx) {
    // Steps the whole rig to the next colour in the look each beat. It used to
    // sweep raw HSV, which ignored the palette entirely and so had to be kept
    // out of every generated-show pool; driving it from the slots means it
    // finally agrees with whatever look is on stage.
    const pal = paletteOf(ctx);
    const col = pal[ctx.step % pal.length];
    for (let i = 0; i < ctx.fixtureCount; i++) ctx.write(i, col, 255, 0);
  },

  rainbow(ctx) {
    // The one deliberately palette-free look: a full spectrum spread across the
    // rig. No set of six presets can approximate it, which is why it survives
    // the fold — and why the auto show still leaves it alone.
    const N = Math.max(1, ctx.fixtureCount);
    for (let i = 0; i < ctx.fixtureCount; i++) {
      ctx.write(i, hsvToRgb(ctx.hue + (360 / N) * i, 1, 1), 255, 0);
    }
  },

  // ── Travelling ────────────────────────────────────────────────────────────
  //
  // All of these light one or two lamps at full and hold the rest at the bed —
  // which is no longer a constant, but how much air the track has (see
  // `bedOf`), so the same chase reads as sparse over an intro and as lit under
  // a chorus. The lit lamp takes the next colour in the look on every step, so
  // a four-colour palette gets the old chase-4 behaviour and a two-colour
  // palette alternates — one pattern instead of three.

  chase(ctx) {
    const pal = paletteOf(ctx);
    const bed = bedOf(ctx);
    const N = ctx.fixtureCount;
    for (let i = 0; i < N; i++) {
      const active = i === ctx.step % N;
      ctx.write(i, active ? pal[ctx.step % pal.length] : pal[pal.length - 1], active ? 255 : bed, 0);
    }
  },

  'chase-rev'(ctx) {
    const pal = paletteOf(ctx);
    const bed = bedOf(ctx);
    const N = ctx.fixtureCount;
    for (let i = 0; i < N; i++) {
      const active = i === (N - 1 - ctx.step % N);
      ctx.write(i, active ? pal[ctx.step % pal.length] : pal[pal.length - 1], active ? 255 : bed, 0);
    }
  },

  'ping-pong'(ctx) {
    const pal = paletteOf(ctx);
    const bed = bedOf(ctx);
    const N = ctx.fixtureCount;
    const span = Math.max(2, N) * 2 - 2;
    const pos = ctx.step % span;
    const idx = pos < N ? pos : (span - pos);
    for (let i = 0; i < N; i++) {
      const active = i === idx;
      ctx.write(i, active ? pal[ctx.step % pal.length] : pal[pal.length - 1], active ? 255 : bed, 0);
    }
  },

  runner(ctx) {
    const pal = paletteOf(ctx);
    const N = Math.max(1, ctx.fixtureCount);
    const lead = ctx.step % N;
    const col = pal[ctx.step % pal.length];
    // The tail is how long the light hangs behind the lead lamp, and the music
    // says how long that should be: a fast, driving passage leaves a short hard
    // trail, a slow one smears. `motion` carries the same reading that decides
    // how fast the expressive patterns sweep, so the whole rig agrees about how
    // quickly the track is moving.
    const tail = 1 + Math.round(dyn(ctx, 'motion', .3) * 2.4);
    const bed = bedOf(ctx);
    for (let i = 0; i < N; i++) {
      const dist = (lead - i + N) % N;
      const b = dist === 0 ? 255
        : dist <= tail ? Math.round(255 * Math.pow(1 - dist / (tail + 1), 1.5))
          : bed;
      ctx.write(i, col, b, 0);
    }
  },

  pairs(ctx) {
    const pal = paletteOf(ctx);
    const bed = bedOf(ctx);
    const N = Math.max(1, ctx.fixtureCount);
    const pos = ctx.step % N;
    for (let i = 0; i < N; i++) {
      const on = (i === pos || i === (pos + 1) % N);
      ctx.write(i, on ? pal[ctx.step % pal.length] : pal[pal.length - 1], on ? 255 : bed, 0);
    }
  },

  wave(ctx) {
    const [colA] = ctx.colors;
    const N = Math.max(1, ctx.fixtureCount);
    // How far the wave is spread across the rig follows the mix's own width. A
    // mono, centred track gets a rig that swells together; a wide one gets a
    // wave that genuinely travels, which is the same information the mix is
    // already giving the ears.
    const spread = 0.35 + dyn(ctx, 'width', .5) * 1.3;
    for (let i = 0; i < N; i++) {
      // One full sweep every eight beats. The phase used to advance 0.25 rad a
      // beat — a quarter turn every twenty-five beats — so on anything shorter
      // than a whole song the wave never visibly moved.
      const phase = (ctx.step * (Math.PI * 2 / 8)) - (i * (Math.PI * 2 / N) * spread);
      const b = Math.round(((Math.sin(phase) + 1) / 2) * 215 + 40);
      ctx.write(i, colA, b, 0);
    }
  },

  'stack-up'(ctx) {
    const pal = paletteOf(ctx);
    const bed = bedOf(ctx);
    const N = ctx.fixtureCount;
    const pos = ctx.step % (N + 1);
    for (let i = 0; i < N; i++) {
      const lit = i < pos;
      // The stack builds in the look's colours rather than one flat wash, so a
      // four-lamp rig fills with four different colours.
      ctx.write(i, lit ? pal[i % pal.length] : pal[pal.length - 1], lit ? 255 : bed, 0);
    }
  },

  // ── Sectional ─────────────────────────────────────────────────────────────

  split(ctx) {
    const pal = paletteOf(ctx);
    for (let i = 0; i < ctx.fixtureCount; i++) {
      ctx.write(i, pal[(i + ctx.step) % pal.length], 255, 0);
    }
  },

  sections(ctx) {
    // The rig divides into as many blocks as the look has colours and they
    // rotate one place each beat. Was three patterns — alt-halves, alt-thirds,
    // alt-quarters — that differed only in how many blocks they cut.
    const pal = paletteOf(ctx);
    const N = Math.max(1, ctx.fixtureCount);
    const size = Math.max(1, Math.ceil(N / pal.length));
    const rot = ctx.step % pal.length;
    for (let i = 0; i < N; i++) {
      const block = Math.min(pal.length - 1, Math.floor(i / size));
      ctx.write(i, pal[(block + rot) % pal.length], 255, 0);
    }
  },

  // ── Random ────────────────────────────────────────────────────────────────
  //
  // Three of them because they are three different looks, not three spellings
  // of one: a soft shimmer that never goes dark, a hard scatter with gaps, and
  // a single lamp popping against black.

  // How *much* scatter there is follows the air in the track. A shimmer is a
  // picture of the top end, so a passage with hats and reverb on it twinkles
  // densely and one without barely moves — which is the difference between the
  // effect illustrating the music and the effect running regardless of it.

  twinkle(ctx) {
    const pal = paletteOf(ctx);
    const density = 0.15 + dyn(ctx, 'air', .4) * 0.5;
    for (let i = 0; i < ctx.fixtureCount; i++) {
      if (Math.random() < density) ctx.twinkle[i] = Math.random() < 0.7 ? 255 : 60;
      ctx.write(i, pal[i % pal.length], ctx.twinkle[i], 0);
    }
  },

  sparkle(ctx) {
    const pal = paletteOf(ctx);
    const density = 0.12 + dyn(ctx, 'air', .4) * 0.45;
    for (let i = 0; i < ctx.fixtureCount; i++) {
      ctx.write(i, pal[i % pal.length], Math.random() < density ? 255 : 0, 0);
    }
  },

  'random-flash'(ctx) {
    const pal = paletteOf(ctx);
    const N = ctx.fixtureCount;
    const target = Math.floor(Math.random() * Math.max(1, N));
    const bed = Math.round(bedOf(ctx) * 0.5);
    for (let i = 0; i < N; i++) {
      ctx.write(i, pal[ctx.step % pal.length], i === target ? 255 : bed, 0);
    }
  },
};

module.exports = { PATTERN_FUNCS, paletteOf, hsvToRgb, bedOf, BED };
