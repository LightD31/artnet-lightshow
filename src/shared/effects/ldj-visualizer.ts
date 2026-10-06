// Light DJ's Visualizer: every loud beat fires a matrix spike on one lamp, over
// a mellow Studio background that the music's sections start and stop. The two
// layers blend inside the effect by brightness, the one place Light DJ layers.
// Sections come from the shared SPL detector; this kind only reacts to them.

import { z } from 'zod';
import type { Colour } from '../../types/rig.ts';
import { HUE_PULSE_MS, huePulseLevel, tempoOf } from '../look-math.ts';
import type { Room } from '../room.ts';
import type { AudioFrame } from './audio-frame.ts';
import { hash01, pickNotLast } from './hash.ts';
import { LDJ_FRAME_MS, LdjLamps, roles } from './ldj-engine.ts';
import type { LdjEnvelope } from './ldj-engine.ts';
import { LDJ_PALETTES } from './ldj-palettes.ts';
import { advanceStudio, configureBackground, initStudio, readStudio, studioCommand } from './ldj-studio.ts';
import type { StudioState } from './ldj-studio.ts';
import { createPaletteAccess, preparePalette } from './palette.ts';
import type { PaletteAccess, PreparedPalette } from './palette.ts';
import { registerKind } from './registry.ts';
import type { EffectFrame, EffectSlot, PaletteEntry } from './types.ts';

export type VisualizerActive = 'splotch' | 'firework' | 'pulse' | 'flash' | 'mix';
export type VisualizerMellow = 'swirl' | 'wave' | 'solid' | 'none';
/** `trigger` is read by the shared SPL detector, which classifies beats for every instance. */
export interface VisualizerParams { active: VisualizerActive; mellow: VisualizerMellow; trigger: number; autoColours: boolean }
type SpikeMode = Exclude<VisualizerActive, 'mix'>;
type Section = 'loud' | 'soft' | 'quiet';

const f32 = Math.fround, BASELINE = f32(.05);
const BLACK: Colour = { r: 0, g: 0, b: 0, w: 0, a: 0, uv: 0 };
const EMITTERS = ['r', 'g', 'b', 'w', 'a', 'uv'] as const;
// A missing or zero tempo plays at 120 BPM, as in the other Light DJ kinds.
// A finished spike gives its lamp back over one second of 22 Hz frames.
const HANDOFF_FRAMES = 22;
const QUIET_BEATS = 16, SOFT_BEATS = 20;
const MIN_CHANGE_MS = 7500, FORCE_CHANGE_MS = 20000;
// One hash stream per random choice, so lamp, colour, type and length stay independent.
const COLOUR_STREAM = 73, HOLD_STREAM = 79, MIX_STREAM = 83, BED_STREAM = 89, LOUD_STREAM = 97, SOFT_STREAM = 101, ENTRY_STREAM = 103;
// Loud sections only take palettes of more than two colours.
const LOUD_ROWS = LDJ_PALETTES.flatMap((palette, i) => palette.colours.length > 2 ? [i] : []);
// Wave is re-sent every eight beats and the others every beat, as the app schedules them.
const period = (mellow: VisualizerMellow) => mellow === 'wave' ? 8 : 1;

export const VISUALIZER_DEFAULTS: VisualizerParams = { active: 'firework', mellow: 'swirl', trigger: .3, autoColours: false };

/** One preset per Light DJ visualizer mode: the four spike types over the swirl, the three backgrounds under fireworks. */
export const VISUALIZER_PRESETS: { id: string; name: string; params: VisualizerParams }[] = ([
  ['firework', 'Visualizer Firework', 'firework', 'swirl'], ['flash', 'Visualizer Flash', 'flash', 'swirl'],
  ['splotch', 'Visualizer Splotch', 'splotch', 'swirl'], ['pulse', 'Visualizer Pulse', 'pulse', 'swirl'],
  ['solid', 'Visualizer Solid', 'firework', 'solid'], ['swirl', 'Visualizer Swirl', 'firework', 'swirl'],
  ['wave', 'Visualizer Wave', 'firework', 'wave'],
] as const).map(([mode, name, active, mellow]) => ({ id: `ldj.visualizer.${mode}`, name, params: { ...VISUALIZER_DEFAULTS, active, mellow } }));

/** Mix's uniform draw: three tenths fireworks, three pulses, four flashes. */
export function mixSpike(draw: number): Exclude<SpikeMode, 'splotch'> {
  const bucket = Math.floor(draw * 10);
  return bucket < 3 ? 'firework' : bucket < 6 ? 'pulse' : 'flash';
}

function spikeEnvelope(mode: SpikeMode, hold: number): LdjEnvelope {
  if (mode === 'firework') return { kind: 'matrix', fadeIn: 0, peak: 150 + Math.floor(hold * 201), fadeOut: 2500, baseline: BASELINE };
  if (mode === 'flash') return { kind: 'matrix', fadeIn: 0, peak: 10, fadeOut: 100, baseline: BASELINE };
  if (mode === 'pulse') return { kind: 'matrix', fadeIn: 0, peak: 500, fadeOut: 0, baseline: BASELINE };
  return { kind: 'matrix', fadeIn: 0, peak: 10, fadeOut: 5000, baseline: BASELINE };
}

const renderByte = (value: number | undefined, level: number) =>
  Math.min(255, Math.max(0, Math.floor(f32(f32((value ?? 0) * level) + .5))));

/**
 * Light DJ's blend of two rendered colours: each is first scaled by its level
 * into bytes, weighted by its brightest emitter, then the weighted mean is
 * truncated, in 32-bit floats as the app computes it. W, A and UV count as
 * emitters too, so a white-only colour is not dropped for having no RGB.
 */
export function blendRendered(a: Colour, aLevel: number, b: Colour, bLevel: number): Colour {
  const x = EMITTERS.map((key) => renderByte(a[key], aLevel)), y = EMITTERS.map((key) => renderByte(b[key], bLevel));
  const wx = f32(Math.max(...x) / 255), wy = f32(Math.max(...y) / 255), sum = f32(wx + wy);
  // A dark side weighs nothing, so the other passes through as it is: the
  // float quotient c·w/w alone can truncate a dimmer channel one byte low.
  // Both dark is black, never 0/0.
  const lone = wx === 0 ? y : wy === 0 ? x : null;
  const mean = (i: number) => lone ? lone[i] : Math.trunc(f32(f32(f32(x[i] * wx) + f32(y[i] * wy)) / sum));
  return { r: mean(0), g: mean(1), b: mean(2), w: mean(3), a: mean(4), uv: mean(5) };
}

interface Handoff { from: Colour; to: Colour; tick: number }
/** A Pulse spike's last lit colour after its plateau, and the lamp frames since. */
interface HueTail { colour: Colour; tick: number }
interface QueuedSpike { slot: number; index: number; mode: SpikeMode; env: LdjEnvelope }
interface MellowState {
  /** The background loop runs: it is reasserted on its beats until a section stops it. */
  running: boolean; nextBeat: number | null;
  /** The drawn Swirl/Wave entry, kept until the mode or the palette's content changes. */
  cache: { mode: VisualizerMellow; list: string; index: number } | null; draws: number;
}
interface AutoState {
  on: boolean; allowAtMs: number; forceAtMs: number | null;
  /** The automatically chosen palette, between the override and the effect's own. */
  palette: PaletteEntry[] | null; prepared: PreparedPalette | null;
  lastLoud: number | null; lastSoft: number | null; draws: number; specKey: string;
}
export interface VisualizerState {
  bed: StudioState; lamps: LdjLamps;
  /** The spike layer per lamp: a live envelope, or the second that hands the lamp back. Untouched lamps have neither. */
  spikes: ({ mode: SpikeMode } | null)[]; handoffs: (Handoff | null)[]; queue: QueuedSpike[];
  /**
   * Hue lamps: a Pulse spike's hard cut softened as the strobe's Hue pulse.
   * Kept in flash mode too, so switching modes shows an existing tail and never starts one.
   */
  hueTails: (HueTail | null)[];
  events: number; lastRank: number | null;
  heard: { generation: number; t: number } | null;
  /** The detector's section as last heard, apart from the controller's own, which a quiet start promotes to soft. */
  observed: Section | null; section: Section; quiet: number; soft: number;
  mellow: MellowState; auto: AutoState;
  cursorMs: number | null; cursorBeat: number;
}

interface Ctx { s: VisualizerState; p: VisualizerParams; room: Room; f: EffectFrame; bpm: number; access: PaletteAccess }

// Hand-built frames carry no palette access: the resolved palette, uncached.
function fallbackAccess(palette: Colour[]): PaletteAccess {
  const { at } = roles(palette);
  return { palette: palette.length ? palette : [at(0)], colour: (index) => at(index), refresh: () => {}, frameColour: (index) => at(index) };
}

// Override, then the automatic palette, then the effect's own, then the look's.
function effectiveAccess(s: VisualizerState, f: EffectFrame): PaletteAccess {
  if (s.auto.palette && s.auto.prepared) {
    return createPaletteAccess({ ...f.spec, palette: s.auto.palette }, f.paletteOverride, f.lookPalette, f.seed, f.roll, s.auto.prepared);
  }
  return f.paletteAccess ?? fallbackAccess(f.palette);
}

// Content, not resolved hues: a random entry's refresh is not a new list.
function listKey(c: Ctx): string {
  const { s, f } = c;
  if (f.paletteOverride?.length) return `override:${JSON.stringify(f.paletteOverride)}`;
  if (s.auto.palette) return `auto:${JSON.stringify(s.auto.palette)}`;
  if (f.spec.palette?.length) return `spec:${JSON.stringify(f.spec.palette)}`;
  return `look:${JSON.stringify(f.lookPalette)}`;
}

// A new spike on a lamp replaces whatever that lamp was still showing,
// its own earlier spike or handoff included; other lamps keep their tails.
function install(c: Ctx, q: QueuedSpike): void {
  const { s } = c;
  s.lamps.set(q.slot, c.access.colour(q.index, q.slot), 1, q.env);
  s.spikes[q.slot] = { mode: q.mode };
  s.handoffs[q.slot] = null;
  s.hueTails[q.slot] = null;
}

// A spike at its baseline gives the lamp back. Pulse goes at once; the others
// hold the baseline while their colour turns to the bed's, then go. A stopped
// bed takes nothing back, and Mellow none is a black bed.
function endpoint(c: Ctx, slot: number, mode: SpikeMode): void {
  const { s } = c;
  // The colour as last lit, resolved this render, copied without its binding.
  const from = { ...BLACK, ...s.lamps.read(slot).colour };
  s.spikes[slot] = null;
  s.lamps.off(slot);
  // Pulse's plateau ends in a hard cut. A Hue lamp may take it as a 200 ms
  // pulse instead; the tail belongs to the spike, so a stopped bed keeps it.
  if (mode === 'pulse' && c.room.hue[slot]) s.hueTails[slot] = { colour: from, tick: 0 };
  if (mode === 'pulse' || s.bed.mode === 'stop') return;
  const to = s.bed.mode === 'none' ? { ...BLACK } : { ...BLACK, ...readStudio(s.bed, slot).colour };
  s.handoffs[slot] = { from, to, tick: 0 };
}

// One lamp frame of the spike layer, run on the bed's clock right after the
// bed's own frame, so a handoff starts from the bed colour of that frame.
function spikeFrame(c: Ctx): void {
  const { s } = c;
  s.handoffs.forEach((handoff, slot) => { if (handoff && ++handoff.tick >= HANDOFF_FRAMES) s.handoffs[slot] = null; });
  s.hueTails.forEach((tail, slot) => { if (tail && ++tail.tick * LDJ_FRAME_MS >= HUE_PULSE_MS) s.hueTails[slot] = null; });
  s.lamps.advance(LDJ_FRAME_MS, c.bpm);
  // Every envelope rises at once and falls (or snaps) exactly onto the baseline, so reaching it is the end.
  s.spikes.forEach((spike, slot) => { if (spike && s.lamps.read(slot).bri === BASELINE) endpoint(c, slot, spike.mode); });
  // A spike asked for between frames shows its first frame at this boundary.
  const queued = s.queue.splice(0);
  for (const q of queued) install(c, q);
}

function advanceTo(c: Ctx, t: number): void {
  advanceStudio(c.s.bed, Math.max(t, c.s.bed.lastMs), c.bpm, undefined, () => spikeFrame(c));
}

function spike(c: Ctx): void {
  const { s, p, f, room } = c;
  // An empty room has no lamp to pick, and draws nothing.
  if (!room.n) return;
  const event = s.events++;
  const rank = pickNotLast(f.seed, event, room.n, s.lastRank);
  s.lastRank = rank;
  const slot = s.bed.ring[rank];
  const mode: SpikeMode = p.active === 'mix' ? mixSpike(hash01(f.seed, MIX_STREAM, event)) : p.active;
  const q: QueuedSpike = { slot, index: Math.floor(hash01(f.seed, COLOUR_STREAM, event) * c.access.palette.length), mode,
    env: spikeEnvelope(mode, hash01(f.seed, HOLD_STREAM, event)) };
  // The app redraws the chosen lamp's random colour per spike; ours shows from the next render.
  c.access.refresh(slot);
  if (s.bed.remainderMs > 1e-8) s.queue.push(q);
  else install(c, q);
}

function reassert(c: Ctx): void {
  const { s, p, f, room } = c;
  if (p.mellow === 'none') {
    // The app plays none as a black background, so a later swirl or wave draws afresh.
    s.mellow.cache = { mode: 'none', list: '', index: 0 };
    configureBackground(s.bed, 'none', BLACK);
    return;
  }
  const list = listKey(c), cache = s.mellow.cache;
  if (!cache || cache.mode !== p.mellow || cache.list !== list) {
    s.mellow.cache = { mode: p.mellow, list, index: Math.floor(hash01(f.seed, BED_STREAM, s.mellow.draws++) * c.access.palette.length) };
  }
  // The bed's cache key lies past every lamp's, so a spike's colour refresh never recolours it.
  const index = p.mellow === 'solid' ? 0 : s.mellow.cache!.index;
  configureBackground(s.bed, p.mellow, c.access.colour(index, room.n));
}

function startBed(c: Ctx, beat: number): void {
  c.s.mellow.running = true;
  reassert(c);
  c.s.mellow.nextBeat = beat + period(c.p.mellow);
}

// Stopping cancels the beat loop too; a Studio stop command alone does not,
// so the next scheduled reassertion brings the background back.
function stopBed(c: Ctx): void {
  const { s } = c;
  s.mellow.running = false;
  s.mellow.nextBeat = null;
  studioCommand(s.bed, 'stop');
  s.handoffs.fill(null);
}

// Loud sections take a palette of more than two colours, soft ones a single
// colour drawn from a palette; neither repeats its own last pick.
function changeColours(c: Ctx, kind: 'loud' | 'soft', t: number): void {
  const { s, f } = c, a = s.auto;
  if (!a.on || t < a.allowAtMs) return;
  const event = a.draws++;
  let entries: readonly PaletteEntry[];
  if (kind === 'loud') {
    a.lastLoud = pickNotLast(f.seed, event, LOUD_ROWS.length, a.lastLoud, LOUD_STREAM);
    entries = LDJ_PALETTES[LOUD_ROWS[a.lastLoud]].colours;
  } else {
    a.lastSoft = pickNotLast(f.seed, event, LDJ_PALETTES.length, a.lastSoft, SOFT_STREAM);
    const colours = LDJ_PALETTES[a.lastSoft].colours;
    entries = [colours[Math.floor(hash01(f.seed, ENTRY_STREAM, event) * colours.length)]];
  }
  // Copies, so instance state never holds the frozen seed objects.
  a.palette = entries.map((entry) => typeof entry === 'string' ? entry : { random: true as const });
  a.prepared = preparePalette({ palette: a.palette });
  a.allowAtMs = t + MIN_CHANGE_MS;
  a.forceAtMs = t + FORCE_CHANGE_MS;
  c.access = effectiveAccess(s, f);
}

function applySection(c: Ctx, section: Section, now: number): void {
  const { s } = c;
  if (section === 'loud') {
    s.section = 'loud';
    stopBed(c);
    changeColours(c, 'loud', now);
  } else if (section === 'soft') {
    if (s.section === 'loud') changeColours(c, 'soft', now);
    s.section = 'soft';
  } else {
    s.quiet = 0;
    if (s.mellow.running) { stopBed(c); changeColours(c, 'soft', now); }
    s.section = 'quiet';
  }
}

// The counters are not consecutive: a loud beat clears the soft count, only a
// quiet section clears the quiet count.
function applyBeat(c: Ctx, beat: Section, now: number, beatPos: number): void {
  const { s } = c;
  if (beat === 'loud') {
    s.soft = 0;
    spike(c);
  } else if (beat === 'quiet' && s.section === 'quiet') {
    if (++s.quiet >= QUIET_BEATS && !s.mellow.running) { s.section = 'soft'; startBed(c, beatPos); }
  } else if (beat === 'soft' && s.section === 'soft') {
    if (++s.soft >= SOFT_BEATS && !s.mellow.running) { changeColours(c, 'soft', now); startBed(c, beatPos); }
  }
}

const isSection = (value: unknown): value is Section => value === 'loud' || value === 'soft' || value === 'quiet';

// Every valid event is remembered in every audio mode, so one held across a
// switch to reactive is not news; only reactive mode acts on news.
function hear(s: VisualizerState, f: EffectFrame): AudioFrame | null {
  const audio = f.audio;
  if (!audio) return null;
  const eventT = audio.spl?.eventT;
  const t = Number.isFinite(eventT) ? eventT! : audio.t;
  if (!Number.isFinite(t)) return null;
  const generation = Number.isFinite(audio.generation) ? audio.generation! : 0;
  const fresh = !s.heard || s.heard.t !== t || s.heard.generation !== generation;
  s.heard = { generation, t };
  return fresh && f.audioMode === 'reactive' ? audio : null;
}

function handoffSample(handoff: Handoff): { colour: Colour; bri: number } {
  const t = handoff.tick / HANDOFF_FRAMES;
  const mix = (key: keyof Colour) => Math.round((handoff.from[key] ?? 0) * (1 - t) + (handoff.to[key] ?? 0) * t);
  return { colour: { r: mix('r'), g: mix('g'), b: mix('b'), w: mix('w'), a: mix('a'), uv: mix('uv') }, bri: BASELINE };
}

// The tail's wall time is whole lamp frames plus the bed's remainder. Rounded
// to a nanosecond so float steps never tip a level across its rounding edge.
function hueTailSample(s: VisualizerState, slot: number): { colour: Colour; bri: number } | null {
  const tail = s.hueTails[slot];
  if (!tail) return null;
  const sinceMs = Math.round((tail.tick * LDJ_FRAME_MS + s.bed.remainderMs) * 1e6) / 1e6;
  if (sinceMs >= HUE_PULSE_MS) { s.hueTails[slot] = null; return null; }
  return { colour: tail.colour, bri: huePulseLevel(sinceMs) / 255 };
}

// Strict, like the other Light DJ kinds: an unknown field is an error, not silently dropped.
const paramsSchema = z.object({
  active: z.enum(['splotch', 'firework', 'pulse', 'flash', 'mix']),
  mellow: z.enum(['swirl', 'wave', 'solid', 'none']),
  trigger: z.number().min(0).max(1),
  autoColours: z.boolean(),
}).strict();

// Spikes can land on every loud beat, ten times a second: a rapid flash, like the matrix pulses.
registerKind<VisualizerParams, VisualizerState>({
  kind: 'ldj.visualizer', app: 'ldj', schema: paramsSchema, defaults: { params: { ...VISUALIZER_DEFAULTS } },
  stateful: true, rapidFlash: true,
  command(state, cmd, arg) {
    studioCommand(state.bed, cmd, arg);
    if (cmd === 'stop') state.handoffs.fill(null);
  },
  init(params, room, frame) {
    const origin = frame.startedAtMs ?? frame.nowMs;
    const bed = initStudio(room, frame.seed, BLACK, origin);
    // Dark until started: reactive audio waits for its sections before any background.
    studioCommand(bed, 'stop');
    for (const lamp of bed.lamps) lamp.bri = 0;
    return {
      bed, lamps: new LdjLamps(room.n), spikes: Array(room.n).fill(null), handoffs: Array(room.n).fill(null), queue: [],
      hueTails: Array(room.n).fill(null),
      // The app starts its controller in a soft section, with both colour timers armed at launch.
      events: 0, lastRank: null, heard: null, observed: null, section: 'soft', quiet: 0, soft: 0,
      mellow: { running: false, nextBeat: null, cache: null, draws: 0 },
      auto: { on: params.autoColours, allowAtMs: origin + MIN_CHANGE_MS, forceAtMs: params.autoColours ? origin + FORCE_CHANGE_MS : null,
        palette: null, prepared: null, lastLoud: null, lastSoft: null, draws: 0, specKey: JSON.stringify(frame.spec.palette ?? null) },
      cursorMs: null, cursorBeat: 0,
    };
  },
  render(params, s, room, f, out: EffectSlot[]) {
    if (!Number.isFinite(f.nowMs)) throw new RangeError('Light DJ clock time must be finite');
    if (!Number.isFinite(f.beatPos)) throw new RangeError('Light DJ beat position must be finite');
    const now = f.nowMs, beat = f.beatPos, bpm = tempoOf(f.bpm), a = s.auto, m = s.mellow;
    const first = s.cursorMs === null;
    // A late first render still starts the clocks at launch, back-projecting its beat at the current tempo.
    if (first) { s.cursorMs = s.bed.lastMs; s.cursorBeat = beat - Math.max(0, now - s.bed.lastMs) * bpm / 60000; }
    // Switching automatic colours on arms a fresh forced change; off, or an
    // edited palette, drops the automatic one.
    if (params.autoColours !== a.on) {
      a.on = params.autoColours;
      a.forceAtMs = a.on ? now + FORCE_CHANGE_MS : null;
      if (!a.on) { a.palette = null; a.prepared = null; }
    }
    const specKey = JSON.stringify(f.spec.palette ?? null);
    if (specKey !== a.specKey) { a.specKey = specKey; a.palette = null; a.prepared = null; }
    const c: Ctx = { s, p: params, room, f, bpm, access: effectiveAccess(s, f) };
    // Live colours resolve once per render, before anything advances.
    s.lamps.resolveColours(c.access);
    advanceStudio(s.bed, s.bed.lastMs, bpm, c.access);
    // Off, tempo and a missing frame alike mean no live music: the background plays alone.
    const live = f.audioMode === 'reactive' && f.audio !== null && Number.isFinite(f.audio.t);
    if (first && !live) startBed(c, s.cursorBeat);
    // A beat position that went back would leave the next reassertion far ahead.
    if (m.nextBeat !== null && m.nextBeat - beat > 8) m.nextBeat = beat + period(params.mellow);
    const cursorMs = s.cursorMs!, cursorBeat = s.cursorBeat;
    // A beat between two renders falls at its share of the gap, as the step engines place theirs.
    const beatTime = (b: number) => beat > cursorBeat
      ? cursorMs + Math.min(1, Math.max(0, (b - cursorBeat) / (beat - cursorBeat))) * (now - cursorMs) : cursorMs;
    // Background beats and colour timers between the last render and this one, in time order.
    for (;;) {
      const bedDue = m.running && m.nextBeat !== null && m.nextBeat <= beat ? beatTime(m.nextBeat) : Infinity;
      const forceDue = a.forceAtMs !== null && a.forceAtMs <= now ? a.forceAtMs : Infinity;
      if (bedDue === Infinity && forceDue === Infinity) break;
      if (forceDue <= bedDue) {
        advanceTo(c, forceDue);
        changeColours(c, s.section === 'loud' ? 'loud' : 'soft', forceDue);
        // An accepted change already re-armed it; this keeps the loop finite
        // should a forced change ever be refused, as the app re-arms it anyway.
        a.forceAtMs = forceDue + FORCE_CHANGE_MS;
      } else {
        advanceTo(c, bedDue);
        reassert(c);
        m.nextBeat! += period(params.mellow);
      }
    }
    advanceTo(c, now);
    // An edited background takes over now and starts its own period, rather
    // than waiting out the old one's schedule (up to eight beats of Wave).
    if (m.running && m.cache && m.cache.mode !== params.mellow) startBed(c, beat);
    const heard = hear(s, f);
    if (!live) {
      // No live music: the background plays alone, started once. Only a bed
      // that a loud section had stopped forgets that section, so the same
      // loud section heard on return stops it again. Any other section heard
      // again is no news: a quiet passage keeps its bed and its count.
      if (!m.running) {
        if (s.observed === 'loud') s.observed = null;
        startBed(c, beat);
      }
    } else if (heard) {
      // The section changes before the beat of the same event, as the app sends them.
      const section = isSection(heard.spl?.section) ? heard.spl.section : null;
      if (section !== s.observed) { s.observed = section; if (section) applySection(c, section, now); }
      if (isSection(heard.spl?.beat)) applyBeat(c, heard.spl.beat, now, beat);
    }
    const hueTails = f.hueStrobe === 'pulse';
    for (let i = 0; i < room.n; i++) {
      const bed = readStudio(s.bed, i), handoff = s.handoffs[i];
      // At most one layer is on top: a new spike clears its lamp's handoff and
      // tail, and a Pulse spike ends with no handoff.
      const top = s.spikes[i] ? s.lamps.read(i) : handoff ? handoffSample(handoff)
        : hueTails && room.hue[i] ? hueTailSample(s, i) : null;
      // The blend is in rendered bytes, so its level is already inside the colour.
      out[i] = top ? { colour: blendRendered(bed.colour, bed.bri, top.colour, top.bri), level: 1, strength: 1 }
        : { colour: { ...BLACK, ...bed.colour }, level: bed.bri, strength: 1 };
    }
    s.cursorMs = now;
    s.cursorBeat = beat;
  },
});
