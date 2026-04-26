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

const PATTERN_FUNCS = {
  solid(ctx) {
    const [colA] = ctx.colors;
    for (let i = 0; i < ctx.fixtureCount; i++) ctx.write(i, colA, 255, 0);
  },

  chase(ctx) {
    const [colA, colB] = ctx.colors;
    const N = ctx.fixtureCount;
    for (let i = 0; i < N; i++) {
      const active = i === ctx.step % N;
      ctx.write(i, active ? colA : colB, active ? 255 : 80, 0);
    }
  },

  'chase-rev'(ctx) {
    const [colA, colB] = ctx.colors;
    const N = ctx.fixtureCount;
    for (let i = 0; i < N; i++) {
      const active = i === (N - 1 - ctx.step % N);
      ctx.write(i, active ? colA : colB, active ? 255 : 80, 0);
    }
  },

  'ping-pong'(ctx) {
    const [colA, colB] = ctx.colors;
    const N = ctx.fixtureCount;
    const span = Math.max(2, N) * 2 - 2;
    const pos = ctx.step % span;
    const idx = pos < N ? pos : (span - pos);
    for (let i = 0; i < N; i++) {
      ctx.write(i, i === idx ? colA : colB, i === idx ? 255 : 80, 0);
    }
  },

  strobe(ctx) {
    const [colA] = ctx.colors;
    for (let i = 0; i < ctx.fixtureCount; i++) ctx.write(i, colA, 255, 0);
  },

  fade(ctx) {
    const [colA] = ctx.colors;
    // Brightness is overwritten by renderDmx for smoothness.
    for (let i = 0; i < ctx.fixtureCount; i++) ctx.write(i, colA, 255, 0);
  },

  'color-cycle'(ctx) {
    const col = hsvToRgb(ctx.hue, 1, 1);
    for (let i = 0; i < ctx.fixtureCount; i++) ctx.write(i, col, 255, 0);
  },

  rainbow(ctx) {
    const N = Math.max(1, ctx.fixtureCount);
    for (let i = 0; i < ctx.fixtureCount; i++) {
      const col = hsvToRgb(ctx.hue + (360 / N) * i, 1, 1);
      ctx.write(i, col, 255, 0);
    }
  },

  twinkle(ctx) {
    const [colA] = ctx.colors;
    for (let i = 0; i < ctx.fixtureCount; i++) {
      if (Math.random() < 0.4) ctx.twinkle[i] = Math.random() < 0.7 ? 255 : 60;
      ctx.write(i, colA, ctx.twinkle[i], 0);
    }
  },

  split(ctx) {
    const [colA, colB] = ctx.colors;
    for (let i = 0; i < ctx.fixtureCount; i++) {
      ctx.write(i, (i + ctx.step) % 2 === 0 ? colA : colB, 255, 0);
    }
  },

  sparkle(ctx) {
    const [colA] = ctx.colors;
    for (let i = 0; i < ctx.fixtureCount; i++) {
      const on = Math.random() < 0.35;
      ctx.write(i, colA, on ? 255 : 0, 0);
    }
  },

  wave(ctx) {
    const [colA] = ctx.colors;
    const N = Math.max(1, ctx.fixtureCount);
    for (let i = 0; i < N; i++) {
      const phase = (ctx.step * 0.25) - (i * (Math.PI * 2 / N));
      const b = Math.round(((Math.sin(phase) + 1) / 2) * 215 + 40);
      ctx.write(i, colA, b, 0);
    }
  },

  'stack-up'(ctx) {
    const [colA, colB] = ctx.colors;
    const N = ctx.fixtureCount;
    const cycle = N + 1;
    const pos = ctx.step % cycle;
    for (let i = 0; i < N; i++) {
      const lit = i < pos;
      ctx.write(i, lit ? colA : colB, lit ? 255 : 60, 0);
    }
  },

  'random-flash'(ctx) {
    const [colA, colB] = ctx.colors;
    const N = ctx.fixtureCount;
    const target = Math.floor(Math.random() * Math.max(1, N));
    for (let i = 0; i < N; i++) {
      ctx.write(i, i === target ? colA : colB, i === target ? 255 : 0, 0);
    }
  },

  runner(ctx) {
    const [colA] = ctx.colors;
    const N = Math.max(1, ctx.fixtureCount);
    const lead = ctx.step % N;
    for (let i = 0; i < N; i++) {
      const dist = (lead - i + N) % N;
      const b = dist === 0 ? 255 : dist === 1 ? 150 : dist === 2 ? 70 : 0;
      ctx.write(i, colA, b, 0);
    }
  },

  pairs(ctx) {
    const [colA, colB] = ctx.colors;
    const N = Math.max(1, ctx.fixtureCount);
    const pos = ctx.step % N;
    for (let i = 0; i < N; i++) {
      const on = (i === pos || i === (pos + 1) % N);
      ctx.write(i, on ? colA : colB, on ? 255 : 50, 0);
    }
  },

  hit(ctx) {
    const [colA] = ctx.colors;
    ctx.resetHitPhase();
    for (let i = 0; i < ctx.fixtureCount; i++) ctx.write(i, colA, 255, 0);
  },

  'alt-halves'(ctx) {
    const [colA, colB] = ctx.colors;
    const N = Math.max(1, ctx.fixtureCount);
    const half = Math.max(1, Math.floor(N / 2));
    const flipped = (ctx.step % 2) === 1;
    for (let i = 0; i < N; i++) {
      const firstHalf = i < half;
      const useA = flipped ? !firstHalf : firstHalf;
      ctx.write(i, useA ? colA : colB, 255, 0);
    }
  },

  'split-3'(ctx) {
    const cols = [ctx.colors[0], ctx.colors[1], ctx.colors[2]];
    for (let i = 0; i < ctx.fixtureCount; i++) {
      ctx.write(i, cols[(i + ctx.step) % 3], 255, 0);
    }
  },

  'chase-3'(ctx) {
    const cols = [ctx.colors[0], ctx.colors[1], ctx.colors[2]];
    const N = ctx.fixtureCount;
    for (let i = 0; i < N; i++) {
      const active = i === ctx.step % N;
      ctx.write(i, active ? cols[ctx.step % 3] : cols[i % 3], active ? 255 : 60, 0);
    }
  },

  'alt-thirds'(ctx) {
    const cols = [ctx.colors[0], ctx.colors[1], ctx.colors[2]];
    const N = Math.max(1, ctx.fixtureCount);
    const third = Math.max(1, Math.ceil(N / 3));
    const rot = ctx.step % 3;
    for (let i = 0; i < N; i++) {
      const section = Math.min(2, Math.floor(i / third));
      ctx.write(i, cols[(section + rot) % 3], 255, 0);
    }
  },

  'split-4'(ctx) {
    const cols = ctx.colors;
    for (let i = 0; i < ctx.fixtureCount; i++) {
      ctx.write(i, cols[(i + ctx.step) % 4], 255, 0);
    }
  },

  'chase-4'(ctx) {
    const cols = ctx.colors;
    const N = ctx.fixtureCount;
    for (let i = 0; i < N; i++) {
      const active = i === ctx.step % N;
      ctx.write(i, active ? cols[ctx.step % 4] : cols[i % 4], active ? 255 : 60, 0);
    }
  },

  'alt-quarters'(ctx) {
    const cols = ctx.colors;
    const N = Math.max(1, ctx.fixtureCount);
    const quarter = Math.max(1, Math.ceil(N / 4));
    const rot = ctx.step % 4;
    for (let i = 0; i < N; i++) {
      const section = Math.min(3, Math.floor(i / quarter));
      ctx.write(i, cols[(section + rot) % 4], 255, 0);
    }
  },

  'pairs-4'(ctx) {
    const cols = ctx.colors;
    const N = Math.max(1, ctx.fixtureCount);
    const pos = ctx.step % N;
    for (let i = 0; i < N; i++) {
      const on = (i === pos || i === (pos + 1) % N);
      ctx.write(i, on ? cols[ctx.step % 4] : cols[i % 4], on ? 255 : 50, 0);
    }
  },
};

module.exports = { PATTERN_FUNCS, hsvToRgb };
