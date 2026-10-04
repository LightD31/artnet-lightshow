// Channel rows schedule changes; the shared lamp engine owns every fade and
// frame boundary. Keeping their scores in musical steps makes tempo changes
// preserve the sequence while existing transitions finish at their old tempo.

import type { Colour } from '../../types/rig.ts';
import { hash01, pickNotLast } from './hash.ts';
import { hsbToColour } from './palette.ts';
import { registerKind } from './registry.ts';
import { ldjChannels, makeLdjKind, roles } from './ldj-engine.ts';
import type { LdjCtx, LdjEnvelope, LdjRow } from './ldj-engine.ts';

const INSTANT: LdjEnvelope = { kind: 'instant' };
const mod = (i: number, n: number) => ((i % n) + n) % n;
const at = (ctx: LdjCtx, i: number) => roles(ctx.pal).at(i);
const each = (ctx: LdjCtx, action: (slot: number, channel: number) => void) => {
  for (let slot = 0; slot < ctx.n; slot++) action(slot, ctx.channelOf[slot]);
};
const all = (ctx: LdjCtx, colour: Colour, env: LdjEnvelope = INSTANT, bri = 1) => {
  each(ctx, (slot) => ctx.lamps.set(slot, colour, bri, env));
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
  const p = swapped ? ctx.s : ctx.p, s = swapped ? ctx.p : ctx.s;
  each(ctx, (slot, channel) => {
    if (channel === mod(ctx.iter, 4)) ctx.lamps.set(slot, p, 1, INSTANT);
    else if (ctx.pal.length > 1) ctx.lamps.set(slot, s, 1, INSTANT);
    else ctx.lamps.off(slot);
  });
  ctx.reroll();
}

function randomLamp(ctx: LdjCtx): number | null {
  if (!ctx.n) return null;
  const pick = pickNotLast(ctx.seed, ctx.iter, ctx.n, ctx.state.lastPick);
  ctx.state.lastPick = pick;
  return pick;
}

const AMERICA = [hsbToColour(0, 1, 1), hsbToColour(0, 0, 1), hsbToColour(250 / 360, 1, 1)];
const studioFill = (beats: number): LdjRow => ({ cadence: beats, channels: 1, step(ctx) {
  all(ctx, ctx.p, { kind: 'fade', beats }); ctx.reroll();
} });

export const LDJ_CHANNEL_ROWS: Record<string, LdjRow> = {
  StrobeCycle: { cadence: 1, step: (ctx) => strobeCycle(ctx) },
  GrowCycle: { cadence: 1, step(ctx) {
    // A corner grows for two whole beats: half, then full.
    selected(ctx, Math.floor(mod(ctx.iter, 8) / 2), ctx.p, INSTANT, mod(ctx.iter, 2) ? 1 : .5);
    if (mod(ctx.iter, 2) === 0) ctx.reroll();
  } },
  FadeCycle: { cadence: 1, step(ctx) {
    selected(ctx, mod(ctx.iter, 4), ctx.p, { kind: 'fade', beats: 1 }); ctx.reroll();
  } },
  SoftStrobe: { cadence: 2, step(ctx) {
    each(ctx, (slot, channel) => ctx.lamps.set(slot, ctx.p, 1, channel === mod(ctx.iter, 4) ? { kind: 'fade', beats: 2 } : INSTANT));
    ctx.reroll();
  } },
  FillCycle: { cadence: .5, step(ctx) {
    const phase = mod(ctx.iter, 8), filling = phase < 4 ? ctx.p : ctx.s, background = phase < 4 ? ctx.s : ctx.p;
    each(ctx, (slot, channel) => ctx.lamps.set(slot, channel <= phase % 4 ? filling : background, 1, INSTANT));
    if (phase % 4 === 0) ctx.reroll();
  } },
  Split: { cadence: 1, channels: 2, step(ctx) {
    each(ctx, (slot, channel) => ctx.lamps.set(slot, mod(ctx.iter + channel, 2) ? ctx.p : ctx.s, 1, INSTANT)); ctx.reroll();
  } },
  Flip: { cadence: 2, step(ctx) {
    each(ctx, (slot, channel) => {
      const sum = mod(ctx.iter, 4) + channel;
      ctx.lamps.set(slot, sum === 0 || sum === 3 ? ctx.s : ctx.p, 1, INSTANT);
    });
    ctx.reroll();
  } },
  CrossFade: { cadence: 4, channels: 1, step(ctx) {
    // A rerolled palette changes the destination, never the colour at which
    // the preceding blend was supposed to finish.
    const from = ctx.state.scratch.crossTarget as Colour | undefined ?? at(ctx, mod(ctx.iter, 2));
    const to = at(ctx, mod(ctx.iter + 1, 2));
    each(ctx, (slot) => blend(ctx, slot, from, to));
    ctx.state.scratch.crossTarget = { ...to }; ctx.reroll();
  } },
  Blur: { cadence: 4, step(ctx) {
    // Four retained wells make the two diagonals meet their old endpoints
    // before the inactive pair is refreshed for a later phrase.
    const wells = ctx.state.scratch.blurWells as Colour[] | undefined ?? [ctx.s, ctx.p, ctx.s, ctx.p].map((c) => ({ ...c }));
    const refresh = ctx.state.scratch.blurRefresh as number[] | undefined;
    for (const index of refresh ?? []) wells[index] = { ...(index % 2 ? ctx.p : ctx.s) };
    const phase = mod(ctx.iter, 4), next = (phase + 1) % 4;
    each(ctx, (slot, channel) => {
      const diagonal = channel === 0 || channel === 3;
      blend(ctx, slot, wells[diagonal ? phase : 3 - phase], wells[diagonal ? next : 3 - next]);
    });
    ctx.state.scratch.blurWells = wells;
    ctx.state.scratch.blurRefresh = phase === 1 ? [0, 3] : phase === 3 ? [1, 2] : [];
    if (phase % 2) ctx.reroll();
  } },
  DoubleFill: { cadence: .5, channels: 2, step(ctx) {
    const phase = mod(ctx.iter, 4), colour = at(ctx, Math.floor(mod(ctx.iter, 8) / 4));
    each(ctx, (slot, channel) => {
      if (phase === 1 || phase === (channel === 0 ? 0 : 2)) ctx.lamps.set(slot, colour, 1, INSTANT);
      else ctx.lamps.off(slot);
    });
    if (phase === 0) ctx.reroll();
  } },
  FrontBack: { cadence: .5, channels: 'depth', step(ctx) {
    const phase = mod(ctx.iter, 16), mask = FRONT_BACK_SCORE[phase];
    each(ctx, (slot, channel) => {
      if (mask & (1 << channel)) ctx.lamps.set(slot, phase < 8 ? ctx.p : ctx.s, 1, INSTANT);
      else ctx.lamps.off(slot);
    });
    if (phase === 4 || phase === 12) ctx.reroll();
  } },
  RotatingHalfs: { cadence: 1, channels: 2, step(ctx) {
    const phase = mod(ctx.iter, 4), channels = ldjChannels(ctx.room, phase % 2 ? 'width' : 'depth');
    each(ctx, (slot) => ctx.lamps.set(slot, channels[slot] === (phase === 0 || phase === 3 ? 1 : 0) ? ctx.p : ctx.s, 1, INSTANT));
    ctx.reroll();
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
    ctx.state.recent = [...pair]; ctx.reroll();
  } },
  DoubleDrip: { cadence: 1, channels: 2, step(ctx) {
    const phase = mod(ctx.iter, 4), colour = phase === 0 || phase === 3 ? ctx.p : ctx.s;
    each(ctx, (slot, channel) => { if (channel === phase % 2) ctx.lamps.set(slot, colour, 1, { kind: 'fade', beats: 2 }); });
    ctx.reroll();
  } },
  Glow: { cadence: 4, channels: 1, step(ctx) {
    all(ctx, at(ctx, mod(ctx.iter, 2)), { kind: 'twoWay', beats: 2 }); ctx.reroll();
  } },
  Drip: { cadence: 2, channels: 1, step(ctx) {
    all(ctx, at(ctx, mod(ctx.iter, 2)), { kind: 'fade', beats: 2 }); ctx.reroll();
  } },
  TriPulse: { cadence: .5, channels: 1, step(ctx) {
    if (mod(ctx.iter, 6) < 3) {
      all(ctx, ctx.p, { kind: 'matrix', fadeIn: 10, peak: 30000 / ctx.bpm - 20, fadeOut: 10, baseline: .1 });
      ctx.reroll();
    } else all(ctx, ctx.p, INSTANT, .1);
  } },
  Sketch: { cadence: .25, rapidFlash: true, step(ctx) {
    selected(ctx, Math.floor(mod(ctx.iter, 16) / 4), ctx.p, INSTANT, mod(ctx.iter, 4) * .25);
    if (mod(ctx.iter, 4) === 0) ctx.reroll();
  } },
  DoSiDo: { cadence: .5, step: (ctx) => strobeCycle(ctx, true) },
  Trance: { cadence: 2, channels: 1, step(ctx) {
    const slow = ctx.n > 20 ? 2 : 1;
    if (mod(ctx.iter, slow)) return;
    all(ctx, at(ctx, mod(Math.floor(ctx.iter / slow), 2))); ctx.reroll();
  } },
  BeatPulse1: { cadence: .25, channels: 1, rapidFlash: true, step(ctx) {
    all(ctx, ctx.p, { kind: 'matrix', fadeIn: 10, peak: 15000 / ctx.bpm - 20, fadeOut: 10 }); ctx.reroll();
  } },
  BeatPulse4: { cadence: .25, channels: 1, rapidFlash: true, step(ctx) {
    all(ctx, ctx.p, { kind: 'matrix', fadeIn: 10, peak: 120000 / ctx.bpm - 20, fadeOut: 10 }); ctx.reroll();
  } },
  Cauldron: { cadence: .5, channels: 'lights', step(ctx) {
    const pick = randomLamp(ctx);
    if (pick !== null) ctx.lamps.set(pick, ctx.p, 1, { kind: 'matrix', fadeIn: 10, peak: 500, fadeOut: 3000 });
    ctx.reroll();
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
  QuickFlash: { cadence: 4, step(ctx) {
    const beatMs = 60000 / ctx.bpm;
    all(ctx, ctx.s, { kind: 'matrix', fadeIn: .9 * beatMs, peak: .2 * beatMs, fadeOut: .9 * beatMs, peakColour: ctx.p });
    ctx.reroll();
  } },
  SceneMakerFirework: { cadence: 1, channels: 'lights', step(ctx) {
    const pick = randomLamp(ctx);
    if (pick !== null) {
      const colour = hash01(ctx.seed, 37, ctx.iter) < .5 ? ctx.p : ctx.s;
      const peak = 150 + Math.floor(hash01(ctx.seed, 41, ctx.iter) * 101);
      ctx.lamps.set(pick, colour, 1, { kind: 'matrix', fadeIn: 50, peak, fadeOut: 2000 });
    }
    ctx.reroll();
  }, nextDelayMs(ctx) {
    // Even a one-lamp room gets a bounded interval, with no random retry loop.
    const min = ctx.n === 1 ? 150 : 100, span = ctx.n === 1 ? 601 : 401;
    return 60 + min + Math.floor(hash01(ctx.seed, 43, ctx.iter) * span);
  } },
};

for (const [name, row] of Object.entries(LDJ_CHANNEL_ROWS)) registerKind(makeLdjKind(name, row));
