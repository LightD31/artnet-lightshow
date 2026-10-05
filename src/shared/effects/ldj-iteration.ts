// Iteration rows keep lamp choice separate from colour-cache choice. A palette
// can contain one random entry while every lamp retains its own remembered hue.

import type { Colour } from '../../types/rig.ts';
import { hash01, permutation, pickExcluding, pickNotLast } from './hash.ts';
import { LDJ_FRAME_MS, makeLdjKind } from './ldj-engine.ts';
import type { LdjCtx, LdjEnvelope, LdjRow } from './ldj-engine.ts';
import { registerKind } from './registry.ts';

const INSTANT: LdjEnvelope = { kind: 'instant' };
const BLACK: Colour = { r: 0, g: 0, b: 0, w: 0, a: 0, uv: 0 };
const mod = (i: number, n: number) => ((i % n) + n) % n;
// Uncached colours follow whole lamp frames, so two 44 Hz samples of the same
// frame agree. The pure draw leaves cached backgrounds and pending rolls alone.
const frameColour = (ctx: LdjCtx, index: number, slot: number) => ctx.frameColour(index, slot, Math.max(0, Math.floor((ctx.elapsedMs + 1e-8) / LDJ_FRAME_MS)));
const paletteIndex = (ctx: LdjCtx, i: number) => mod(i, ctx.pal.length);
const all = (ctx: LdjCtx, colour: Colour, env: LdjEnvelope = INSTANT) => {
  for (let slot = 0; slot < ctx.n; slot++) ctx.lamps.set(slot, colour, 1, env);
};
const off = (ctx: LdjCtx) => { for (let slot = 0; slot < ctx.n; slot++) ctx.lamps.off(slot); };
const refreshCount = (ctx: LdjCtx, count: number) => { for (let key = 0; key < count; key++) ctx.refresh(key); };

function pick(ctx: LdjCtx): number {
  const rank = pickNotLast(ctx.seed, ctx.iter, ctx.n, ctx.state.lastPick);
  ctx.state.lastPick = rank;
  return rank;
}

// Selectors work in radial ranks; only the final write translates into rig slots.
function single(ctx: LdjCtx, rank: number, colour: Colour, background?: Colour, bri = 1,
  env: LdjEnvelope = INSTANT): void {
  for (let j = 0; j < ctx.n; j++) {
    const slot = ctx.ringOrder[j];
    if (j === rank) ctx.lamps.set(slot, colour, bri, env);
    else if (background) ctx.lamps.set(slot, background, 1, INSTANT);
    else ctx.lamps.off(slot);
  }
}

function strobeRow(scatter: boolean, backlit: boolean, sine = false, cyclePalette = false): LdjRow {
  return { cadence: sine || cyclePalette ? .5 : backlit ? 1 : .25, step(ctx) {
    const index = cyclePalette ? paletteIndex(ctx, ctx.iter) : backlit ? 0 : 1;
    const key = 0;
    // Matrix colours advance through the palette but share the selected well.
    ctx.refresh(cyclePalette ? index : key);
    if (backlit && mod(ctx.iter, ctx.n) === 0) ctx.refresh(1);
    const rank = scatter ? pick(ctx) : mod(ctx.iter, ctx.n);
    const bri = sine ? Math.sin(ctx.iter * Math.PI / 16) / 2 + .5 : 1;
    single(ctx, rank, ctx.colour(index, key), backlit ? ctx.colour(1, 1) : undefined, bri);
  } };
}

// Backlighting is a full-brightness RGB blend. Without it, the same selected
// colour dims toward black and the other lamps relinquish their old fades.
function fadeRow(scatter: boolean, backlit: boolean): LdjRow {
  return { cadence: 1, step(ctx) {
    ctx.refresh(0);
    if (backlit && mod(ctx.iter, ctx.n) === 0) ctx.refresh(1);
    const rank = scatter ? pick(ctx) : mod(ctx.iter, ctx.n), from = ctx.colour(0, 0), to = ctx.colour(1, 1);
    single(ctx, rank, from, backlit ? to : undefined, 1, backlit ? INSTANT : { kind: 'fade', beats: 1 });
    if (backlit) ctx.lamps.set(ctx.ringOrder[rank], to, 1, { kind: 'blend', beats: 1 });
  } };
}

// Both halves retain the selected lamp, while the backlight changes only at
// the start of a complete pass around the room.
function growRow(scatter: boolean, backlit: boolean): LdjRow {
  return { cadence: .5, step(ctx) {
    const half = mod(ctx.iter, 2);
    if (!half) ctx.refresh(0);
    if (backlit && mod(ctx.iter, ctx.n * 2) === 0) ctx.refresh(1);
    const rank = scatter ? half ? ctx.state.lastPick ?? pick(ctx) : pick(ctx) : mod(Math.floor(ctx.iter / 2), ctx.n);
    ctx.state.scratch.growSlot = ctx.ringOrder[rank];
    single(ctx, rank, ctx.colour(0, 0), backlit ? ctx.colour(1, 1) : undefined, half ? 1 : .5);
  }, outputColour(ctx, slot, lamp) {
    return slot === ctx.state.scratch.growSlot ? frameColour(ctx, 0, slot) : lamp.colour;
  } };
}

// Stages interleave radial ranks rather than dividing the room into wedges.
// Fill recolours earlier stages; Glow also releases the preceding stage.
type StageMode = 'Strobe' | 'Fade' | 'Flare' | 'Glow' | 'Fill';
function stageRow(count: number, mode: StageMode, modified = false): LdjRow {
  return { cadence: modified ? .5 : 1, step(ctx) {
    const phase = mod(ctx.iter, 4);
    // Rest callbacks refresh the pending stage without consuming it.
    const event = modified ? Math.floor(ctx.iter / 4) * 2 + Math.min(phase, 2) : ctx.iter;
    const stage = mod(event, count);
    ctx.refresh(stage);
    if (modified && phase >= 2) { off(ctx); return; }
    const colour = ctx.colour(event, stage);
    for (let rank = 0; rank < ctx.n; rank++) {
      const group = rank % count, slot = ctx.ringOrder[rank];
      if (group === stage || mode === 'Fill' && group <= stage) {
        const env: LdjEnvelope = mode === 'Fade' ? { kind: 'fade', beats: 1 }
          : mode === 'Flare' || mode === 'Glow' ? { kind: 'flare', beats: 1 } : INSTANT;
        ctx.lamps.set(slot, colour, 1, env);
      } else if (mode === 'Glow' && group === mod(stage - 1, count)) {
        ctx.lamps.set(slot, ctx.colour(event - 1), 1, { kind: 'fade', beats: 1 });
      } else ctx.lamps.off(slot);
    }
  } };
}

// A pair of flashes shares one lamp and one palette position for four steps.
function doubleRow(scatter: boolean): LdjRow {
  return { cadence: .25, step(ctx) {
    const phase = mod(ctx.iter, 4), group = Math.floor(ctx.iter / 4), index = paletteIndex(ctx, group);
    ctx.refresh(index);
    const rank = scatter ? phase === 0 ? pick(ctx) : ctx.state.lastPick ?? pick(ctx) : mod(group, ctx.n);
    if (phase % 2) off(ctx);
    else single(ctx, rank, ctx.colour(index));
  } };
}

type ScoreAction = 'p' | 's' | 'off' | 'hold';
const score = (text: string): ScoreAction[] => text.split(' ').map((s) => s === 'H' ? 'hold' : s === 'O' ? 'off' : s as 'p' | 's');
export const GENRE_SCORES = {
  House: score('p H H H s H H H p H H H s H s H'),
  Electro: score('p H H p H H p H H H s H s H H H'),
  Techno: score('p H O H s H O H p H O H s H O H'),
  Dubstep: score('p H p H s H H H p H p H s H H H'),
  DAndB: score('p H H H H H p H H H H H s H H H'),
};

function genreRow(actions: ScoreAction[]): LdjRow {
  return { cadence: .25, step(ctx) {
    const action = actions[mod(ctx.iter, 16)];
    if (action === 'hold') return;
    ctx.refresh(0);
    // Explicit darkness owns the lamps but does not change the last lit pick.
    if (action === 'off') off(ctx);
    else single(ctx, pick(ctx), ctx.colour(action === 'p' ? 1 : 0, 0));
  } };
}

// Musical duration and selection cadence are separate: Multi overlaps long
// pulses. A bounded recent list also lets one-lamp rooms reuse their only lamp.
function studioRow(beats: number, multi = false): LdjRow {
  return { cadence: multi ? 1 : beats, step(ctx) {
    const rank = pickExcluding(ctx.seed, ctx.iter, ctx.n, ctx.state.recent);
    ctx.state.lastPick = rank;
    ctx.state.recent.push(rank);
    ctx.state.recent.splice(0, Math.max(0, ctx.state.recent.length - Math.floor(ctx.n / 2)));
    ctx.lamps.set(ctx.ringOrder[rank], ctx.colour(1, 0), 1, { kind: 'fade', beats, baseline: .05 });
    ctx.refresh(0);
  } };
}

function paletteEnvelope(kind: 'fade' | 'flare'): LdjRow {
  return { cadence: 2, step(ctx) {
    const index = paletteIndex(ctx, ctx.iter);
    all(ctx, ctx.colour(index, 0), { kind, beats: 2 }); ctx.refresh(index);
  } };
}

const POPCORN_HITS = [[0, 2, 3, 5, 6, 9, 11, 12, 13], [0, 2, 3, 5, 6, 7, 10, 11, 13]];

export const LDJ_ITERATION_ROWS: Record<string, LdjRow> = {
  ScatterFill: { cadence: 1, step(ctx) {
    const pass = Math.floor(ctx.iter / ctx.n), phase = mod(ctx.iter, ctx.n);
    if (ctx.state.scratch.fillPass !== pass || !ctx.state.perm) {
      ctx.state.perm = permutation(ctx.seed, pass, ctx.n); ctx.state.scratch.fillPass = pass;
    }
    const rank = ctx.state.perm[phase]; ctx.state.lastPick = rank;
    ctx.lamps.set(ctx.ringOrder[rank], ctx.colour(mod(pass, 2), rank), 1, INSTANT); ctx.refresh(rank);
  } },
  ScatterStrobe: strobeRow(true, false), Circuit: strobeRow(false, false),
  MatrixCycle: strobeRow(false, false, false, true),
  BLStrobeCycle: strobeRow(false, true), BLScatterStrobe: strobeRow(true, true),
  BrtSinStrobe: strobeRow(false, true, true), BrtSinScatter: strobeRow(true, true, true),
  DoubleStrobeCycle: doubleRow(false), DoubleScatterStrobe: doubleRow(true),
  DoubleFillStrobe: { cadence: .25, step(ctx) {
    const phase = mod(ctx.iter, 4), index = paletteIndex(ctx, Math.floor(ctx.iter / 4));
    ctx.refresh(index);
    for (let rank = phase % 2; rank < ctx.n; rank += 2) {
      ctx.lamps.set(ctx.ringOrder[rank], ctx.colour(index), 1, { kind: phase < 2 ? 'flare' : 'fade', beats: 1 });
    }
  } },
  BLFadeCycle: fadeRow(false, true), ScatterFade: fadeRow(true, false), BLScatterFade: fadeRow(true, true),
  BLGrowCycle: growRow(false, true), ScatterGrow: growRow(true, false), BLScatterGrow: growRow(true, true),
  ThreeStageStrobe: stageRow(3, 'Strobe'), ThreeStageFade: stageRow(3, 'Fade'), ThreeStageFlare: stageRow(3, 'Flare'),
  ThreeStageGlow: stageRow(3, 'Glow'), ThreeStageFill: stageRow(3, 'Fill'),
  FiveStageFlare: stageRow(5, 'Flare'), FiveStageGlow: stageRow(5, 'Glow'), FiveStageFill: stageRow(5, 'Fill'),
  FiveStageStrobe: stageRow(5, 'Strobe'), FiveStageFade: stageRow(5, 'Fade'),
  ThreeStageStrobeMod: stageRow(3, 'Strobe', true), ThreeStageFadeMod: stageRow(3, 'Fade', true),
  ThreeStageFlareMod: stageRow(3, 'Flare', true),
  ThreeStrobeAndFade: { cadence: 1, step(ctx) {
    const phase = mod(ctx.iter, 8);
    if (phase < 3) {
      for (let rank = phase; rank < ctx.n; rank += 3) ctx.lamps.set(ctx.ringOrder[rank], ctx.colour(0, 0), 1, { kind: 'fade', beats: 1 });
      ctx.refresh(0);
    } else if (phase === 3) { all(ctx, ctx.colour(1, 1), { kind: 'fade', beats: 6 }); ctx.refresh(1); }
  } },
  FlareAndBreak: { cadence: 1, step(ctx) {
    const phase = mod(ctx.iter, 4), index = paletteIndex(ctx, Math.floor(ctx.iter / 4));
    if (phase === 0) all(ctx, ctx.colour(index), { kind: 'flare', beats: 3 });
    else if (phase === 3) {
      const order = permutation(ctx.seed, Math.floor(ctx.iter / 4), ctx.n);
      // The break sweeps a shuffled ring over one beat; each short fade keeps
      // its captured duration even if tempo changes while it waits.
      order.forEach((rank, j) => ctx.lamps.set(ctx.ringOrder[rank], ctx.colour(index), 1, { kind: 'fade', beats: .1 }, Math.trunc(j * 60 / ctx.bpm * 22 / ctx.n)));
    } else return;
    ctx.refresh(index);
  } },
  PaletteDrip: paletteEnvelope('fade'), PaletteFlare: paletteEnvelope('flare'),
  PaletteGlow: { cadence: 2, step(ctx) {
    const index = paletteIndex(ctx, Math.floor(ctx.iter / 2));
    // The falling half is an owned black colour, distinct from the ordinary
    // coloured Glow envelope. The palette advances after both halves.
    if (mod(ctx.iter, 2)) all(ctx, BLACK, { kind: 'fade', beats: 2 });
    else { all(ctx, ctx.colour(index, 0), { kind: 'flare', beats: 2 }); for (let i = 0; i < ctx.n; i++) ctx.refresh(0); }
  } },
  Popcorn: { cadence: .5, step(ctx) {
    if (!ctx.state.scratch.popcornStarted) { all(ctx, ctx.colour(0, 0)); ctx.state.scratch.popcornStarted = true; }
    ctx.refresh(1);
    if (!POPCORN_HITS[mod(Math.floor(ctx.iter / 16), 2)].includes(mod(ctx.iter, 16))) return;
    const rank = Math.floor(hash01(ctx.seed, 47, ctx.iter) * ctx.n), slot = ctx.ringOrder[rank];
    ctx.lamps.set(slot, ctx.colour(1, 1), 1, INSTANT);
    ctx.lamps.set(slot, ctx.colour(0, 0), 1, { kind: 'blend', beats: 1 });
  } },
  DubstepStrobe: genreRow(GENRE_SCORES.Dubstep), DAndBStrobe: genreRow(GENRE_SCORES.DAndB),
  HouseStrobe: genreRow(GENRE_SCORES.House), ElectroStrobe: genreRow(GENRE_SCORES.Electro), TechnoStrobe: genreRow(GENRE_SCORES.Techno),
  TrueStrobe: { cadence: 'wall:50',
    step(ctx) { if (mod(ctx.iter, 2)) off(ctx); else all(ctx, ctx.colour(1, 0)); },
    outputColour: (ctx, slot, lamp) => lamp.bri > 0 ? frameColour(ctx, 1, slot) : lamp.colour,
  },
  PaletteTrueStrobe: { cadence: .125, step(ctx) {
    const index = paletteIndex(ctx, Math.floor(ctx.iter / 4)); ctx.refresh(index);
    if (mod(ctx.iter, 2)) off(ctx); else all(ctx, ctx.colour(index));
  } },
  PaletteSplit: { cadence: 1, step(ctx) {
    const index = paletteIndex(ctx, ctx.iter);
    ctx.state.scratch.framePalette = index;
    all(ctx, ctx.colour(index)); ctx.refresh(index);
  }, outputColour: (ctx, slot) => frameColour(ctx, ctx.state.scratch.framePalette as number, slot) },
  PalettePartyStrobe: { cadence: .25, step(ctx) {
    const index = paletteIndex(ctx, ctx.iter), rank = pick(ctx);
    ctx.lamps.set(ctx.ringOrder[rank], ctx.colour(index), 1, INSTANT); ctx.refresh(index);
  } },
  // Independent permutations choose the lit subset and colour order, then
  // ascending radial order makes their pairing deterministic.
  PaletteStrobe: { cadence: 1, step(ctx) {
    const chosen = permutation(ctx.seed, ctx.iter * 2, ctx.n).slice(0, Math.min(ctx.n, ctx.pal.length)).sort((a, b) => a - b);
    const colours = permutation(ctx.seed, ctx.iter * 2 + 1, ctx.pal.length);
    off(ctx);
    chosen.forEach((rank, j) => ctx.lamps.set(ctx.ringOrder[rank], ctx.colour(colours[j]), 1, INSTANT));
    refreshCount(ctx, ctx.pal.length);
  } },
  PaletteTrail: { cadence: 1, step(ctx) {
    const start = mod(ctx.iter, ctx.n), offset = ctx.pal.length > ctx.n ? Math.floor(ctx.iter / ctx.n) : 0;
    off(ctx);
    for (let j = 0; j < Math.min(ctx.n, ctx.pal.length); j++) ctx.lamps.set(ctx.ringOrder[mod(start + j, ctx.n)], ctx.colour(j + offset), 1, INSTANT);
    refreshCount(ctx, ctx.pal.length);
  } },
  // Fill retains prior lamps and keys colours by lamp, unlike Trail, which
  // moves a palette-shaped window and clears everything outside it.
  PaletteFill: { cadence: 1, step(ctx) {
    const start = mod(ctx.iter * ctx.pal.length - 1, ctx.n);
    const offset = ctx.n % ctx.pal.length || ctx.pal.length > ctx.n ? Math.floor(ctx.iter / ctx.n) : 0;
    for (let j = 0; j < Math.min(ctx.n, ctx.pal.length); j++) {
      const rank = mod(start + j, ctx.n);
      ctx.lamps.set(ctx.ringOrder[rank], ctx.colour(j + offset, rank), 1, INSTANT); ctx.refresh(rank);
    }
  } },
  SMStudioN1Pulse: studioRow(1), SMStudioN2Pulse: studioRow(2), SMStudioN3Pulse: studioRow(4),
  SMStudioN4Pulse: studioRow(6), SMStudioN5Pulse: studioRow(8),
  SMStudioN2PulseMulti: studioRow(2, true), SMStudioN3PulseMulti: studioRow(4, true),
  SMStudioN4PulseMulti: studioRow(6, true), SMStudioN5PulseMulti: studioRow(8, true),
};

for (const [name, row] of Object.entries(LDJ_ITERATION_ROWS)) {
  const step = row.step;
  row.step = (ctx) => { if (ctx.n > 0) step(ctx); };
  row.rapidFlash = row.cadence === 'wall:50' || row.cadence <= .25;
  registerKind(makeLdjKind(name, row));
}
