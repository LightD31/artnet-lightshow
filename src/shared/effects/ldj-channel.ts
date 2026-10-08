// Channel rows schedule changes; the shared lamp engine owns every fade and
// frame boundary. Keeping their scores in musical steps makes tempo changes
// preserve the sequence while existing transitions finish at their old tempo.

import type { Colour } from '../../types/rig.ts';
import { hash01, pickNotLast } from './hash.ts';
import { hsbToColour } from './palette.ts';
import { registerKind } from './registry.ts';
import { ldjChannels, makeLdjKind } from './ldj-engine.ts';
import type { LampMark, LdjCtx, LdjEnvelope, LdjRow } from './ldj-engine.ts';

const INSTANT: LdjEnvelope = { kind: 'instant' };
const mod = (i: number, n: number) => ((i % n) + n) % n;
const at = (ctx: LdjCtx, i: number, key?: number) => ctx.colour(i, key);
const primary = (ctx: LdjCtx) => at(ctx, 1, 0);
const refreshCount = (ctx: LdjCtx, count: number) => { for (let key = 0; key < count; key++) ctx.refresh(key); };
const each = (ctx: LdjCtx, action: (slot: number, channel: number) => void) => {
  for (let slot = 0; slot < ctx.n; slot++) action(slot, ctx.channelOf[slot]);
};
const all = (ctx: LdjCtx, colour: Colour, env: LdjEnvelope = INSTANT, bri = 1, mark?: LampMark) => {
  each(ctx, (slot) => ctx.lamps.set(slot, colour, bri, env, 0, mark));
};
const selected = (ctx: LdjCtx, channel: number, colour: Colour, env: LdjEnvelope, bri = 1) => {
  each(ctx, (slot, ch) => {
    if (ch === channel) ctx.lamps.set(slot, colour, bri, env);
    else ctx.lamps.off(slot);
  });
};
const blend = (ctx: LdjCtx, slot: number, from: Colour, to: Colour) => {
  ctx.lamps.set(slot, from, 1, INSTANT);
  ctx.lamps.set(slot, to, 1, { kind: 'blend', beats: 4 });
};

// Bit zero is back, bit one front. The second phrase uses the other colour.
export const FRONT_BACK_SCORE = [0, 0, 0, 0, 1, 3, 2, 0, 0, 0, 0, 0, 2, 3, 1, 0] as const;

function strobeCycle(ctx: LdjCtx, swapped = false): void {
  const p = at(ctx, swapped ? 0 : 1, 0), s = at(ctx, swapped ? 1 : 0, 1);
  // With one colour the step's lamps flash hard over dark ones; with two the
  // rest hold the background, a change of colour rather than a flash.
  const mark: LampMark | undefined = ctx.pal.length > 1 ? undefined : 'flash';
  each(ctx, (slot, channel) => {
    if (channel === mod(ctx.iter, 4)) ctx.lamps.set(slot, p, 1, INSTANT, 0, mark);
    else if (ctx.pal.length > 1) ctx.lamps.set(slot, s, 1, INSTANT);
    else ctx.lamps.off(slot);
  });
  refreshCount(ctx, 2);
}

function randomLamp(ctx: LdjCtx): number | null {
  if (!ctx.n) return null;
  const pick = pickNotLast(ctx.seed, ctx.iter, ctx.n, ctx.state.lastPick);
  ctx.state.lastPick = pick;
  return pick;
}

const AMERICA = [hsbToColour(0, 1, 1), hsbToColour(0, 0, 1), hsbToColour(250 / 360, 1, 1)];
const studioFill = (beats: number): LdjRow => ({ cadence: beats, channels: 1, step(ctx) {
  all(ctx, primary(ctx), { kind: 'fade', beats }); ctx.refresh(0);
} });

export const LDJ_CHANNEL_ROWS: Record<string, LdjRow> = {
  StrobeCycle: { cadence: 1, step: (ctx) => strobeCycle(ctx) },
  GrowCycle: { cadence: 1, step(ctx) {
    // A corner grows for two whole beats: half, then full.
    selected(ctx, Math.floor(mod(ctx.iter, 8) / 2), primary(ctx), INSTANT, mod(ctx.iter, 2) ? 1 : .5);
    if (mod(ctx.iter, 2) === 0) ctx.refresh(0);
  } },
  FadeCycle: { cadence: 1, step(ctx) {
    selected(ctx, mod(ctx.iter, 4), at(ctx, 1, 1), { kind: 'fade', beats: 1 }); refreshCount(ctx, 4);
  } },
  SoftStrobe: { cadence: 2, step(ctx) {
    each(ctx, (slot, channel) => ctx.lamps.set(slot, at(ctx, 1, channel), 1, channel === mod(ctx.iter, 4) ? { kind: 'fade', beats: 2 } : INSTANT));
    refreshCount(ctx, mod(ctx.iter, 4));
  } },
  FillCycle: { cadence: .5, step(ctx) {
    const phase = mod(ctx.iter, 8), p = primary(ctx), s = at(ctx, 0, 1);
    const filling = phase < 4 ? p : s, background = phase < 4 ? s : p;
    each(ctx, (slot, channel) => ctx.lamps.set(slot, channel <= phase % 4 ? filling : background, 1, INSTANT));
    if (phase % 4 === 0) ctx.refresh(phase);
  } },
  Split: { cadence: 1, channels: 2, step(ctx) {
    each(ctx, (slot, channel) => ctx.lamps.set(slot, at(ctx, mod(ctx.iter + channel, 2)), 1, INSTANT)); refreshCount(ctx, 2);
  } },
  Flip: { cadence: 2, step(ctx) {
    each(ctx, (slot, channel) => {
      const sum = mod(ctx.iter, 4) + channel;
      ctx.lamps.set(slot, at(ctx, sum === 0 || sum === 3 ? 0 : 1), 1, INSTANT);
    });
    refreshCount(ctx, 2);
  } },
  CrossFade: { cadence: 4, channels: 1, step(ctx) {
    // A rerolled palette changes the destination, never the colour at which
    // the preceding blend was supposed to finish.
    const from = ctx.state.scratch.crossTarget as Colour | undefined ?? at(ctx, mod(ctx.iter, 2));
    const to = at(ctx, mod(ctx.iter + 1, 2));
    each(ctx, (slot) => blend(ctx, slot, from, to));
    ctx.state.scratch.crossTarget = { ...to }; ctx.refresh(mod(ctx.iter + 1, 2));
  } },
  Blur: { cadence: 4, step(ctx) {
    // Four cache keys stay independent even when they share two palette entries.
    // Only the inactive pair is refreshed, so both diagonals meet their endpoints.
    const wells = [0, 1, 2, 3].map((key) => at(ctx, key % 2, key));
    const phase = mod(ctx.iter, 4), next = (phase + 1) % 4;
    each(ctx, (slot, channel) => {
      const diagonal = channel === 0 || channel === 3;
      blend(ctx, slot, wells[diagonal ? phase : 3 - phase], wells[diagonal ? next : 3 - next]);
    });
    ctx.state.scratch.blurWells = wells;
    for (const key of phase === 1 ? [0, 3] : phase === 3 ? [1, 2] : []) ctx.refresh(key);
  } },
  DoubleFill: { cadence: .5, channels: 2, step(ctx) {
    const phase = mod(ctx.iter, 4), colour = at(ctx, Math.floor(mod(ctx.iter, 8) / 4));
    each(ctx, (slot, channel) => {
      if (phase === 1 || phase === (channel === 0 ? 0 : 2)) ctx.lamps.set(slot, colour, 1, INSTANT, 0, 'flash');
      else ctx.lamps.off(slot);
    });
    if (phase === 0) ctx.refresh(Math.floor(mod(ctx.iter, 8) / 4));
  } },
  FrontBack: { cadence: .5, channels: 'depth', step(ctx) {
    const phase = mod(ctx.iter, 16), mask = FRONT_BACK_SCORE[phase];
    each(ctx, (slot, channel) => {
      if (mask & (1 << channel)) ctx.lamps.set(slot, phase < 8 ? primary(ctx) : at(ctx, 0, 1), 1, INSTANT, 0, 'flash');
      else ctx.lamps.off(slot);
    });
    if (phase === 4 || phase === 12) ctx.refresh(phase === 4 ? 0 : 1);
  } },
  RotatingHalfs: { cadence: 1, channels: 2, step(ctx) {
    const phase = mod(ctx.iter, 4), channels = ldjChannels(ctx.room, phase % 2 ? 'width' : 'depth');
    each(ctx, (slot) => ctx.lamps.set(slot, at(ctx, channels[slot] === (phase === 0 || phase === 3 ? 1 : 0) ? 1 : 0), 1, INSTANT));
    refreshCount(ctx, 2);
  } },
  TwoCorners: { cadence: 1, step(ctx) {
    const count = Math.min(4, ctx.n), pairs: number[][] = [];
    for (let a = 0; a < count; a++) for (let b = a + 1; b < count; b++) pairs.push([a, b]);
    if (!pairs.length && count) pairs.push([0]);
    const previous = ctx.state.recent;
    const alternatives = pairs.filter((pair) => pair.length !== previous.length || pair.some((value, i) => value !== previous[i]));
    const pool = alternatives.length ? alternatives : pairs;
    const pair = pool[Math.floor(hash01(ctx.seed, 31, ctx.iter) * pool.length)] ?? [];
    each(ctx, (slot, channel) => {
      const index = pair.indexOf(channel);
      if (index >= 0) ctx.lamps.set(slot, at(ctx, index), 1, { kind: 'fade', beats: 1 });
      else ctx.lamps.off(slot);
    });
    ctx.state.recent = [...pair]; refreshCount(ctx, 2);
  } },
  DoubleDrip: { cadence: 1, channels: 2, step(ctx) {
    const phase = mod(ctx.iter, 4), colour = phase === 0 || phase === 3 ? primary(ctx) : at(ctx, 0, 1);
    each(ctx, (slot, channel) => { if (channel === phase % 2) ctx.lamps.set(slot, colour, 1, { kind: 'fade', beats: 2 }); });
    refreshCount(ctx, 2);
  } },
  Glow: { cadence: 4, channels: 1, step(ctx) {
    all(ctx, at(ctx, mod(ctx.iter, 2), 0), { kind: 'twoWay', beats: 2 }); refreshCount(ctx, 4);
  } },
  Drip: { cadence: 2, channels: 1, step(ctx) {
    all(ctx, at(ctx, mod(ctx.iter, 2), 0), { kind: 'fade', beats: 2 }); refreshCount(ctx, 4);
  } },
  TriPulse: { cadence: .5, channels: 1, rapidFlash: true, step(ctx) {
    if (mod(ctx.iter, 6) < 3) {
      all(ctx, primary(ctx), { kind: 'matrix', fadeIn: 10, peak: 30000 / ctx.bpm - 20, fadeOut: 10, baseline: .1 }, 1, 'flash');
      refreshCount(ctx, 4);
    } else all(ctx, primary(ctx), INSTANT, .1, 'rest');
  } },
  Sketch: { cadence: .25, rapidFlash: true, step(ctx) {
    selected(ctx, Math.floor(mod(ctx.iter, 16) / 4), primary(ctx), INSTANT, mod(ctx.iter, 4) * .25);
    if (mod(ctx.iter, 4) === 0) ctx.refresh(0);
  } },
  DoSiDo: { cadence: .5, step: (ctx) => strobeCycle(ctx, true) },
  Trance: { cadence: 2, channels: 1, step(ctx) {
    const slow = ctx.n > 20 ? 2 : 1;
    if (mod(ctx.iter, slow)) return;
    all(ctx, at(ctx, mod(Math.floor(ctx.iter / slow), 2), 0)); refreshCount(ctx, 4);
  } },
  BeatPulse1: { cadence: .25, channels: 1, rapidFlash: true, step(ctx) {
    all(ctx, primary(ctx), { kind: 'matrix', fadeIn: 10, peak: 15000 / ctx.bpm - 20, fadeOut: 10 }, 1, 'flash'); ctx.refresh(0);
  } },
  BeatPulse4: { cadence: .25, channels: 1, rapidFlash: true, step(ctx) {
    all(ctx, primary(ctx), { kind: 'matrix', fadeIn: 10, peak: 120000 / ctx.bpm - 20, fadeOut: 10 }, 1, 'flash'); ctx.refresh(0);
  } },
  Cauldron: { cadence: .5, channels: 'lights', rapidFlash: true, step(ctx) {
    const pick = randomLamp(ctx);
    if (pick !== null) {
      ctx.lamps.set(pick, at(ctx, 1, pick), 1, { kind: 'matrix', fadeIn: 10, peak: 500, fadeOut: 3000 });
      ctx.refresh(pick);
    }
  } },
  America: { cadence: 2, channels: 1, step(ctx) {
    const slow = ctx.n > 20 ? 2 : 1;
    if (mod(ctx.iter, slow)) return;
    all(ctx, AMERICA[mod(Math.floor(ctx.iter / slow), 3)]);
  } },
  SMStudioN1Fill: studioFill(1),
  SMStudioN2Fill: studioFill(2),
  SMStudioN3Fill: studioFill(4),
  SMStudioN4Fill: studioFill(6),
  SMStudioN5Fill: studioFill(8),
  MatrixSolid: { cadence: 1, channels: 'colours', step(ctx) {
    each(ctx, (slot, channel) => ctx.lamps.set(slot, at(ctx, channel), 1, INSTANT));
  } },
  QuickFlash: { cadence: 4, rapidFlash: true, step(ctx) {
    const beatMs = 60000 / ctx.bpm;
    all(ctx, at(ctx, 0, 0), { kind: 'matrix', fadeIn: .9 * beatMs, peak: .2 * beatMs, fadeOut: .9 * beatMs, peakColour: at(ctx, 1, 1) });
    refreshCount(ctx, 2);
  } },
  SceneMakerFirework: { cadence: 1, channels: 'lights', rapidFlash: true, step(ctx) {
    const pick = randomLamp(ctx);
    if (pick !== null) {
      const colour = at(ctx, hash01(ctx.seed, 37, ctx.iter) < .5 ? 1 : 0, pick);
      const peak = 150 + Math.floor(hash01(ctx.seed, 41, ctx.iter) * 101);
      ctx.lamps.set(pick, colour, 1, { kind: 'matrix', fadeIn: 50, peak, fadeOut: 2000 });
      ctx.refresh(pick);
    }
  }, nextDelayMs(ctx) {
    // Even a one-lamp room gets a bounded interval, with no random retry loop.
    const min = ctx.n === 1 ? 150 : 100, span = ctx.n === 1 ? 601 : 401;
    return 60 + min + Math.floor(hash01(ctx.seed, 43, ctx.iter) * span);
  } },
};

for (const [name, row] of Object.entries(LDJ_CHANNEL_ROWS)) registerKind(makeLdjKind(name, row));
