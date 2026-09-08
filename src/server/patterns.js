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
  // All of these light one or two lamps at full and hold the rest at BED. The
  // lit lamp takes the next colour in the look on every step, so a four-colour
  // palette gets the old chase-4 behaviour and a two-colour palette alternates
  // — one pattern instead of three.

  chase(ctx) {
    const pal = paletteOf(ctx);
    const N = ctx.fixtureCount;
    for (let i = 0; i < N; i++) {
      const active = i === ctx.step % N;
      ctx.write(i, active ? pal[ctx.step % pal.length] : pal[pal.length - 1], active ? 255 : BED, 0);
    }
  },

  'chase-rev'(ctx) {
    const pal = paletteOf(ctx);
    const N = ctx.fixtureCount;
    for (let i = 0; i < N; i++) {
      const active = i === (N - 1 - ctx.step % N);
      ctx.write(i, active ? pal[ctx.step % pal.length] : pal[pal.length - 1], active ? 255 : BED, 0);
    }
  },

  'ping-pong'(ctx) {
    const pal = paletteOf(ctx);
    const N = ctx.fixtureCount;
    const span = Math.max(2, N) * 2 - 2;
    const pos = ctx.step % span;
    const idx = pos < N ? pos : (span - pos);
    for (let i = 0; i < N; i++) {
      const active = i === idx;
      ctx.write(i, active ? pal[ctx.step % pal.length] : pal[pal.length - 1], active ? 255 : BED, 0);
    }
  },

  runner(ctx) {
    const pal = paletteOf(ctx);
    const N = Math.max(1, ctx.fixtureCount);
    const lead = ctx.step % N;
    const col = pal[ctx.step % pal.length];
    for (let i = 0; i < N; i++) {
      const dist = (lead - i + N) % N;
      const b = dist === 0 ? 255 : dist === 1 ? 150 : dist === 2 ? 70 : 0;
      ctx.write(i, col, b, 0);
    }
  },

  pairs(ctx) {
    const pal = paletteOf(ctx);
    const N = Math.max(1, ctx.fixtureCount);
    const pos = ctx.step % N;
    for (let i = 0; i < N; i++) {
      const on = (i === pos || i === (pos + 1) % N);
      ctx.write(i, on ? pal[ctx.step % pal.length] : pal[pal.length - 1], on ? 255 : BED, 0);
    }
  },

  wave(ctx) {
    const [colA] = ctx.colors;
    const N = Math.max(1, ctx.fixtureCount);
    for (let i = 0; i < N; i++) {
      // One full sweep every eight beats. The phase used to advance 0.25 rad a
      // beat — a quarter turn every twenty-five beats — so on anything shorter
      // than a whole song the wave never visibly moved.
      const phase = (ctx.step * (Math.PI * 2 / 8)) - (i * (Math.PI * 2 / N));
      const b = Math.round(((Math.sin(phase) + 1) / 2) * 215 + 40);
      ctx.write(i, colA, b, 0);
    }
  },

  'stack-up'(ctx) {
    const pal = paletteOf(ctx);
    const N = ctx.fixtureCount;
    const pos = ctx.step % (N + 1);
    for (let i = 0; i < N; i++) {
      const lit = i < pos;
      // The stack builds in the look's colours rather than one flat wash, so a
      // four-lamp rig fills with four different colours.
      ctx.write(i, lit ? pal[i % pal.length] : pal[pal.length - 1], lit ? 255 : BED, 0);
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

  twinkle(ctx) {
    const pal = paletteOf(ctx);
    for (let i = 0; i < ctx.fixtureCount; i++) {
      if (Math.random() < 0.4) ctx.twinkle[i] = Math.random() < 0.7 ? 255 : 60;
      ctx.write(i, pal[i % pal.length], ctx.twinkle[i], 0);
    }
  },

  sparkle(ctx) {
    const pal = paletteOf(ctx);
    for (let i = 0; i < ctx.fixtureCount; i++) {
      ctx.write(i, pal[i % pal.length], Math.random() < 0.35 ? 255 : 0, 0);
    }
  },

  'random-flash'(ctx) {
    const pal = paletteOf(ctx);
    const N = ctx.fixtureCount;
    const target = Math.floor(Math.random() * Math.max(1, N));
    for (let i = 0; i < N; i++) {
      ctx.write(i, pal[ctx.step % pal.length], i === target ? 255 : 0, 0);
    }
  },
};

module.exports = { PATTERN_FUNCS, paletteOf, hsvToRgb };
