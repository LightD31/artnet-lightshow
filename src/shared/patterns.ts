import { colourMixer } from './color.ts';
import type { Colour, Expression, PulseReading } from '../types/rig.ts';

// Pure pattern functions. Each takes (ctx) where:
//   ctx.colors        : array of resolved Colour A..D presets
//   ctx.fixtureCount  : N slots — fixtures, or for a CELL_PATTERNS entry every
//                       cell of every bar (see shared/layer.js)
//   ctx.step          : steps of the beat grid since the scene's anchor
//                       (shared/beat-clock.js)
//   ctx.stepPos       : the same count, continuous (2.5 is halfway through the
//                       third step)
//   ctx.stepPhase     : how far through the current step, 0..1
//   ctx.phase         : the expressive patterns' travel, 0..1, moved by motion
//   ctx.hue           : rotating hue for color-cycle / rainbow
//   ctx.twinkle       : per-slot stochastic memory (mutated for 'twinkle')
//   ctx.xs, ctx.ys    : each slot's place across the rig, 0..1 (xs may be null:
//                       even spacing); ys on the same scale, or null
//   ctx.progress      : how far through its span a picture that plays once
//                       (a build-up's fill) has got, 0..1, or null
//   ctx.stepMs        : how long a step lasts at the tempo, in ms, or null —
//                       what times the strobe effects' flashes
//   ctx.write(i, color, dim, strobe) — sets slot i's render colour
//
// 'fade' and 'hit' are whole-rig envelopes: the engine and the preview set
// their brightness from the beat position themselves (beat-clock.js
// fadePhase / hitPhase); the functions here only seed the colour.

/** What a pattern is handed for one frame (see shared/layer.ts). */
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
  /** The music at pixel rate (show/pulse.ts), or null: every pattern has to
   *  look right without it — the preview, a manual look, an older analysis. */
  pulse?: Readonly<PulseReading> | null;
  /** How far through its span a picture that plays once has got, 0..1, or
   *  null when the scene gave it none (see shared/layer.ts). */
  progress?: number | null;
  /** How long one step lasts at the tempo, in ms, or null when it is not known. */
  stepMs?: number | null;
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
function bedOf(ctx: PatternContext): number {
  const d = ctx.dynamics;
  if (!d) return BED;
  const level = d.level == null ? 1 : d.level;
  return Math.round(Math.max(0, Math.min(120, (12 + 90 * (d.air ?? .3)) * level)));
}

/** A 0..1 reading from the expression channel, or a default without one. */
function dyn(ctx: PatternContext, key: keyof Expression, fallback: number): number {
  const value = ctx.dynamics ? ctx.dynamics[key] : undefined;
  return value !== undefined && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : fallback;
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
function paletteOf(ctx: Pick<PatternContext, 'colors'>): Colour[] {
  const out: Colour[] = [];
  for (const c of ctx.colors) if (c && !out.includes(c)) out.push(c);
  return out.length ? out : [{ r: 0, g: 0, b: 0, w: 0, a: 0, uv: 0 }];
}

// Patterns that are a picture across the rig rather than a sequence of lamps:
// they run on every cell of every bar, so a wave rolls smoothly along a bar
// instead of the whole bar taking one colour. The rest step through fixtures,
// and a bar takes its slot's colour on every cell.
const CELL_PATTERNS = new Set([
  'ensemble', 'ribbon', 'wave', 'rainbow', 'twinkle', 'sparkle',
  'gradient', 'comet', 'burst', 'plasma', 'meter', 'drums', 'stems',
  'rise', 'impact', 'bars', 'fire', 'rain',
  'flash-chase', 'flash-scatter', 'flash-fill', 'flash-alternate', 'ramp', 'core',
]);

/** Where slot i sits across the rig, 0..1: its placed position, or even spacing. */
function xOf(ctx: PatternContext, i: number): number {
  if (ctx.xs) return ctx.xs[i];
  return ctx.fixtureCount > 1 ? i / (ctx.fixtureCount - 1) : 0.5;
}

/** And front to back, on the same scale; the middle when nothing says. */
function yOf(ctx: PatternContext, i: number): number {
  return ctx.ys ? ctx.ys[i] : 0.5;
}

const frac = (v: number): number => v - Math.floor(v);

// ── Palette gradients ────────────────────────────────────────────────────────
// The pixel effects paint a continuous gradient through the look's colours, A
// into B into C and back round to A. Blending round the colour wheel (see
// color.js) is too costly to do for every cell of every bar forty times a
// second, so each palette's gradient is worked out once, 64 steps between each
// pair of colours, and looked up. Engine and preview share this table, so
// they paint the same colour for the same place.
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
        // The ends are the palette's own colours, by reference, so a look
        // that lands exactly on one shows exactly that preset.
        table.push(s === 0 ? pal[k] : mix(s / GRADIENT_STEPS));
      }
    }
    gradients.set(key, table);
  }
  return table;
}

/** The colour at `p` round the palette's cycle (0 and 1 are colour A). */
function gradientAt(pal: readonly Colour[], p: number): Colour {
  if (pal.length === 1) return pal[0];
  const table = gradientOf(pal);
  return table[Math.floor(frac(p) * table.length) % table.length];
}

const PATTERN_FUNCS: Record<string, PatternFn> = {
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
      // Where this lamp stands across the rig: the operator's placement when
      // there is one (see shared/stage.js), even spacing otherwise. With real
      // positions the centre is the middle of the stage, not the middle of
      // the patch list.
      const x = ctx.xs ? ctx.xs[i] : ctx.fixtureCount > 1 ? i / (ctx.fixtureCount - 1) : .5;
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
    // Round the colour wheel rather than through the middle of it: A and B are
    // opposites, and averaging them per channel left a washed-out grey band
    // across the middle of the rig. See shared/color.js.
    const mix = pal.length === 1 ? null : colourMixer(pal[0], pal[1 % pal.length]);
    for (let i = 0; i < ctx.fixtureCount; i++) {
      const x = ctx.xs ? ctx.xs[i] : i / Math.max(1, ctx.fixtureCount - 1);
      const wave = (1 + Math.sin(phase * Math.PI * 2 + x * d.width * Math.PI * 2)) / 2;
      const crest = Math.pow(wave, 1.5);
      ctx.write(i, mix ? mix(wave) : pal[0], Math.round(floor + crest * (255 - floor)), 0);
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
      // The lamp's real place across the rig, scaled to the range i/N covers.
      // Without positions this is the original expression, operand for operand:
      // an unplaced rig must render exactly as it always has, and reordering the
      // arithmetic can move a rounded DMX value by one.
      const offset = ctx.xs
        ? (ctx.xs[i] * (N - 1) / N) * Math.PI * 2 * spread
        : (i * (Math.PI * 2 / N) * spread);
      const phase = (ctx.step * (Math.PI * 2 / 8)) - offset;
      const b = Math.round(((Math.sin(phase) + 1) / 2) * 215 + 40);
      ctx.write(i, colA, b, 0);
    }
  },

  // One more lamp on every step until the rig is full, then back to one. It
  // used to count an empty step as well — N + 1 steps a stack — so four lamps
  // stacked over five steps and drifted a step against the bar every time
  // round, with the downbeat, of all steps, the dark one. N steps a stack puts
  // a full rig on the bar's last step and the first lamp on the next downbeat.
  'stack-up'(ctx) {
    const pal = paletteOf(ctx);
    const bed = bedOf(ctx);
    const N = ctx.fixtureCount;
    const pos = ctx.step % Math.max(1, N);
    for (let i = 0; i < N; i++) {
      const lit = i <= pos;
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

// ── Pixel effects ─────────────────────────────────────────────────────────────
//
// Built for LED bars: pictures drawn across every cell, not a colour per
// lamp. They run on a rig of pars too — four lamps are four samples of the
// same picture — but they come into their own when a bar has sixteen cells to
// draw it with. All are functions of where a cell is and where the music is
// (ctx.stepPos, ctx.stepPhase), so the rehearsal preview draws exactly what
// the rig will.

Object.assign(PATTERN_FUNCS, {
  // The look's colours laid out as a gradient across the rig, scrolling one
  // full cycle every sixteen steps. Wider music spreads it further.
  gradient(ctx) {
    const pal = paletteOf(ctx);
    const span = 0.5 + dyn(ctx, 'width', 0.5);
    const scroll = (ctx.stepPos ?? ctx.step) / 16;
    for (let i = 0; i < ctx.fixtureCount; i++) {
      ctx.write(i, gradientAt(pal, xOf(ctx, i) * span - scroll), 255, 0);
    }
  },

  // A bright head crossing the rig every four steps, trailing a tail that is
  // long when the music is barely moving and short when it drives. The head
  // runs on past the far side until its tail has left the rig, so a lap ends
  // dark rather than lighting both ends at once, and each lap takes the next
  // colour of the look.
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

  // A ring thrown out from the middle of the stage on every step, fading as
  // it goes; decay in the music widens it into a softer wave.
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

  // Slow interference of three waves across the rig, in the look's colours: a
  // field that never repeats the same way twice in a phrase. Texture in the
  // music lifts the dark parts of it.
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

  // A level meter across the rig, filled by the low end of the music and
  // kicked a little further on every step. Laid out mirrored, it fills from
  // the middle out; per bar, every bar is its own meter.
  meter(ctx) {
    const pal = paletteOf(ctx);
    const bed = bedOf(ctx);
    // With the pulse, the low end is the bass stem and the kick is the kick
    // as it was hit; without it, the expression channel and the step.
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

  // The kit, as it is played: the kick fills the bar from its middle and falls
  // back, the snare cracks at its two ends, the hats light a scatter of cells
  // that moves on with every hit. With the pulse these are the real hits read
  // off the drum stem; without one, a kick on every step, a snare on every
  // other and a hat between, so the pattern still reads in the preview and on
  // a manual look.
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
      // The strongest of the three owns the cell.
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

  // The arrangement, laid out from the middle of the rig: the voice at the
  // centre, then the rest of the band, the drums, and the bass at the far
  // ends, each zone as loud as its stem is playing and in its own colour. On
  // a track that was not separated the expression channel stands in for the
  // stems.
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

  // A build-up, drawn: the rig fills from where the picture starts — the
  // middle, laid out mirrored — as the build goes on, and is full on the
  // drop. With a span (the build's length) the fill follows it exactly;
  // without one it fills once every sixteen steps. The edge of the fill is
  // the brightest cell, and in the last quarter the whole fill stutters on
  // every step, the way the snare roll under it does.
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

  // A drop, drawn: a ring thrown out from the middle of the stage on every
  // step, and sparks scattered over the whole rig on every kick — the kick as
  // it was hit when the analysis has the pulse, one on every step when not.
  // The sparks take the look's lift (its last colour), so they read against
  // the ring rather than as more of it.
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

// ── Panels ──────────────────────────────────────────────────────────────────
// Pictures after LedFx's and WLED's matrix effects. On a panel — cells with a
// height, as a WLED matrix has — they stand up: bars rise, flames lick and
// rain falls from its top to its bottom. On a strip, which has no height, the
// strip is laid along that height instead, so each still reads.

Object.assign(PATTERN_FUNCS, {
  // A spectrum analyser, after LedFx's bars: the band as it plays, a column
  // each for the kick, the bass, the drums, the snare, the rest of the band,
  // the voice and the hats, left to right, each filled from the bottom as high
  // as it is loud, the colour running up the look's gradient, its top cell the
  // brightest. On a strip each band lights its stretch as bright as it plays.
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

  // Fire, after WLED's and LedFx's: flames licking up from the bottom, taller
  // as the bass pushes and flaring on every kick, hottest at the root in the
  // look's first colour and cooling to its last at the tips. Noise on the
  // clock rather than a simulation, so every frame is the same for the same
  // moment: the preview and the rig burn alike.
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

  // Rain, after the digital rain every matrix plays: drops falling down each
  // column in time, a lap every four steps, each column at its own speed and
  // offset, with a trail that is long in slow music and short in driving
  // music; the head is the look's lift, the trail its first colour, and the
  // hats shake loose a scatter of extra drops. On a strip, three drops run
  // along it.
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
      // From the top: a panel's rows count down from it, a strip from its start.
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

// ── Strobe effects ──────────────────────────────────────────────────────────
// After the built-in programs of the hybrid strobes — a Jolt Panel, a Super
// Strobe ABL, a Color STRIKE, an Atomic Dot and the rest of that family: a
// strobe split into zones, each flashing on its own. What makes them strobes
// rather than pictures is that every one is hard flashes on black, timed in
// milliseconds as a strobe's flash is, not a picture drifting across the
// cells. Laid out per bar, every bar runs the program itself, as the
// fixtures do; across the stage, the rig is one long strobe.

// A flash: two frames at the engine's 44 a second, so none falls between two,
// and not much longer, or it reads as a blink.
const FLASH_MS = 45;
const FLASH_MAX_MS = 80;
// No zone flashes more than about eleven times a second.
const MIN_SLOT_MS = 90;
// Without a tempo, a step as long as a beat at 120 BPM.
const DEFAULT_STEP_MS = 500;
// The cold white a hybrid's strobe core is.
const STROBE_WHITE: Colour = { r: 255, g: 255, b: 255, w: 255, a: 0, uv: 0 };

/** How long a step lasts, in ms. */
function stepMsOf(ctx: PatternContext): number {
  return ctx.stepMs && ctx.stepMs > 0 ? ctx.stepMs : DEFAULT_STEP_MS;
}

/**
 * The grid the flashes fall on: `want` a step, halved until each is at least
 * MIN_SLOT_MS long — and past one a step, one every two steps, four, … — so
 * a fast tempo or a fine division thins the flashes out rather than running
 * them under a frame. Which flash it is, how far into it, and how long each
 * is.
 */
function flashGrid(ctx: PatternContext, want: number): { slot: number; phase: number; slotMs: number } {
  const stepMs = stepMsOf(ctx);
  let perStep = want;
  while (perStep > 1 / 16 && stepMs / perStep < MIN_SLOT_MS) perStep /= 2;
  const pos = (ctx.stepPos ?? ctx.step) * perStep;
  return { slot: Math.floor(pos), phase: frac(pos), slotMs: stepMs / perStep };
}

/** Is a flash lit `phase` (0..1) into a slot `slotMs` long. */
function flashLit(phase: number, slotMs: number): boolean {
  return phase * slotMs < Math.min(FLASH_MAX_MS, Math.max(FLASH_MS, 0.35 * slotMs));
}

/**
 * Each slot's place among the distinct places across the rig, left to right,
 * and how many there are: a zone's number along the strobe. Two cells at one
 * place — both ends, laid out mirrored — share a number, so a chase runs out
 * from the middle to both ends at once.
 */
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

/** How far a slot is from the middle of the picture, 0 there and 1 at its edge. */
function fromMiddle(ctx: PatternContext, i: number): number {
  const x = xOf(ctx, i) - 0.5;
  const y = ctx.ys ? yOf(ctx, i) - 0.5 : 0;
  return Math.min(1, Math.hypot(x, y) / 0.5);
}

Object.assign(PATTERN_FUNCS, {
  // A segment chase: one flash stepping zone to zone, a lap a step — or as
  // many steps as it takes for every zone to get a flash of its own on a long
  // rig — each lap in the look's next colour.
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
    const lit = flashLit(frac(along), (stepMs * steps) / N);
    const colour = pal[lap % pal.length];
    for (let i = 0; i < ctx.fixtureCount; i++) {
      ctx.write(i, colour, lit && rank(i) === head ? 255 : 0, 0);
    }
  },

  // A random segment strobe: on every flash a scatter of zones fires, each in
  // one of the look's colours. How many follows the air in the track, and
  // more on the off-beat, where the hats are. Which zones is settled where
  // the flash starts — the hats as they were then — so a zone never drops out
  // of a flash halfway through it.
  'flash-scatter'(ctx) {
    const pal = paletteOf(ctx);
    const { slot, phase, slotMs } = flashGrid(ctx, 8);
    const lit = flashLit(phase, slotMs);
    const hats = kitFromTheClock({ ...ctx, stepPhase: frac((slot * slotMs) / stepMsOf(ctx)) }).hats;
    const density = Math.min(0.7, 0.12 + 0.3 * dyn(ctx, 'air', 0.4) + 0.25 * hats);
    for (let i = 0; i < ctx.fixtureCount; i++) {
      const on = lit && scatter(i, slot) < density;
      ctx.write(i, pal[Math.floor(scatter(i, slot + 7919) * pal.length) % pal.length], on ? 255 : 0, 0);
    }
  },

  // A fill flash: on every step the light runs out from the middle to the
  // edges in the first third of it, holds, and is cut to black before the
  // next — the "grow" a strobe panel's program runs. It starts from the zones
  // nearest the middle, which on an even number of them is two.
  'flash-fill'(ctx) {
    const pal = paletteOf(ctx);
    const phase = ctx.stepPhase ?? 0;
    const cut = phase >= 0.6;
    const colour = pal[ctx.step % pal.length];
    let nearest = 1;
    for (let i = 0; i < ctx.fixtureCount; i++) nearest = Math.min(nearest, fromMiddle(ctx, i));
    const reach = nearest + Math.min(1, phase / 0.3) * (1 - nearest);
    for (let i = 0; i < ctx.fixtureCount; i++) {
      ctx.write(i, colour, !cut && fromMiddle(ctx, i) <= reach + 1e-6 ? 255 : 0, 0);
    }
  },

  // Odd and even: every other zone flashes on the step, the rest on the
  // half-step between, each half in its own colour of the look — on steps
  // too short to halve, a step each.
  'flash-alternate'(ctx) {
    const pal = paletteOf(ctx);
    const { rank } = rankOf(ctx);
    const { slot, phase, slotMs } = flashGrid(ctx, 2);
    const half = slot % 2;
    const lit = flashLit(phase, slotMs);
    const colour = pal[half % pal.length];
    for (let i = 0; i < ctx.fixtureCount; i++) {
      ctx.write(i, colour, lit && rank(i) % 2 === half ? 255 : 0, 0);
    }
  },

  // A ramp: every step swells from black to full — the middle first, the
  // edges a moment behind — and is cut on the next, so the beat lands as the
  // snap to black and the swell after it.
  ramp(ctx) {
    const pal = paletteOf(ctx);
    // With no clock inside the step, the swell at its top.
    const phase = ctx.stepPhase ?? 1;
    const colour = pal[ctx.step % pal.length];
    for (let i = 0; i < ctx.fixtureCount; i++) {
      const lag = 0.35 * fromMiddle(ctx, i);
      const level = clamp01((phase - lag) / (1 - lag));
      ctx.write(i, colour, Math.round(255 * level * level), 0);
    }
  },

  // The hybrid strobe's own look: its outer zones a wash in the look's
  // colour, and a cold white core that strikes on every step — on the kick
  // as it was hit, when the analysis has the pulse. On a line of lights the
  // core is its middle third; on one in rows (a strobe panel), its middle
  // row, the white line across it. Between strikes the core glows faintly in
  // the wash's colour, as the ring around a strobe tube lights it.
  core(ctx) {
    const pal = paletteOf(ctx);
    const level = dyn(ctx, 'level', 0.8);
    const aura = Math.round(110 + 110 * level);
    const grid = flashGrid(ctx, 1);
    const strike = ctx.pulse ? ctx.pulse.kick > 0.6 : flashLit(grid.phase, grid.slotMs);
    const rows = heightsOf(ctx);
    const inCore = rows ? (i: number) => Math.abs(rows(i) - 0.5) < 0.17 : (i: number) => fromMiddle(ctx, i) < 0.34;
    for (let i = 0; i < ctx.fixtureCount; i++) {
      if (inCore(i)) {
        if (strike) ctx.write(i, STROBE_WHITE, 255, 0);
        else ctx.write(i, pal[0], Math.round(aura * 0.3), 0);
      } else {
        ctx.write(i, pal[0], aura, 0);
      }
    }
  },
} satisfies Record<string, PatternFn>);

/**
 * How high each slot is, 0 at the bottom and 1 at the top, when the cells have
 * a height — a panel's rows, from their place front to back on the plot or
 * down the panel laid out per bar — or null for a line of lights.
 */
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
  // Down the plot, and down a panel, is towards its bottom row.
  return (i) => (hi - ys[i]) / (hi - lo);
}

/**
 * The band, as bars: kick, bass, drums, snare, the rest, voice, hats, each
 * 0..1. The pulse where the track was analysed; the expression channel and a
 * kit played by the clock where it was not.
 */
function bandLevels(ctx: PatternContext): number[] {
  const p = ctx.pulse;
  if (p) {
    return [p.kick, p.bass ?? p.mix, p.drums ?? p.mix, p.snare, p.other ?? p.mix * 0.6, p.vocals ?? 0, p.hats].map(clamp01);
  }
  const kit = kitFromTheClock(ctx);
  return [kit.kick, dyn(ctx, 'bass', 0.5), dyn(ctx, 'level', 0.6) * 0.8, kit.snare, dyn(ctx, 'air', 0.3),
    dyn(ctx, 'vocal', 0.4), kit.hats].map(clamp01);
}

/** Smooth value noise, 0..1: `scatter` on a lattice, eased between its points. */
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

/** A stable pseudo-random 0..1 per cell and seed: the same scatter on every frame of a hit. */
function scatter(i: number, seed: number): number {
  let h = Math.imul(i + 1, 0x9E3779B1) ^ Math.imul(seed + 7, 0x85EBCA77);
  h = Math.imul(h ^ (h >>> 15), 0x2C1B3C6D);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

/** A kit played by the clock, for when there is no pulse: kick every step,
 *  snare every other, a hat on each off-step. */
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

export {
  PATTERN_FUNCS,
  CELL_PATTERNS,
  paletteOf,
  hsvToRgb,
  bedOf,
  BED,
  gradientAt,
};
