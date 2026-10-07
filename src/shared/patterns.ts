import { colourMixer } from './color.ts';
import { HOLD_STROBE_MAX_HZ, HUE_PULSE_MS, HUE_PULSE_FLOOR, huePulseLevel } from './look-math.ts';
import { roomOf, xOf, yOf } from './room.ts';
import type { StagePlan } from './rig.ts';
import type { Colour, Expression, PulseReading } from '../types/rig.ts';

export interface PatternContext {
  colors: readonly Colour[];
  fixtureCount: number;
  step: number;
  stepPos?: number;
  stepPhase?: number;
  phase?: number;
  hue: number;
  twinkle: number[];
  xs: readonly number[] | null;
  ys: readonly number[] | null;
  dynamics: Readonly<Expression> | null;
  pulse?: Readonly<PulseReading> | null;
  progress?: number | null;
  stepMs?: number | null;
  plan?: StagePlan | null;
  // Preserve the legacy Hue mask name used by rig layouts.
  noFlash?: readonly boolean[] | null;
  // Older direct pattern callers retain pulse when this setting is absent.
  hueStrobe?: 'flash' | 'pulse';
  write(i: number, colour: Colour, dim: number, strobe: number): void;
}

export type PatternFn = (ctx: PatternContext) => void;

function hsvToRgb(h: number, s: number, v: number): Colour {
  h = ((h % 360) + 360) % 360;
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let r: number, g: number, b: number;
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

const BED = 45;

function bedOf(ctx: PatternContext): number {
  const d = ctx.dynamics;
  if (!d) return BED;
  const level = d.level == null ? 1 : d.level;
  return Math.round(Math.max(0, Math.min(120, (12 + 90 * (d.air ?? .3)) * level)));
}

function dyn(ctx: PatternContext, key: keyof Expression, fallback: number): number {
  const value = ctx.dynamics ? ctx.dynamics[key] : undefined;
  return value !== undefined && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : fallback;
}

function paletteOf(ctx: Pick<PatternContext, 'colors'>): Colour[] {
  const out: Colour[] = [];
  for (const c of ctx.colors) if (c && !out.includes(c)) out.push(c);
  return out.length ? out : [{ r: 0, g: 0, b: 0, w: 0, a: 0, uv: 0 }];
}

const CELL_PATTERNS = new Set([
  'ensemble', 'ribbon', 'wave', 'rainbow', 'twinkle', 'sparkle',
  'gradient', 'comet', 'burst', 'plasma', 'meter', 'drums', 'stems',
  'rise', 'impact', 'bars', 'fire', 'rain',
  'flash-chase', 'flash-scatter', 'flash-fill', 'flash-alternate', 'ramp', 'core',
  'position-chase', 'radial-pulse', 'spatial-wash', 'bounce-scan', 'streak', 'starlight',
  'breathe', 'volume-gate', 'confetti',
  'anchor-fill', 'halves', 'flip', 'room-wave', 'ring-strobe', 'ring-backlit', 'fireworks', 'flashes', 'swirl',
]);

const frac = (v: number): number => v - Math.floor(v);

const GRADIENT_STEPS = 64;
const gradients = new Map<string, Colour[]>();

function gradientOf(pal: readonly Colour[]): Colour[] {
  const key = pal.map((c) => `${c.r},${c.g},${c.b},${c.w || 0},${c.a || 0},${c.uv || 0}`).join('|');
  let table = gradients.get(key);
  if (!table) {
    if (gradients.size > 32) gradients.clear();
    table = [];
    for (let k = 0; k < pal.length; k++) {
      const mix = colourMixer(pal[k], pal[(k + 1) % pal.length]);
      for (let s = 0; s < GRADIENT_STEPS; s++) {
        table.push(s === 0 ? pal[k] : mix(s / GRADIENT_STEPS));
      }
    }
    gradients.set(key, table);
  }
  return table;
}

function gradientAt(pal: readonly Colour[], p: number): Colour {
  if (pal.length === 1) return pal[0];
  const table = gradientOf(pal);
  return table[Math.floor(frac(p) * table.length) % table.length];
}

const PATTERN_FUNCS: Record<string, PatternFn> = {
  ensemble(ctx) {
    const d = ctx.dynamics || { bass: .5, vocal: .5, air: .3, width: .5, motion: .4 };
    const phase = ctx.phase ?? ctx.step * .25;
    const pal = paletteOf(ctx);
    for (let i = 0; i < ctx.fixtureCount; i++) {
      const x = ctx.xs ? ctx.xs[i] : ctx.fixtureCount > 1 ? i / (ctx.fixtureCount - 1) : .5;
      const centre = ctx.fixtureCount <= 2 ? .5 : 1 - Math.abs(2 * x - 1);
      const spread = (0.5 + d.width * 0.5) * Math.PI * 2;
      const sweep = Math.pow((1 + Math.sin(phase * Math.PI * 2 - x * spread)) / 2, 1.6);
      const bed = .06 + .5 * (d.bass * (1 - centre) + d.vocal * centre);
      const strength = bed + (.35 + .5 * d.air) * sweep;
      ctx.write(i, pal[(centre > .5 ? 0 : 1) % pal.length], Math.round(Math.min(1, strength) * 255), 0);
    }
  },
  ribbon(ctx) {
    const d = ctx.dynamics || { width: .6, motion: .3, air: .5 };
    const phase = ctx.phase ?? ctx.step / 8;
    const pal = paletteOf(ctx);
    const floor = 18 + 55 * d.air;
    const mix = pal.length === 1 ? null : colourMixer(pal[0], pal[1 % pal.length]);
    for (let i = 0; i < ctx.fixtureCount; i++) {
      const x = ctx.xs ? ctx.xs[i] : i / Math.max(1, ctx.fixtureCount - 1);
      const wave = (1 + Math.sin(phase * Math.PI * 2 + x * d.width * Math.PI * 2)) / 2;
      const crest = Math.pow(wave, 1.5);
      ctx.write(i, mix ? mix(wave) : pal[0], Math.round(floor + crest * (255 - floor)), 0);
    }
  },

  solid(ctx) {
    const [colA] = ctx.colors;
    for (let i = 0; i < ctx.fixtureCount; i++) ctx.write(i, colA, 255, 0);
  },

  fade(ctx) {
    const [colA] = ctx.colors;
    for (let i = 0; i < ctx.fixtureCount; i++) ctx.write(i, colA, 255, 0);
  },

  hit(ctx) {
    const [colA] = ctx.colors;
    for (let i = 0; i < ctx.fixtureCount; i++) ctx.write(i, colA, 255, 0);
  },

  strobe(ctx) {
    const [colA] = ctx.colors;
    for (let i = 0; i < ctx.fixtureCount; i++) ctx.write(i, colA, 255, 0);
  },

  'color-cycle'(ctx) {
    const pal = paletteOf(ctx);
    const col = pal[ctx.step % pal.length];
    for (let i = 0; i < ctx.fixtureCount; i++) ctx.write(i, col, 255, 0);
  },

  rainbow(ctx) {
    const N = Math.max(1, ctx.fixtureCount);
    for (let i = 0; i < ctx.fixtureCount; i++) {
      ctx.write(i, hsvToRgb(ctx.hue + (360 / N) * i, 1, 1), 255, 0);
    }
  },

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
    const spread = 0.35 + dyn(ctx, 'width', .5) * 1.3;
    for (let i = 0; i < N; i++) {
      const offset = ctx.xs
        ? (ctx.xs[i] * (N - 1) / N) * Math.PI * 2 * spread
        : (i * (Math.PI * 2 / N) * spread);
      const phase = (ctx.step * (Math.PI * 2 / 8)) - offset;
      const b = Math.round(((Math.sin(phase) + 1) / 2) * 215 + 40);
      ctx.write(i, colA, b, 0);
    }
  },

  'stack-up'(ctx) {
    const pal = paletteOf(ctx);
    const bed = bedOf(ctx);
    const N = ctx.fixtureCount;
    const pos = ctx.step % Math.max(1, N);
    for (let i = 0; i < N; i++) {
      const lit = i <= pos;
      ctx.write(i, lit ? pal[i % pal.length] : pal[pal.length - 1], lit ? 255 : bed, 0);
    }
  },

  split(ctx) {
    const pal = paletteOf(ctx);
    for (let i = 0; i < ctx.fixtureCount; i++) {
      ctx.write(i, pal[(i + ctx.step) % pal.length], 255, 0);
    }
  },

  sections(ctx) {
    const pal = paletteOf(ctx);
    const N = Math.max(1, ctx.fixtureCount);
    const size = Math.max(1, Math.ceil(N / pal.length));
    const rot = ctx.step % pal.length;
    for (let i = 0; i < N; i++) {
      const block = Math.min(pal.length - 1, Math.floor(i / size));
      ctx.write(i, pal[(block + rot) % pal.length], 255, 0);
    }
  },

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

Object.assign(PATTERN_FUNCS, {
  gradient(ctx) {
    const pal = paletteOf(ctx);
    const span = 0.5 + dyn(ctx, 'width', 0.5);
    const scroll = (ctx.stepPos ?? ctx.step) / 16;
    for (let i = 0; i < ctx.fixtureCount; i++) {
      ctx.write(i, gradientAt(pal, xOf(ctx, i) * span - scroll), 255, 0);
    }
  },

  comet(ctx) {
    const pal = paletteOf(ctx);
    const bed = bedOf(ctx);
    const pos = (ctx.stepPos ?? ctx.step) / 4;
    const tail = 0.12 + 0.3 * (1 - dyn(ctx, 'motion', 0.3));
    const head = frac(pos) * (1 + tail);
    const lap = Math.floor(pos);
    const colour = pal[lap % pal.length];
    for (let i = 0; i < ctx.fixtureCount; i++) {
      const behind = head - xOf(ctx, i);
      if (behind >= 0 && behind < tail) {
        const level = Math.pow(1 - behind / tail, 1.6);
        ctx.write(i, colour, Math.round(bed + (255 - bed) * level), 0);
      } else {
        ctx.write(i, pal[pal.length - 1], bed, 0);
      }
    }
  },

  burst(ctx) {
    const pal = paletteOf(ctx);
    const bed = bedOf(ctx);
    const radius = (ctx.stepPhase ?? 0) * 1.15;
    const width = 0.08 + 0.1 * dyn(ctx, 'decay', 0.25);
    const colour = pal[ctx.step % pal.length];
    for (let i = 0; i < ctx.fixtureCount; i++) {
      const dist = Math.hypot(xOf(ctx, i) - 0.5, yOf(ctx, i) - 0.5) / 0.5;
      const ring = Math.exp(-(((dist - radius) / width) ** 2)) * (1 - 0.5 * Math.min(1, radius));
      ctx.write(i, ring > 0.2 ? colour : pal[pal.length - 1], Math.round(bed + (255 - bed) * ring), 0);
    }
  },

  plasma(ctx) {
    const pal = paletteOf(ctx);
    const t = ((ctx.stepPos ?? ctx.step) * Math.PI * 2) / 32;
    const f = (0.6 + 1.4 * dyn(ctx, 'width', 0.5)) * Math.PI * 2;
    const floor = 20 + 60 * dyn(ctx, 'air', 0.3);
    for (let i = 0; i < ctx.fixtureCount; i++) {
      const x = xOf(ctx, i);
      const y = yOf(ctx, i);
      const v = (Math.sin(x * f + t) + Math.sin(y * f * 0.8 - t * 1.3) + Math.sin((x + y) * f * 0.5 + t * 0.7) + 3) / 6;
      ctx.write(i, gradientAt(pal, v), Math.round(floor + Math.pow(v, 1.5) * (255 - floor)), 0);
    }
  },

  meter(ctx) {
    const pal = paletteOf(ctx);
    const bed = bedOf(ctx);
    const p = ctx.pulse;
    const kick = (p ? p.kick : Math.pow(1 - (ctx.stepPhase ?? 0), 3)) * 0.15;
    const low = p ? (p.bass ?? p.mix) : dyn(ctx, 'bass', 0.5);
    const loud = p ? p.mix : dyn(ctx, 'level', 0.8);
    const fill = Math.min(1, loud * (0.25 + 0.75 * low) * 0.85 + kick);
    for (let i = 0; i < ctx.fixtureCount; i++) {
      const x = xOf(ctx, i);
      if (x > fill) ctx.write(i, pal[pal.length - 1], bed, 0);
      else ctx.write(i, fill - x < 0.08 ? pal[1 % pal.length] : pal[0], 255, 0);
    }
  },

  drums(ctx) {
    const pal = paletteOf(ctx);
    const bed = Math.round(bedOf(ctx) * 0.6);
    const hits = ctx.pulse ?? kitFromTheClock(ctx);
    const reach = 0.15 + 0.85 * hits.kick;
    const hatSeed = Math.floor((ctx.stepPos ?? ctx.step) * 2);
    for (let i = 0; i < ctx.fixtureCount; i++) {
      const fromMiddle = Math.abs(xOf(ctx, i) - 0.5) * 2;
      const kick = hits.kick * clamp01((reach - fromMiddle) / 0.12);
      const snare = hits.snare * clamp01((fromMiddle - 0.55) / 0.3);
      const hat = scatter(i, hatSeed) < 0.28 ? hits.hats : 0;
      if (kick >= snare && kick >= hat && kick > 0.02) {
        ctx.write(i, pal[0], Math.round(bed + (255 - bed) * kick), 0);
      } else if (snare >= hat && snare > 0.02) {
        ctx.write(i, pal[1 % pal.length], Math.round(bed + (255 - bed) * snare), 0);
      } else if (hat > 0.02) {
        ctx.write(i, pal[2 % pal.length], Math.round(bed + (255 - bed) * hat), 0);
      } else {
        ctx.write(i, pal[pal.length - 1], bed, 0);
      }
    }
  },

  stems(ctx) {
    const pal = paletteOf(ctx);
    const floor = 10;
    const p = ctx.pulse;
    const levels = p && p.bass !== undefined
      ? [p.vocals ?? 0, p.other ?? 0, p.drums ?? 0, p.bass ?? 0]
      : [dyn(ctx, 'vocal', 0.5), dyn(ctx, 'air', 0.3), p ? p.mix : dyn(ctx, 'level', 0.6), dyn(ctx, 'bass', 0.5)];
    for (let i = 0; i < ctx.fixtureCount; i++) {
      const fromMiddle = Math.min(0.999, Math.abs(xOf(ctx, i) - 0.5) * 2);
      const zone = Math.floor(fromMiddle * 4);
      const v = levels[zone];
      ctx.write(i, pal[zone % pal.length], Math.round(floor + (255 - floor) * Math.pow(v, 1.4)), 0);
    }
  },

  rise(ctx) {
    const pal = paletteOf(ctx);
    const bed = Math.round(bedOf(ctx) * 0.4);
    const progress = ctx.progress ?? frac((ctx.stepPos ?? ctx.step) / 16);
    const fill = 0.04 + 0.96 * progress;
    const stutter = progress > 0.75 ? 0.55 + 0.45 * Math.pow(1 - (ctx.stepPhase ?? 0), 2) : 1;
    const level = (0.35 + 0.65 * progress) * stutter;
    for (let i = 0; i < ctx.fixtureCount; i++) {
      const x = xOf(ctx, i);
      if (x > fill) { ctx.write(i, pal[pal.length - 1], bed, 0); continue; }
      const edge = fill - x < 0.06;
      ctx.write(i, edge ? pal[1 % pal.length] : pal[0], Math.round(255 * (edge ? Math.max(level, 0.85 * stutter) : level)), 0);
    }
  },

  impact(ctx) {
    const pal = paletteOf(ctx);
    const bed = bedOf(ctx);
    const radius = (ctx.stepPhase ?? 0) * 1.15;
    const width = 0.1 + 0.1 * dyn(ctx, 'decay', 0.25);
    const ringColour = pal[ctx.step % pal.length];
    const kick = ctx.pulse ? ctx.pulse.kick : Math.exp(-(ctx.stepPhase ?? 0) * 5);
    const sparkSeed = Math.floor((ctx.stepPos ?? ctx.step) * 4);
    const density = 0.06 + 0.22 * kick;
    for (let i = 0; i < ctx.fixtureCount; i++) {
      const dist = Math.hypot(xOf(ctx, i) - 0.5, yOf(ctx, i) - 0.5) / 0.5;
      const ring = Math.exp(-(((dist - radius) / width) ** 2)) * (1 - 0.45 * Math.min(1, radius));
      const spark = scatter(i, sparkSeed) < density ? kick : 0;
      if (spark > ring && spark > 0.05) {
        ctx.write(i, pal[pal.length - 1], Math.round(bed + (255 - bed) * spark), 0);
      } else {
        ctx.write(i, ring > 0.2 ? ringColour : pal[pal.length - 1], Math.round(bed + (255 - bed) * ring), 0);
      }
    }
  },
} satisfies Record<string, PatternFn>);

Object.assign(PATTERN_FUNCS, {
  bars(ctx) {
    const pal = paletteOf(ctx);
    const bed = Math.round(bedOf(ctx) * 0.3);
    const levels = bandLevels(ctx);
    const rows = heightsOf(ctx);
    for (let i = 0; i < ctx.fixtureCount; i++) {
      const band = Math.min(levels.length - 1, Math.floor(xOf(ctx, i) * levels.length));
      const level = levels[band];
      if (!rows) {
        ctx.write(i, pal[band % pal.length], Math.round(bed + (255 - bed) * Math.pow(level, 1.2)), 0);
        continue;
      }
      const height = rows(i);
      if (height > level) { ctx.write(i, pal[pal.length - 1], bed, 0); continue; }
      const top = level - height < 0.07;
      ctx.write(i, gradientAt(pal, height * (pal.length - 1) / pal.length), top ? 255 : Math.round(170 + 60 * height), 0);
    }
  },

  fire(ctx) {
    const pal = paletteOf(ctx);
    const p = ctx.pulse;
    const low = p ? (p.bass ?? p.mix) : dyn(ctx, 'bass', 0.5);
    const kick = p ? p.kick : Math.exp(-(ctx.stepPhase ?? 0) * 4) * 0.6;
    const heat = 0.3 + 0.45 * low + 0.3 * kick;
    const t = (ctx.stepPos ?? ctx.step) * 0.6;
    const rows = heightsOf(ctx);
    const far = pal.length > 1 ? (pal.length - 1) / pal.length : 0;
    for (let i = 0; i < ctx.fixtureCount; i++) {
      const x = xOf(ctx, i);
      const height = rows ? rows(i) : x;
      const across = rows ? x : 0.5;
      const flame = heat * (0.55 + 0.9 * noise2(across * 7, t * 0.8, 11));
      const lick = 0.75 + 0.25 * noise2(across * 13, height * 6 - t * 3, 29);
      const v = clamp01((flame - height) / Math.max(0.05, flame)) * lick;
      ctx.write(i, gradientAt(pal, (1 - v) * far), Math.round(255 * Math.pow(v, 0.9)), 0);
    }
  },

  rain(ctx) {
    const pal = paletteOf(ctx);
    const bed = Math.round(bedOf(ctx) * 0.25);
    const t = (ctx.stepPos ?? ctx.step) / 4;
    const trail = 0.2 + 0.35 * (1 - dyn(ctx, 'motion', 0.4));
    const hats = ctx.pulse ? ctx.pulse.hats : kitFromTheClock(ctx).hats;
    const sparkSeed = Math.floor((ctx.stepPos ?? ctx.step) * 4);
    const rows = heightsOf(ctx);
    for (let i = 0; i < ctx.fixtureCount; i++) {
      const x = xOf(ctx, i);
      const depth = rows ? rows(i) : x;
      const fall = rows ? 1 - depth : depth;
      const column = rows ? Math.round(x * 997) : 0;
      let level = 0;
      let head = false;
      for (let k = 0; k < (rows ? 1 : 3); k++) {
        const speed = 0.7 + 0.6 * scatter(column, 3 + k);
        const at = frac(t * speed + scatter(column, 17 + k)) * (1 + trail);
        const behind = at - fall;
        if (behind >= 0 && behind < trail) {
          const here = Math.pow(1 - behind / trail, 2);
          if (here > level) { level = here; head = behind < 0.05; }
        }
      }
      const spark = scatter(i, sparkSeed) < 0.04 * hats ? hats : 0;
      if (spark > level) ctx.write(i, pal[pal.length - 1], Math.round(bed + (255 - bed) * spark), 0);
      else if (level > 0) ctx.write(i, head ? pal[pal.length - 1] : pal[0], Math.round(bed + (255 - bed) * level), 0);
      else ctx.write(i, pal[0], bed, 0);
    }
  },
} satisfies Record<string, PatternFn>);

const FLASH_MS = 45;
const FLASH_MAX_MS = 80;
const MIN_SLOT_MS = 90;
// Bound replay cost for sparse flashes, including direct preview seeks.
const SCATTER_LOOKBACK = 32;
const DEFAULT_STEP_MS = 500;
const STROBE_WHITE: Colour = { r: 255, g: 255, b: 255, w: 255, a: 0, uv: 0 };

function stepMsOf(ctx: PatternContext): number {
  return ctx.stepMs && ctx.stepMs > 0 ? ctx.stepMs : DEFAULT_STEP_MS;
}

function flashGrid(ctx: PatternContext, want: number): { slot: number; phase: number; slotMs: number } {
  const stepMs = stepMsOf(ctx);
  let perStep = want;
  while (perStep > 1 / 16 && stepMs / perStep < MIN_SLOT_MS) perStep /= 2;
  const pos = (ctx.stepPos ?? ctx.step) * perStep;
  return { slot: Math.floor(pos), phase: frac(pos), slotMs: stepMs / perStep };
}

function flashLit(phase: number, slotMs: number): boolean {
  return phase * slotMs < Math.min(FLASH_MAX_MS, Math.max(FLASH_MS, 0.35 * slotMs));
}

const ranks = new WeakMap<readonly number[], { rank: number[]; count: number }>();
function rankOf(ctx: PatternContext): { rank: (i: number) => number; count: number } {
  const n = ctx.fixtureCount;
  if (!ctx.xs) return { rank: (i) => i, count: n };
  let known = ranks.get(ctx.xs);
  if (!known || known.rank.length !== n) {
    const places = [...new Set(ctx.xs.slice(0, n).map((x) => Math.round(x * 1e4)))].sort((a, b) => a - b);
    const index = new Map(places.map((x, k) => [x, k]));
    known = { rank: ctx.xs.slice(0, n).map((x) => index.get(Math.round(x * 1e4)) as number), count: places.length };
    ranks.set(ctx.xs, known);
  }
  const { rank } = known;
  return { rank: (i) => rank[i], count: known.count };
}

function fromMiddle(ctx: PatternContext, i: number): number {
  const x = xOf(ctx, i) - 0.5;
  const y = ctx.ys ? yOf(ctx, i) - 0.5 : 0;
  return Math.min(1, Math.hypot(x, y) / 0.5);
}

Object.assign(PATTERN_FUNCS, {
  'flash-chase'(ctx) {
    const pal = paletteOf(ctx);
    const { rank, count } = rankOf(ctx);
    const N = Math.max(1, count);
    const stepMs = stepMsOf(ctx);
    let steps = 1;
    while (steps < 16 && (stepMs * steps) / N < FLASH_MS) steps *= 2;
    const pos = (ctx.stepPos ?? ctx.step) / steps;
    const lap = Math.floor(pos);
    const along = frac(pos) * N;
    const head = Math.min(N - 1, Math.floor(along));
    const zoneMs = (stepMs * steps) / N;
    const lit = flashLit(frac(along), zoneMs);
    const colour = pal[lap % pal.length];
    for (let i = 0; i < ctx.fixtureCount; i++) {
      if (isHueSlot(ctx, i)) {
        // Keep the previous lap's colour until this zone flashes again.
        const back = rank(i) <= head ? 0 : 1;
        if (lap - back < 0) { ctx.write(i, colour, 0, 0); continue; }
        ctx.write(i, pal[(lap - back) % pal.length], huePulse((along - rank(i) + back * N) * zoneMs), 0);
        continue;
      }
      ctx.write(i, colour, lit && rank(i) === head ? 255 : 0, 0);
    }
  },

  'flash-scatter'(ctx) {
    const pal = paletteOf(ctx);
    const { slot, phase, slotMs } = flashGrid(ctx, 8);
    const lit = flashLit(phase, slotMs);
    const densityOf = (s: number) => {
      const hats = kitFromTheClock({ ...ctx, stepPhase: frac((s * slotMs) / stepMsOf(ctx)) }).hats;
      return Math.min(0.7, 0.12 + 0.3 * dyn(ctx, 'air', 0.4) + 0.25 * hats);
    };
    const density = densityOf(slot);
    const colourOf = (i: number, s: number) => pal[Math.floor(scatter(i, s + 7919) * pal.length) % pal.length];
    // Bound sparse-history work and share density samples across Hue lamps.
    let before: number[] | null = null;
    for (let i = 0; i < ctx.fixtureCount; i++) {
      if (isHueSlot(ctx, i)) {
        before ??= Array.from({ length: Math.min(SCATTER_LOOKBACK, slot + 1) }, (_, ago) => (ago ? densityOf(slot - ago) : density));
        let ago = 0;
        while (ago < before.length && !(scatter(i, slot - ago) < before[ago])) ago++;
        if (ago < before.length) ctx.write(i, colourOf(i, slot - ago), huePulse((ago + phase) * slotMs), 0);
        else ctx.write(i, colourOf(i, slot), 0, 0);
        continue;
      }
      const on = lit && scatter(i, slot) < density;
      ctx.write(i, colourOf(i, slot), on ? 255 : 0, 0);
    }
  },

  'flash-fill'(ctx) {
    const pal = paletteOf(ctx);
    const phase = ctx.stepPhase ?? 0;
    const cut = phase >= 0.6;
    const colour = pal[ctx.step % pal.length];
    let nearest = 1;
    for (let i = 0; i < ctx.fixtureCount; i++) nearest = Math.min(nearest, fromMiddle(ctx, i));
    const reach = nearest + Math.min(1, phase / 0.3) * (1 - nearest);
    for (let i = 0; i < ctx.fixtureCount; i++) {
      const lit = !cut && fromMiddle(ctx, i) <= reach + 1e-6;
      if (!lit && isHueSlot(ctx, i)) {
        // Keep the previous fill's tail until this fill reaches the zone.
        if (cut) { ctx.write(i, colour, huePulse((phase - 0.6) * stepMsOf(ctx)), 0); continue; }
        if ((ctx.stepPos ?? ctx.step) >= 1) {
          ctx.write(i, pal[(((ctx.step - 1) % pal.length) + pal.length) % pal.length], huePulse((phase + 0.4) * stepMsOf(ctx)), 0);
          continue;
        }
      }
      ctx.write(i, colour, lit ? 255 : 0, 0);
    }
  },

  'flash-alternate'(ctx) {
    const pal = paletteOf(ctx);
    const { rank } = rankOf(ctx);
    const { slot, phase, slotMs } = flashGrid(ctx, 2);
    const half = slot % 2;
    const lit = flashLit(phase, slotMs);
    const colour = pal[half % pal.length];
    for (let i = 0; i < ctx.fixtureCount; i++) {
      if (isHueSlot(ctx, i)) {
        // The inactive half must retain its previous flash's colour.
        const own = rank(i) % 2;
        const ago = (half - own + 2) % 2;
        ctx.write(i, pal[own % pal.length], slot - ago < 0 ? 0 : huePulse((ago + phase) * slotMs), 0);
        continue;
      }
      ctx.write(i, colour, lit && rank(i) % 2 === half ? 255 : 0, 0);
    }
  },

  ramp(ctx) {
    const pal = paletteOf(ctx);
    const phase = ctx.stepPhase ?? 1;
    const colour = pal[ctx.step % pal.length];
    // Let the previous swell decay beneath the new one to soften the beat cut.
    const fall = (ctx.stepPos ?? ctx.step) >= 1 ? huePulse(phase * stepMsOf(ctx)) : 0;
    const before = pal[(((ctx.step - 1) % pal.length) + pal.length) % pal.length];
    for (let i = 0; i < ctx.fixtureCount; i++) {
      const lag = 0.35 * fromMiddle(ctx, i);
      const level = clamp01((phase - lag) / (1 - lag));
      const swell = Math.round(255 * level * level);
      if (isHueSlot(ctx, i) && fall > swell) ctx.write(i, before, fall, 0);
      else ctx.write(i, colour, swell, 0);
    }
  },

  core(ctx) {
    const pal = paletteOf(ctx);
    const level = dyn(ctx, 'level', 0.8);
    const aura = Math.round(110 + 110 * level);
    const grid = flashGrid(ctx, 1);
    const strike = ctx.pulse ? ctx.pulse.kick > 0.6 : flashLit(grid.phase, grid.slotMs);
    const rows = heightsOf(ctx);
    const inCore = rows ? (i: number) => Math.abs(rows(i) - 0.5) < 0.17 : (i: number) => fromMiddle(ctx, i) < 0.34;
    const glow = Math.round(aura * 0.3);
    for (let i = 0; i < ctx.fixtureCount; i++) {
      if (inCore(i) && isHueSlot(ctx, i)) {
        // Keep the core's native glow beneath the softened strike.
        const level = ctx.pulse ? Math.max(glow, Math.round(255 * clamp01(ctx.pulse.kick / 0.6)))
          : huePulse(grid.phase * grid.slotMs, glow);
        ctx.write(i, level > glow ? STROBE_WHITE : pal[0], level, 0);
      } else if (inCore(i)) {
        if (strike) ctx.write(i, STROBE_WHITE, 255, 0);
        else ctx.write(i, pal[0], glow, 0);
      } else {
        ctx.write(i, pal[0], aura, 0);
      }
    }
  },
} satisfies Record<string, PatternFn>);

function heightsOf(ctx: PatternContext): ((i: number) => number) | null {
  const ys = ctx.ys;
  if (!ys || !ys.length) return null;
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < ctx.fixtureCount; i++) {
    const y = ys[i];
    if (y < lo) lo = y;
    if (y > hi) hi = y;
  }
  if (!(hi - lo > 0.02)) return null;
  return (i) => (hi - ys[i]) / (hi - lo);
}

function bandLevels(ctx: PatternContext): number[] {
  const p = ctx.pulse;
  if (p) {
    return [p.kick, p.bass ?? p.mix, p.drums ?? p.mix, p.snare, p.other ?? p.mix * 0.6, p.vocals ?? 0, p.hats].map(clamp01);
  }
  const kit = kitFromTheClock(ctx);
  return [kit.kick, dyn(ctx, 'bass', 0.5), dyn(ctx, 'level', 0.6) * 0.8, kit.snare, dyn(ctx, 'air', 0.3),
    dyn(ctx, 'vocal', 0.4), kit.hats].map(clamp01);
}

function noise2(x: number, y: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const u = x - xi;
  const v = y - yi;
  const at = (a: number, b: number) => scatter(Math.imul(a, 73856093) ^ Math.imul(b, 19349663), seed);
  const su = u * u * (3 - 2 * u);
  const sv = v * v * (3 - 2 * v);
  const top = at(xi, yi) + (at(xi + 1, yi) - at(xi, yi)) * su;
  const bottom = at(xi, yi + 1) + (at(xi + 1, yi + 1) - at(xi, yi + 1)) * su;
  return top + (bottom - top) * sv;
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

function scatter(i: number, seed: number): number {
  let h = Math.imul(i + 1, 0x9E3779B1) ^ Math.imul(seed + 7, 0x85EBCA77);
  h = Math.imul(h ^ (h >>> 15), 0x2C1B3C6D);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

function kitFromTheClock(ctx: PatternContext): { kick: number; snare: number; hats: number } {
  const phase = ctx.stepPhase ?? 0;
  const kick = Math.exp(-phase * 5);
  const offPhase = (phase + 0.5) % 1;
  return {
    kick,
    snare: ctx.step % 2 === 1 ? kick : 0,
    hats: Math.exp(-offPhase * 9) * 0.7,
  };
}

const MAX_LAMP_FLASH_HZ = HOLD_STROBE_MAX_HZ;
const BACKLIGHT = 120;

function posOf(ctx: PatternContext): number {
  return ctx.stepPos ?? ctx.step + (ctx.stepPhase ?? 0);
}

function eventAt(pos: number, steps: number): { event: number; progress: number } {
  const t = pos / steps;
  return { event: Math.floor(t), progress: t - Math.floor(t) };
}

type Curve = 'linear' | 'in' | 'out' | 'inout';

function ease(p: number, curve: Curve): number {
  const x = clamp01(p);
  switch (curve) {
    case 'in': return x * x;
    case 'out': return 1 - (1 - x) * (1 - x);
    case 'inout': return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
    default: return x;
  }
}

function envelope(p: number, attack: number, hold: number, release: number, curve: Curve): number {
  if (p < 0) return 0;
  if (p < attack) return ease(p / attack, curve);
  if (p < attack + hold) return 1;
  if (release > 0 && p < attack + hold + release) return 1 - ease((p - attack - hold) / release, curve);
  return 0;
}

function smoothstep(lo: number, hi: number, v: number): number {
  const t = clamp01((v - lo) / Math.max(1e-9, hi - lo));
  return t * t * (3 - 2 * t);
}

const crest = (phase: number): number => (Math.cos(frac(phase) * Math.PI * 2) + 1) / 2;

function lift(bed: number, level: number): number {
  return Math.round(bed + (255 - bed) * clamp01(level));
}

// Beat fractions must not tip a pulse across a dimmer rounding boundary.
const huePulse = (sinceMs: number, floor?: number): number => huePulseLevel(Math.round(sinceMs * 1000) / 1000, floor);

const isHueSlot = (ctx: PatternContext, i: number): boolean => ctx.hueStrobe !== 'flash' && !!ctx.noFlash && !!ctx.noFlash[i];

function flashEvery(ctx: PatternContext, lamps: number): number {
  const stepMs = stepMsOf(ctx);
  let every = 1;
  while (every < 16 && stepMs * every * Math.max(1, lamps) < 1000 / MAX_LAMP_FLASH_HZ) every *= 2;
  return every;
}

function ringStrobe(ctx: PatternContext, backlit: boolean): void {
  const pal = paletteOf(ctx);
  const room = roomOf(ctx);
  const n = room.n;
  const every = flashEvery(ctx, n);
  const slotMs = stepMsOf(ctx) * every;
  const slotPos = posOf(ctx) / every;
  const slot = Math.floor(slotPos);
  const phase = slotPos - slot;
  const head = ((slot % n) + n) % n;
  const lit = flashLit(phase, slotMs);
  const rest = pal[1 % pal.length];
  for (let i = 0; i < ctx.fixtureCount; i++) {
    const r = room.ring[i];
    const ago = (head - r + n) % n;
    const lap = Math.floor((slot - ago) / n);
    const colour = backlit ? pal[0] : pal[((lap % pal.length) + pal.length) % pal.length];
    if (isHueSlot(ctx, i)) {
      const sinceMs = (ago + phase) * slotMs;
      if (backlit && sinceMs >= HUE_PULSE_MS) ctx.write(i, rest, BACKLIGHT, 0);
      else ctx.write(i, colour, huePulse(sinceMs, backlit ? BACKLIGHT : HUE_PULSE_FLOOR), 0);
    } else if (ago === 0 && lit) {
      ctx.write(i, colour, 255, 0);
    } else {
      ctx.write(i, backlit ? rest : colour, backlit ? BACKLIGHT : 0, 0);
    }
  }
}

function burstOrigin(event: number, n: number): number {
  const at = (e: number) => Math.floor(scatter(e, 9001) * n) % n;
  const here = at(event);
  return here === at(event - 1) ? (here + 1) % n : here;
}

const PARTY_PATTERNS = {

  'position-chase'(ctx: PatternContext) {
    const pal = paletteOf(ctx);
    const bed = bedOf(ctx);
    const room = roomOf(ctx);
    const STAGGER = 0.5;
    const ATTACK = 0.125; const HOLD = 0.125; const RELEASE = 0.375;
    const length = Math.max(1, Math.ceil((room.n - 1) * STAGGER + ATTACK + HOLD + RELEASE));
    const { event: run, progress } = eventAt(posOf(ctx), length);
    const into = progress * length;
    const rank = room.rankAlong((run * 90) % 360);
    for (let i = 0; i < ctx.fixtureCount; i++) {
      const level = envelope(into - rank[i] * STAGGER, ATTACK, HOLD, RELEASE, 'out');
      const colour = pal[(rank[i] + run) % pal.length];
      ctx.write(i, level > 0 ? colour : pal[pal.length - 1], lift(bed, level), 0);
    }
  },

  'radial-pulse'(ctx: PatternContext) {
    const pal = paletteOf(ctx);
    const bed = bedOf(ctx);
    const room = roomOf(ctx);
    const { event, progress } = eventAt(posOf(ctx), 4);
    const env = envelope(progress, 0.3, 0.2, 0.5, 'inout');
    const bass = ctx.pulse ? (ctx.pulse.bass ?? ctx.pulse.mix) : dyn(ctx, 'bass', 0.6);
    const drive = 0.4 + 0.6 * bass;
    for (let i = 0; i < ctx.fixtureCount; i++) {
      const d = room.dist[i];
      const ring = 1 - smoothstep(0.12, 0.45, Math.abs(d - progress));
      ctx.write(i, gradientAt(pal, (d + progress) / 2 + event / pal.length), lift(bed, env * ring * drive), 0);
    }
  },

  'spatial-wash'(ctx: PatternContext) {
    const pal = paletteOf(ctx);
    const bed = bedOf(ctx);
    const room = roomOf(ctx);
    const { event, progress } = eventAt(posOf(ctx), 4);
    const wash = (e: number, p: number): [number[], number[]] => {
      const env = envelope(p, 0.375, 0.25, 0.5, 'inout');
      const along = room.along(((e * 90) % 360 + 360) % 360);
      const phases: number[] = []; const levels: number[] = [];
      for (let i = 0; i < ctx.fixtureCount; i++) {
        const phase = along[i] - p + 0.11 * e;
        phases.push(phase);
        levels.push(env * (0.35 + 0.65 * Math.pow(crest(phase), 1.5)));
      }
      return [levels, phases];
    };
    const [now, nowPhase] = wash(event, progress);
    const [before, beforePhase] = wash(event - 1, 1 + progress);
    for (let i = 0; i < ctx.fixtureCount; i++) {
      const fromNow = now[i] >= before[i];
      ctx.write(i, gradientAt(pal, fromNow ? nowPhase[i] : beforePhase[i]), lift(bed, fromNow ? now[i] : before[i]), 0);
    }
  },

  'bounce-scan'(ctx: PatternContext) {
    const pal = paletteOf(ctx);
    const bed = bedOf(ctx);
    const room = roomOf(ctx);
    const { event, progress } = eventAt(posOf(ctx), 4);
    const along = room.along(28);
    const head = 1 - Math.abs(progress * 2 - 1);
    const pass = event * 2 + (progress >= 0.5 ? 1 : 0);
    const colour = pal[pass % pal.length];
    for (let i = 0; i < ctx.fixtureCount; i++) {
      const level = Math.exp(-4.5 * Math.pow((along[i] - head) / 0.18, 2));
      ctx.write(i, level > 0.05 ? colour : pal[pal.length - 1], lift(bed, level), 0);
    }
  },

  streak(ctx: PatternContext) {
    const pal = paletteOf(ctx);
    const bed = bedOf(ctx);
    const room = roomOf(ctx);
    const { event, progress } = eventAt(posOf(ctx), 2);
    const rest = pal[pal.length - 1];
    if (scatter(event, 4242) > 0.68) {
      for (let i = 0; i < ctx.fixtureCount; i++) ctx.write(i, rest, bed, 0);
      return;
    }
    const reverse = scatter(event, 77) >= 0.5;
    const along = room.along(42);
    const TRAIL = 0.25;
    const head = progress * (1 + 2 * TRAIL);
    const colour = pal[event % pal.length];
    for (let i = 0; i < ctx.fixtureCount; i++) {
      const behind = head - (reverse ? 1 - along[i] : along[i]);
      const level = behind >= 0 && behind <= TRAIL * 4 ? Math.exp((-3.2 * behind) / TRAIL) : 0;
      ctx.write(i, level > 0 ? colour : rest, lift(bed, level), 0);
    }
  },

  starlight(ctx: PatternContext) {
    const pal = paletteOf(ctx);
    const bed = Math.round(bedOf(ctx) * 0.3);
    const { event, progress } = eventAt(posOf(ctx), 1);
    for (let i = 0; i < ctx.fixtureCount; i++) {
      const roll = scatter(i, event * 131 + 1);
      const level = roll <= 0.35 ? 0.82 * envelope(progress, 0, 0.08, 0.72, 'out') : 0;
      ctx.write(i, gradientAt(pal, roll + event * 0.07), lift(bed, level), 0);
    }
  },

  breathe(ctx: PatternContext) {
    const pal = paletteOf(ctx);
    const { event, progress } = eventAt(posOf(ctx), 4);
    const env = envelope(progress, 0.4, 0.15, 0.4, 'inout');
    const colour = gradientAt(pal, progress * 0.3 + event * 0.17);
    const dim = Math.round(25 + 230 * env);
    for (let i = 0; i < ctx.fixtureCount; i++) ctx.write(i, colour, dim, 0);
  },

  'volume-gate'(ctx: PatternContext) {
    const pal = paletteOf(ctx);
    const room = roomOf(ctx);
    const { event, progress } = eventAt(posOf(ctx), 8);
    const loud = ctx.pulse ? ctx.pulse.mix : dyn(ctx, 'level', 0.8);
    const gate = clamp01((loud - 0.25) / 0.75);
    const open = 0.2 + 0.8 * gate;
    const along = room.along(90);
    for (let i = 0; i < ctx.fixtureCount; i++) {
      const phase = along[i] - progress + 0.11 * event;
      ctx.write(i, gradientAt(pal, phase), Math.round(255 * (0.72 + 0.28 * crest(phase)) * open), 0);
    }
  },

  confetti(ctx: PatternContext) {
    const pal = paletteOf(ctx);
    const every = Math.max(1, Math.ceil(400 / stepMsOf(ctx)));
    const { event, progress } = eventAt(posOf(ctx), every);
    const env = ctx.pulse ? ctx.pulse.kick : envelope(progress, 0, 0.17, 0.46, 'out');
    for (let i = 0; i < ctx.fixtureCount; i++) {
      const lit = scatter(i, event * 17 + 3) < 0.75;
      const colour = gradientAt(pal, scatter(i, event * 17 + 9) + event * 0.31);
      ctx.write(i, colour, lit ? Math.round(255 * env) : 0, 0);
    }
  },

  'anchor-fill'(ctx: PatternContext) {
    const pal = paletteOf(ctx);
    const room = roomOf(ctx);
    const count = room.anchorCount();
    const channel = room.channels(count);
    const step = Math.max(0, Math.floor(posOf(ctx)));
    const k = step % count;
    const lap = Math.floor(step / count);
    const fresh = pal[lap % pal.length];
    const last = pal[(lap - 1 + pal.length) % pal.length];
    for (let i = 0; i < ctx.fixtureCount; i++) ctx.write(i, channel[i] <= k ? fresh : last, 255, 0);
  },

  halves(ctx: PatternContext) {
    const pal = paletteOf(ctx);
    const room = roomOf(ctx);
    const step = Math.max(0, Math.floor(posOf(ctx)));
    const depth = step % 2 === 0;
    const half = room.halves(depth ? 'depth' : 'width');
    const swap = step % 4 >= 2 ? 1 : 0;
    for (let i = 0; i < ctx.fixtureCount; i++) {
      const side = depth ? 1 - half[i] : half[i];
      ctx.write(i, pal[(side ^ swap) % pal.length], 255, 0);
    }
  },

  flip(ctx: PatternContext) {
    const pal = paletteOf(ctx);
    const room = roomOf(ctx);
    const channel = room.channels(4);
    const step = Math.max(0, Math.floor(posOf(ctx)));
    for (let i = 0; i < ctx.fixtureCount; i++) ctx.write(i, pal[((channel[i] % 2) + step) % 2 % pal.length], 255, 0);
  },

  'room-wave'(ctx: PatternContext) {
    const pal = paletteOf(ctx);
    const bed = bedOf(ctx);
    const room = roomOf(ctx);
    const { event: lap, progress } = eventAt(posOf(ctx), 4);
    const along = room.along(Math.round(25.7 + 51.4 * (((lap % 7) + 7) % 7)) % 360);
    for (let i = 0; i < ctx.fixtureCount; i++) {
      const travel = along[i] - progress;
      ctx.write(i, gradientAt(pal, travel), lift(bed, Math.pow(crest(travel / 2), 1.3)), 0);
    }
  },

  'ring-strobe'(ctx: PatternContext) { ringStrobe(ctx, false); },

  'ring-backlit'(ctx: PatternContext) { ringStrobe(ctx, true); },

  fireworks(ctx: PatternContext) {
    const pal = paletteOf(ctx);
    const bed = Math.round(bedOf(ctx) * 0.3);
    const room = roomOf(ctx);
    const pos = posOf(ctx);
    const event = Math.floor(pos);
    for (let i = 0; i < ctx.fixtureCount; i++) {
      let best = 0;
      let colour = pal[pal.length - 1];
      for (let e = event; e >= 0 && e > event - 5; e--) {
        const o = burstOrigin(e, room.n);
        const d = Math.hypot(room.x[i] - room.x[o], room.y[i] - room.y[o]) / 2;
        const age = pos - e - d * 0.5;
        const level = envelope(age, 0, 0.3, 3.7, 'out') * (1 - 0.65 * Math.pow(d, 0.7));
        if (level > best) {
          best = level;
          colour = gradientAt(pal, e / pal.length + 0.15 * d);
        }
      }
      ctx.write(i, colour, lift(bed, best), 0);
    }
  },

  flashes(ctx: PatternContext) {
    const pal = paletteOf(ctx);
    const bed = Math.round(bedOf(ctx) * 0.3);
    const every = flashEvery(ctx, 1);
    const stepMs = stepMsOf(ctx) * every;
    const { event, progress } = eventAt(posOf(ctx), every);
    for (let i = 0; i < ctx.fixtureCount; i++) {
      const lit = (e: number) => scatter(i, e * 53 + 11) < 0.35;
      const colourOf = (e: number) => pal[Math.floor(scatter(i, e * 53 + 29) * pal.length) % pal.length];
      if (isHueSlot(ctx, i)) {
        let ago = 0;
        while (ago < 8 && !lit(event - ago)) ago++;
        if (ago >= 8) { ctx.write(i, colourOf(event), bed, 0); continue; }
        ctx.write(i, colourOf(event - ago), Math.max(bed, huePulse((ago + progress) * stepMs)), 0);
        continue;
      }
      const level = lit(event) ? envelope(progress, 0, 0.12, 0.08, 'out') : 0;
      ctx.write(i, colourOf(event), lift(bed, level), 0);
    }
  },

  swirl(ctx: PatternContext) {
    const pal = paletteOf(ctx);
    const bed = bedOf(ctx);
    const room = roomOf(ctx);
    const t = posOf(ctx) / 8;
    for (let i = 0; i < ctx.fixtureCount; i++) {
      const phase = room.turn[i] - t;
      ctx.write(i, gradientAt(pal, phase), lift(bed, Math.pow(crest(phase), 1.2)), 0);
    }
  },
} satisfies Record<string, PatternFn>;

Object.assign(PATTERN_FUNCS, PARTY_PATTERNS);

export {
  PATTERN_FUNCS,
  CELL_PATTERNS,
  paletteOf,
  hsvToRgb,
  bedOf,
  BED,
  gradientAt,
  roomOf,
  PARTY_PATTERNS,
  MAX_LAMP_FLASH_HZ,
  BACKLIGHT,
};
